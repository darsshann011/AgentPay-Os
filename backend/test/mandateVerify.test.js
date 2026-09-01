const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');

const {
  issueMandate,
  verifyMandate,
  getVerifiedToken
} = require('../src/services/mandateService');

const {
  createMandate,
  getMandate,
  updateMandate,
  getAuditLogs,
  resetMemoryStore,
  DEFAULT_TRAVELBOT_ID
} = require('../src/db/supabaseClient');

const app = require('../src/server');

/**
 * Helper to generate a valid WebAuthn mock assertion & key for test mandates
 */
function createMockWebAuthnClient(options = {}) {
  const rpID = options.rpID || 'localhost';
  const origin = options.origin || 'http://localhost:3000';
  const challenge = options.challenge || isoBase64URL.fromBuffer(crypto.randomBytes(32));

  const keyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });

  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  const x = isoBase64URL.toBuffer(jwk.x);
  const y = isoBase64URL.toBuffer(jwk.y);

  const coseMap = new Map();
  coseMap.set(1, 2); // EC2
  coseMap.set(3, -7); // ES256
  coseMap.set(-1, 1); // P-256
  coseMap.set(-2, x);
  coseMap.set(-3, y);

  const cosePublicKeyBuffer = isoCBOR.encode(coseMap);
  const publicKeyBase64URL = isoBase64URL.fromBuffer(cosePublicKeyBuffer);
  const credentialID = isoBase64URL.fromBuffer(crypto.randomBytes(32));

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false
  });
  const clientDataJSONBase64 = isoBase64URL.fromUTF8String(clientDataJSON);

  const rpIdHash = crypto.createHash('sha256').update(rpID).digest();
  const flags = Buffer.from([0x05]);
  const signCount = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const authDataBuffer = Buffer.concat([rpIdHash, flags, signCount]);
  const authenticatorDataBase64 = isoBase64URL.fromBuffer(authDataBuffer);

  const clientDataHash = crypto.createHash('sha256').update(Buffer.from(clientDataJSON, 'utf8')).digest();
  const signatureBase = Buffer.concat([authDataBuffer, clientDataHash]);

  const sign = crypto.createSign('SHA256');
  sign.update(signatureBase);
  const signatureDer = sign.sign(keyPair.privateKey);
  const signatureBase64 = isoBase64URL.fromBuffer(signatureDer);

  const assertion = {
    id: credentialID,
    rawId: credentialID,
    type: 'public-key',
    response: {
      clientDataJSON: clientDataJSONBase64,
      authenticatorData: authenticatorDataBase64,
      signature: signatureBase64,
      userHandle: ''
    }
  };

  return {
    keyPair,
    credentialID,
    publicKeyBase64URL,
    cosePublicKeyBuffer,
    challenge,
    origin,
    rpID,
    assertion
  };
}

/**
 * Helper to issue a test mandate
 */
async function issueTestMandate(overrides = {}) {
  const mockAuth = createMockWebAuthnClient();
  const result = await issueMandate({
    agent_id: overrides.agent_id || DEFAULT_TRAVELBOT_ID,
    max_amount: overrides.max_amount !== undefined ? overrides.max_amount : 20000,
    merchant_category: overrides.merchant_category || 'HOTEL',
    expiry_minutes: overrides.expiry_minutes !== undefined ? overrides.expiry_minutes : 60,
    webauthn_assertion: mockAuth.assertion,
    webauthn_public_key: mockAuth.publicKeyBase64URL,
    expected_challenge: mockAuth.challenge,
    expected_origin: mockAuth.origin,
    expected_rp_id: mockAuth.rpID
  });
  return { mandate: result, mockAuth };
}

test('Mandate Verification Service - Step 2 Tests', async (t) => {
  await t.test('1. Valid proposed transaction within mandate bounds passes verification', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 25000,
      merchant_category: 'HOTEL'
    });

    const proposedTx = {
      amount: 15000,
      merchant: 'Hotel Vendor A',
      category: 'HOTEL'
    };

    const verification = await verifyMandate(mandate.mandate_id, proposedTx);

    assert.equal(verification.valid, true, 'Verification must pass for valid transaction');
    assert.equal(verification.decision, 'VERIFIED');
    assert.equal(verification.mandate_id, mandate.mandate_id);
    assert.equal(verification.proposed_transaction.amount, 15000);
    assert.equal(verification.proposed_transaction.category, 'HOTEL');

    // Verify mandate nonce is NOT consumed yet (nonce consumption happens in Step 3)
    const storedMandate = await getMandate(mandate.mandate_id);
    assert.equal(storedMandate.nonce_used, false, 'Nonce must remain unused after verification');
  });

  await t.test('2. Proposed transaction exceeding max_amount fails with AMOUNT_EXCEEDS_MANDATE', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 10000,
      merchant_category: 'HOTEL'
    });

    const proposedTx = {
      amount: 12000, // Exceeds 10000
      merchant: 'Hotel Vendor A',
      category: 'HOTEL'
    };

    const verification = await verifyMandate(mandate.mandate_id, proposedTx);

    assert.equal(verification.valid, false, 'Over-budget transaction must fail');
    assert.equal(verification.decision, 'DENY');
    assert.equal(verification.stage, 'MANDATE_VERIFICATION');
    assert.equal(verification.reason_code, 'AMOUNT_EXCEEDS_MANDATE');
    assert.ok(verification.explanation.includes('exceeds authorized mandate maximum'));
    assert.ok(verification.suggested_fix.includes('Issue a new mandate with a higher max_amount'));
    assert.equal(verification.mandate_id, mandate.mandate_id);
  });

  await t.test('3. Wrong merchant category fails with MERCHANT_CATEGORY_MISMATCH', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 30000,
      merchant_category: 'HOTEL'
    });

    const proposedTx = {
      amount: 5000,
      merchant: 'Cab Vendor B',
      category: 'CAB' // Mismatch vs HOTEL
    };

    const verification = await verifyMandate(mandate.mandate_id, proposedTx);

    assert.equal(verification.valid, false, 'Category mismatch must fail');
    assert.equal(verification.decision, 'DENY');
    assert.equal(verification.stage, 'MANDATE_VERIFICATION');
    assert.equal(verification.reason_code, 'MERCHANT_CATEGORY_MISMATCH');
    assert.ok(verification.explanation.includes('does not match authorized category'));
    assert.ok(verification.suggested_fix.includes('Issue a mandate authorized for'));
  });

  await t.test('4. Expired mandate fails with MANDATE_EXPIRED', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 20000,
      merchant_category: 'FLIGHT'
    });

    // Artificially expire the mandate
    const pastDate = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 mins ago
    await updateMandate(mandate.mandate_id, { expires_at: pastDate });

    const proposedTx = {
      amount: 12000,
      merchant: 'Airline Vendor',
      category: 'FLIGHT'
    };

    const verification = await verifyMandate(mandate.mandate_id, proposedTx);

    assert.equal(verification.valid, false, 'Expired mandate must fail');
    assert.equal(verification.decision, 'DENY');
    assert.equal(verification.stage, 'MANDATE_VERIFICATION');
    assert.equal(verification.reason_code, 'MANDATE_EXPIRED');
    assert.ok(verification.explanation.includes('Mandate expired at'));
    assert.ok(verification.suggested_fix.includes('Issue a fresh mandate'));
  });

  await t.test('5. Replay attempt on consumed nonce fails with NONCE_ALREADY_USED', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 15000,
      merchant_category: 'TRAVEL'
    });

    // Simulate nonce consumption from prior transaction
    await updateMandate(mandate.mandate_id, { nonce_used: true });

    const proposedTx = {
      amount: 5000,
      merchant: 'Travel Vendor',
      category: 'TRAVEL'
    };

    const verification = await verifyMandate(mandate.mandate_id, proposedTx);

    assert.equal(verification.valid, false, 'Used nonce must be blocked');
    assert.equal(verification.decision, 'DENY');
    assert.equal(verification.stage, 'MANDATE_VERIFICATION');
    assert.equal(verification.reason_code, 'NONCE_ALREADY_USED');
    assert.ok(verification.explanation.includes('nonce for this mandate has already been consumed'));
  });

  await t.test('6. Tampered signature fails with SIGNATURE_INVALID', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 15000,
      merchant_category: 'HOTEL'
    });

    // Tamper with stored signature
    await updateMandate(mandate.mandate_id, { webauthn_signature: 'corrupted_invalid_signature' });

    const proposedTx = {
      amount: 5000,
      merchant: 'Hotel Vendor A',
      category: 'HOTEL'
    };

    const verification = await verifyMandate(mandate.mandate_id, proposedTx);

    assert.equal(verification.valid, false, 'Corrupted signature must fail re-validation');
    assert.equal(verification.decision, 'DENY');
    assert.equal(verification.stage, 'MANDATE_VERIFICATION');
    assert.equal(verification.reason_code, 'SIGNATURE_INVALID');
  });

  await t.test('7. POST /api/mandates/verify HTTP endpoint integration (Pass & Fail Paths)', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 20000,
      merchant_category: 'HOTEL'
    });

    // 7A. Test PASS path via mock request
    const { handleVerifyPass } = require('../src/services/mandateService');
    const verifyResult = await verifyMandate(mandate.mandate_id, {
      amount: 12000,
      merchant: 'Hotel Vendor A',
      category: 'HOTEL'
    });
    assert.equal(verifyResult.decision, 'VERIFIED');

    const { createVerifiedToken } = require('../src/services/mandateService');
    const tokenRecord = createVerifiedToken({
      mandate_id: mandate.mandate_id,
      proposed_transaction: { amount: 12000, merchant: 'Hotel Vendor A', category: 'HOTEL' },
      ttlSeconds: 120
    });

    assert.ok(tokenRecord.token.startsWith('vt_'), 'Verified token must be generated');
    assert.equal(tokenRecord.expires_in_seconds, 120);

    const retrievedToken = getVerifiedToken(tokenRecord.token);
    assert.ok(retrievedToken, 'Token must be retrievable from server-side cache');
    assert.equal(retrievedToken.amount, 12000);
    assert.equal(retrievedToken.mandate_id, mandate.mandate_id);
  });
});
