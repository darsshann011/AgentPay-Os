/**
 * ============================================================================
 * AgentPay OS - Mandate Service (Agent Trust Rail)
 * ============================================================================
 * ARCHITECTURAL BOUNDARY:
 * This module is responsible for verifying cryptographic WebAuthn assertions,
 * issuing programmatic trust mandates for autonomous AI agents, and verifying
 * proposed transactions against active mandates before payment execution.
 *
 * CRITICAL SECURITY CONSTRAINTS:
 * 1. The server NEVER holds or generates WebAuthn private keys.
 *    Only public keys are stored for verification.
 * 2. Signatures are verified using @simplewebauthn/server.
 * 3. Mandates are issued with single-use cryptographic nonces and strict expiry.
 * 4. This service is strictly separated from policyEngine and razorpayService.
 * ============================================================================
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
  verifyAuthenticationResponse,
  generateAuthenticationOptions
} = require('@simplewebauthn/server');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');

const {
  getAgent,
  createMandate,
  getMandate,
  getMandateByNonce,
  updateMandate,
  listMandates,
  addAuditLog,
  consumeMandateNonceAtomic
} = require('../db/supabaseClient');
const { formatDenial } = require('../utils/denialResponse');

const RP_NAME = process.env.RP_NAME || 'AgentPay OS Trust Rail';
const RP_ID = process.env.RP_ID || 'localhost';
const RP_ORIGIN = process.env.RP_ORIGIN || 'http://localhost:3000';

// In-memory challenge cache for WebAuthn authentication flow
const challengeStore = new Map();

// In-memory verified tokens cache (short-lived, 2-minute TTL)
const verifiedTokens = new Map();

/**
 * Generates WebAuthn authentication options with a secure challenge
 * @param {Object} [options]
 * @returns {Promise<{ challenge: string, rpId: string, timeout: number }>}
 */
async function generateMandateChallenge(options = {}) {
  const rpId = options.rpID || RP_ID;
  const authOptions = await generateAuthenticationOptions({
    rpID: rpId,
    timeout: 60000,
    userVerification: 'preferred'
  });

  const challenge = authOptions.challenge;
  challengeStore.set(challenge, {
    challenge,
    createdAt: Date.now()
  });

  // Expire challenges after 5 minutes
  setTimeout(() => {
    challengeStore.delete(challenge);
  }, 5 * 60 * 1000);

  return authOptions;
}

/**
 * Converts a public key input (Base64URL, hex, Uint8Array, Buffer) to a Uint8Array
 * @param {string|Buffer|Uint8Array} pubKey
 * @returns {Uint8Array}
 */
function normalizePublicKeyToUint8Array(pubKey) {
  if (!pubKey) {
    throw new Error('WebAuthn public key is required for verification');
  }

  if (pubKey instanceof Uint8Array || Buffer.isBuffer(pubKey)) {
    return new Uint8Array(pubKey);
  }

  if (typeof pubKey === 'string') {
    const trimmed = pubKey.trim();
    // If base64url or standard base64
    if (isoBase64URL.isBase64URL(trimmed) || /^[A-Za-z0-9_-]+$/.test(trimmed)) {
      return new Uint8Array(isoBase64URL.toBuffer(trimmed));
    }
    // If hex encoded
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      return new Uint8Array(Buffer.from(trimmed, 'hex'));
    }
    return new Uint8Array(Buffer.from(trimmed, 'base64'));
  }

  throw new Error('Unsupported WebAuthn public key format');
}

/**
 * Normalizes incoming webauthn_assertion payload to AuthenticationResponseJSON
 * @param {Object} assertion
 * @returns {Object} AuthenticationResponseJSON
 */
function normalizeAssertionResponse(assertion) {
  if (!assertion || typeof assertion !== 'object') {
    throw new Error('webauthn_assertion must be a valid WebAuthn assertion object');
  }

  // If already in standard SimpleWebAuthn AuthenticationResponseJSON format
  if (assertion.response && assertion.response.clientDataJSON && assertion.response.authenticatorData && assertion.response.signature) {
    return {
      id: assertion.id || assertion.rawId || 'credential_id',
      rawId: assertion.rawId || assertion.id || 'credential_id',
      type: assertion.type || 'public-key',
      response: {
        clientDataJSON: assertion.response.clientDataJSON,
        authenticatorData: assertion.response.authenticatorData,
        signature: assertion.response.signature,
        userHandle: assertion.response.userHandle || ''
      },
      clientExtensionResults: assertion.clientExtensionResults || {}
    };
  }

  // If flat format
  if (assertion.clientDataJSON && assertion.authenticatorData && assertion.signature) {
    const credId = assertion.id || assertion.credential_id || assertion.rawId || 'credential_id';
    return {
      id: credId,
      rawId: credId,
      type: assertion.type || 'public-key',
      response: {
        clientDataJSON: assertion.clientDataJSON,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
        userHandle: assertion.userHandle || ''
      },
      clientExtensionResults: assertion.clientExtensionResults || {}
    };
  }

  throw new Error('webauthn_assertion is missing required WebAuthn fields (clientDataJSON, authenticatorData, signature)');
}

/**
 * Extracts challenge from clientDataJSON
 * @param {string} clientDataJSONBase64
 * @returns {string}
 */
function extractChallengeFromClientData(clientDataJSONBase64) {
  try {
    const jsonStr = isoBase64URL.toUTF8String(clientDataJSONBase64);
    const parsed = JSON.parse(jsonStr);
    return parsed.challenge;
  } catch (err) {
    return null;
  }
}

/**
 * Extracts origin from clientDataJSON
 * @param {string} clientDataJSONBase64
 * @returns {string}
 */
function extractOriginFromClientData(clientDataJSONBase64) {
  try {
    const jsonStr = isoBase64URL.toUTF8String(clientDataJSONBase64);
    const parsed = JSON.parse(jsonStr);
    return parsed.origin;
  } catch (err) {
    return null;
  }
}

/**
 * Verifies the integrity and format of stored WebAuthn public key and signature
 * @param {Object} mandate
 * @returns {boolean}
 */
function verifyStoredWebAuthnSignature(mandate) {
  if (!mandate) return false;
  const signatureBase64 = mandate.webauthn_signature;
  const publicKeyBase64 = mandate.webauthn_public_key;

  if (!signatureBase64 || !publicKeyBase64) return false;

  try {
    const sigBuf = isoBase64URL.toBuffer(signatureBase64);
    const pubBuf = isoBase64URL.toBuffer(publicKeyBase64);

    // 1. Verify Public Key is valid COSE CBOR Map
    const coseMap = isoCBOR.decodeFirst(pubBuf);
    if (!coseMap || !(coseMap instanceof Map)) return false;
    if (!coseMap.has(1)) return false; // Must specify key type (kty)

    // 2. Verify ASN.1 DER Sequence for ECDSA signature
    if (sigBuf.length < 8 || sigBuf[0] !== 0x30) return false;

    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Issues a new mandate after cryptographic WebAuthn assertion verification
 *
 * @param {Object} params
 * @param {string} params.agent_id - Target agent UUID
 * @param {number} params.max_amount - Maximum permissible transaction amount (INR)
 * @param {string} params.merchant_category - Merchant category (e.g. 'HOTEL', 'TRAVEL', 'FLIGHT')
 * @param {number} [params.expiry_minutes=60] - Validity duration in minutes
 * @param {Object} params.webauthn_assertion - Client-generated WebAuthn assertion response
 * @param {string} [params.webauthn_public_key] - Associated WebAuthn public key (Base64URL/Hex)
 * @param {string} [params.expected_challenge] - Expected challenge string
 * @param {string} [params.expected_origin] - Expected origin URL
 * @param {string} [params.expected_rp_id] - Expected RP ID
 * @returns {Promise<{ mandate_id: string, status: string, max_amount: number, merchant_category: string, nonce: string, expires_at: string, issued_at: string }>}
 */
async function issueMandate(params) {
  const {
    agent_id,
    max_amount: rawAmount,
    merchant_category,
    expiry_minutes = 60,
    webauthn_assertion,
    webauthn_public_key: rawPublicKey,
    expected_challenge: explicitChallenge,
    expected_origin: explicitOrigin,
    expected_rp_id: explicitRpId
  } = params || {};

  // 1. Validate max_amount
  const max_amount = Number(rawAmount);
  if (isNaN(max_amount) || !isFinite(max_amount) || max_amount <= 0) {
    const err = new Error(`INVALID_MAX_AMOUNT: max_amount must be a positive number greater than 0. Received: '${rawAmount}'`);
    err.code = 'INVALID_MAX_AMOUNT';
    err.status = 400;
    throw err;
  }

  // 2. Validate merchant_category
  if (!merchant_category || typeof merchant_category !== 'string' || merchant_category.trim().length === 0) {
    const err = new Error('MISSING_MERCHANT_CATEGORY: merchant_category is required and must be a non-empty string');
    err.code = 'MISSING_MERCHANT_CATEGORY';
    err.status = 400;
    throw err;
  }

  // 3. Validate expiry_minutes
  const expiryMinutes = Number(expiry_minutes);
  if (isNaN(expiryMinutes) || !isFinite(expiryMinutes) || expiryMinutes <= 0) {
    const err = new Error(`INVALID_EXPIRY: expiry_minutes must be a positive integer. Received: '${expiry_minutes}'`);
    err.code = 'INVALID_EXPIRY';
    err.status = 400;
    throw err;
  }

  // 4. Validate Agent existence
  const agent = await getAgent(agent_id);
  if (!agent) {
    const err = new Error(`AGENT_NOT_FOUND: Agent with ID '${agent_id}' does not exist in database`);
    err.code = 'AGENT_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  // 5. Validate and normalize WebAuthn Assertion
  const normalizedAssertion = normalizeAssertionResponse(webauthn_assertion);

  // Extract public key
  const publicKeyStr = rawPublicKey ||
    webauthn_assertion.public_key ||
    webauthn_assertion.webauthn_public_key ||
    webauthn_assertion.publicKey;

  if (!publicKeyStr) {
    const err = new Error('MISSING_PUBLIC_KEY: webauthn_public_key must be provided for cryptographic verification');
    err.code = 'MISSING_PUBLIC_KEY';
    err.status = 400;
    throw err;
  }

  const publicKeyBytes = normalizePublicKeyToUint8Array(publicKeyStr);
  const credentialId = normalizedAssertion.id;

  // Determine verification parameters
  const clientChallenge = extractChallengeFromClientData(normalizedAssertion.response.clientDataJSON);
  const expectedChallenge = explicitChallenge || clientChallenge;

  if (!expectedChallenge) {
    const err = new Error('INVALID_CHALLENGE: Challenge could not be resolved from WebAuthn assertion');
    err.code = 'INVALID_CHALLENGE';
    err.status = 400;
    throw err;
  }

  const clientOrigin = extractOriginFromClientData(normalizedAssertion.response.clientDataJSON);
  const expectedOrigin = explicitOrigin || clientOrigin || RP_ORIGIN;
  const expectedRPID = explicitRpId || RP_ID;

  // 6. Cryptographic WebAuthn Verification using @simplewebauthn/server
  let verification = null;
  try {
    verification = await verifyAuthenticationResponse({
      response: normalizedAssertion,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      credential: {
        id: credentialId,
        publicKey: publicKeyBytes,
        counter: webauthn_assertion.counter !== undefined ? Number(webauthn_assertion.counter) : 0
      },
      requireUserVerification: false // Support standard authenticators
    });
  } catch (verifyErr) {
    console.error('[Mandate Service] ❌ WebAuthn signature verification failed:', verifyErr.message);
    const err = new Error(`WEBAUTHN_VERIFICATION_FAILED: ${verifyErr.message}`);
    err.code = 'WEBAUTHN_VERIFICATION_FAILED';
    err.status = 400;
    throw err;
  }

  if (!verification || !verification.verified) {
    const err = new Error('WEBAUTHN_VERIFICATION_FAILED: WebAuthn signature could not be verified against the provided public key');
    err.code = 'WEBAUTHN_VERIFICATION_FAILED';
    err.status = 400;
    throw err;
  }

  // 7. Generate Single-Use Nonce & Expiry
  const nonce = `nonce_${crypto.randomBytes(16).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000).toISOString();
  const issuedAt = now.toISOString();

  // Public key storage format (Base64URL string)
  const storedPublicKey = typeof publicKeyStr === 'string'
    ? publicKeyStr
    : isoBase64URL.fromBuffer(publicKeyBytes);

  const storedSignature = normalizedAssertion.response.signature;

  // 8. Insert Mandate Record into Database
  const mandateRecord = await createMandate({
    agent_id: agent.id,
    max_amount,
    merchant_category: merchant_category.trim(),
    nonce,
    nonce_used: false,
    webauthn_credential_id: credentialId,
    webauthn_signature: storedSignature,
    webauthn_public_key: storedPublicKey,
    issued_at: issuedAt,
    expires_at: expiresAt,
    status: 'ACTIVE'
  });

  // 9. Log Audit Event MANDATE_ISSUED
  await addAuditLog(null, 'MANDATE_ISSUED', {
    mandate_id: mandateRecord.mandate_id,
    agent_id: agent.id,
    agent_name: agent.name,
    max_amount,
    merchant_category: mandateRecord.merchant_category,
    nonce: mandateRecord.nonce,
    expires_at: mandateRecord.expires_at,
    webauthn_credential_id: credentialId,
    authenticator_info: verification.authenticationInfo
  });

  console.log(`[Mandate Service] 📜 Issued Mandate '${mandateRecord.mandate_id}' for Agent '${agent.name}' (Max: ₹${max_amount}, Cat: '${merchant_category}', Nonce: '${nonce}')`);

  return {
    mandate_id: mandateRecord.mandate_id,
    status: 'ACTIVE',
    agent_id: agent.id,
    max_amount: mandateRecord.max_amount,
    merchant_category: mandateRecord.merchant_category,
    nonce: mandateRecord.nonce,
    issued_at: mandateRecord.issued_at,
    expires_at: mandateRecord.expires_at
  };
}

/**
 * Verifies a proposed transaction against an issued mandate
 * Runs sequential checks in order and stops at the first failure.
 *
 * @param {string} mandateId
 * @param {Object} proposedTransaction - { amount: number, merchant: string, category: string }
 * @returns {Promise<{ valid: boolean, decision: string, stage?: string, reason_code?: string, explanation?: string, suggested_fix?: string, mandate_id: string, timestamp?: string, mandate?: Object, proposed_transaction?: Object }>}
 */
async function verifyMandate(mandateId, proposedTransaction = {}) {
  const timestamp = new Date().toISOString();
  const amount = Number(proposedTransaction?.amount);
  const category = (proposedTransaction?.category || '').trim();
  const merchant = (proposedTransaction?.merchant || '').trim();

  // Check a: Fetch the mandate by mandate_id
  const mandate = await getMandate(mandateId);
  if (!mandate) {
    return {
      valid: false,
      ...formatDenial(
        'MANDATE_VERIFICATION',
        'MANDATE_NOT_FOUND',
        `Mandate with ID '${mandateId}' was not found in database`,
        'Provide a valid mandate_id issued via POST /api/mandates/issue',
        { mandate_id: mandateId, timestamp }
      )
    };
  }

  // Check b: Verify stored WebAuthn signature against stored public key
  const isSignatureValid = verifyStoredWebAuthnSignature(mandate);
  if (!isSignatureValid) {
    return {
      valid: false,
      ...formatDenial(
        'MANDATE_VERIFICATION',
        'SIGNATURE_INVALID',
        'Stored WebAuthn cryptographic signature validation failed or integrity check compromised',
        'Re-authenticate with hardware WebAuthn authenticator to generate a valid cryptographic assertion',
        { mandate_id: mandateId, timestamp }
      )
    };
  }

  // Check c: Check proposed_transaction.amount <= mandate.max_amount
  if (isNaN(amount) || amount <= 0 || amount > Number(mandate.max_amount)) {
    return {
      valid: false,
      ...formatDenial(
        'MANDATE_VERIFICATION',
        'AMOUNT_EXCEEDS_MANDATE',
        `Proposed transaction amount ₹${amount} exceeds authorized mandate maximum of ₹${mandate.max_amount}`,
        `Issue a new mandate with a higher max_amount or reduce the transaction amount to <= ₹${mandate.max_amount}`,
        { mandate_id: mandateId, timestamp }
      )
    };
  }

  // Check d: Check proposed_transaction.category matches mandate.merchant_category
  if (!category || category.toLowerCase() !== (mandate.merchant_category || '').toLowerCase()) {
    return {
      valid: false,
      ...formatDenial(
        'MANDATE_VERIFICATION',
        'MERCHANT_CATEGORY_MISMATCH',
        `Proposed merchant category '${category}' does not match authorized category '${mandate.merchant_category}'`,
        `Issue a mandate authorized for '${category}' or adjust the purchase category`,
        { mandate_id: mandateId, timestamp }
      )
    };
  }

  // Check e: Check mandate.expires_at has not passed
  if (new Date(mandate.expires_at).getTime() <= Date.now()) {
    return {
      valid: false,
      ...formatDenial(
        'MANDATE_VERIFICATION',
        'MANDATE_EXPIRED',
        `Mandate expired at ${mandate.expires_at}. Current time is ${timestamp}`,
        'Issue a fresh mandate with updated expiry window',
        { mandate_id: mandateId, timestamp }
      )
    };
  }

  // Check f: Check mandate.nonce_used is FALSE (replay check)
  if (mandate.nonce_used === true) {
    return {
      valid: false,
      ...formatDenial(
        'MANDATE_VERIFICATION',
        'NONCE_ALREADY_USED',
        'The single-use nonce for this mandate has already been consumed or replayed',
        'Issue a new mandate with a fresh cryptographic nonce to prevent replay attacks',
        { mandate_id: mandateId, timestamp }
      )
    };
  }

  // Check g: All checks passed
  return {
    valid: true,
    decision: 'VERIFIED',
    mandate_id: mandateId,
    mandate,
    proposed_transaction: {
      amount,
      merchant,
      category
    }
  };
}

/**
 * Creates a short-lived verified token tied to a validated mandate & proposed transaction
 * @param {Object} params
 * @param {string} params.mandate_id
 * @param {Object} params.proposed_transaction
 * @param {number} [params.ttlSeconds=120] - 2 minutes default
 * @returns {Object}
 */
function createVerifiedToken({ mandate_id, proposed_transaction, ttlSeconds = 120 }) {
  const token = `vt_${crypto.randomBytes(24).toString('hex')}`;
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();

  const tokenRecord = {
    token,
    mandate_id,
    amount: Number(proposed_transaction.amount),
    merchant: proposed_transaction.merchant || '',
    category: proposed_transaction.category || '',
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    expires_in_seconds: ttlSeconds,
    consumed: false
  };

  verifiedTokens.set(token, tokenRecord);

  // Auto clean up after expiry window
  setTimeout(() => {
    verifiedTokens.delete(token);
  }, (ttlSeconds + 60) * 1000);

  return tokenRecord;
}

/**
 * Retrieves a verified token if present and not expired
 * @param {string} token
 * @returns {Object|null}
 */
function getVerifiedToken(token) {
  if (!token) return null;
  const record = verifiedTokens.get(token);
  if (!record) return null;
  if (new Date(record.expires_at).getTime() < Date.now()) {
    verifiedTokens.delete(token);
    return null;
  }
  return record;
}

/**
 * Marks a verified token as consumed
 * @param {string} token
 * @returns {boolean}
 */
function consumeVerifiedToken(token) {
  const record = getVerifiedToken(token);
  if (!record || record.consumed) return false;
  record.consumed = true;
  return true;
}

module.exports = {
  issueMandate,
  verifyMandate,
  createVerifiedToken,
  getVerifiedToken,
  consumeVerifiedToken,
  generateMandateChallenge,
  normalizePublicKeyToUint8Array,
  normalizeAssertionResponse,
  getMandate,
  getMandateByNonce,
  updateMandate,
  listMandates,
  consumeMandateNonceAtomic
};
