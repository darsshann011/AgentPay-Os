const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');

const {
  issueMandate,
  getMandate,
  getMandateByNonce,
  generateMandateChallenge
} = require('../src/services/mandateService');

const {
  createAgent,
  deleteAgent,
  getAuditLogs,
  resetMemoryStore,
  DEFAULT_TRAVELBOT_ID
} = require('../src/db/supabaseClient');

/**
 * Helper to generate a valid WebAuthn key pair and client assertion for testing
 */
function createMockWebAuthnClient(options = {}) {
  const rpID = options.rpID || 'localhost';
  const origin = options.origin || 'http://localhost:3000';
  const challenge = options.challenge || isoBase64URL.fromBuffer(crypto.randomBytes(32));

  // Generate standard P-256 (ES256) key pair
  const keyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });

  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  const x = isoBase64URL.toBuffer(jwk.x);
  const y = isoBase64URL.toBuffer(jwk.y);

  // Build COSE Map:
  // 1: kty (2 = EC2)
  // 3: alg (-7 = ES256)
  // -1: crv (1 = P-256)
  // -2: x (Buffer)
  // -3: y (Buffer)
  const coseMap = new Map();
  coseMap.set(1, 2);
  coseMap.set(3, -7);
  coseMap.set(-1, 1);
  coseMap.set(-2, x);
  coseMap.set(-3, y);

  const cosePublicKeyBuffer = isoCBOR.encode(coseMap);
  const publicKeyBase64URL = isoBase64URL.fromBuffer(cosePublicKeyBuffer);
  const credentialID = isoBase64URL.fromBuffer(crypto.randomBytes(32));

  // Build clientDataJSON
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false
  });
  const clientDataJSONBase64 = isoBase64URL.fromUTF8String(clientDataJSON);

  // Build authenticatorData (rpIdHash + flags + signCount)
  const rpIdHash = crypto.createHash('sha256').update(rpID).digest();
  const flags = Buffer.from([0x05]); // UP (user present) + UV (user verified)
  const signCount = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const authDataBuffer = Buffer.concat([rpIdHash, flags, signCount]);
  const authenticatorDataBase64 = isoBase64URL.fromBuffer(authDataBuffer);

  // Signature calculation
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

test('Mandate Service - Agent Trust Rail Issuance Tests', async (t) => {
  await t.test('1. Successful mandate issuance with valid WebAuthn assertion', async () => {
    const mockAuth = createMockWebAuthnClient();

    const result = await issueMandate({
      agent_id: DEFAULT_TRAVELBOT_ID,
      max_amount: 15000,
      merchant_category: 'HOTEL',
      expiry_minutes: 120,
      webauthn_assertion: mockAuth.assertion,
      webauthn_public_key: mockAuth.publicKeyBase64URL,
      expected_challenge: mockAuth.challenge,
      expected_origin: mockAuth.origin,
      expected_rp_id: mockAuth.rpID
    });

    // Assert return properties
    assert.ok(result.mandate_id, 'Mandate ID must be generated');
    assert.equal(result.status, 'ACTIVE', 'Mandate status must be ACTIVE');
    assert.equal(result.agent_id, DEFAULT_TRAVELBOT_ID);
    assert.equal(result.max_amount, 15000);
    assert.equal(result.merchant_category, 'HOTEL');
    assert.ok(result.nonce.startsWith('nonce_'), 'Nonce must be present and formatted');
    assert.ok(new Date(result.expires_at) > new Date(), 'Expiry must be in the future');

    // Assert persistence in database
    const savedMandate = await getMandate(result.mandate_id);
    assert.ok(savedMandate, 'Mandate must be retrievable from DB');
    assert.equal(savedMandate.status, 'ACTIVE');
    assert.equal(savedMandate.nonce_used, false);
    assert.equal(savedMandate.webauthn_credential_id, mockAuth.credentialID);

    // Retrieve by nonce
    const byNonce = await getMandateByNonce(result.nonce);
    assert.ok(byNonce, 'Mandate must be retrievable by unique nonce');
    assert.equal(byNonce.mandate_id, result.mandate_id);

    // Assert audit trail entry
    const logs = await getAuditLogs(20);
    const mandateLog = logs.find(l => l.event_type === 'MANDATE_ISSUED' && l.detail?.mandate_id === result.mandate_id);
    assert.ok(mandateLog, 'MANDATE_ISSUED audit event must be logged');
    assert.equal(mandateLog.detail?.mandate_id, result.mandate_id);
    assert.equal(mandateLog.detail?.max_amount, 15000);
  });

  await t.test('2. Rejection of invalid / tampered WebAuthn assertion', async () => {
    const mockAuth = createMockWebAuthnClient();

    // Tamper with signature by flipping characters
    const tamperedSignature = mockAuth.assertion.response.signature.slice(0, -6) + 'AAAAAA';
    const tamperedAssertion = {
      ...mockAuth.assertion,
      response: {
        ...mockAuth.assertion.response,
        signature: tamperedSignature
      }
    };

    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: DEFAULT_TRAVELBOT_ID,
          max_amount: 10000,
          merchant_category: 'FLIGHT',
          webauthn_assertion: tamperedAssertion,
          webauthn_public_key: mockAuth.publicKeyBase64URL,
          expected_challenge: mockAuth.challenge,
          expected_origin: mockAuth.origin,
          expected_rp_id: mockAuth.rpID
        });
      },
      (err) => {
        assert.ok(
          err.message.includes('WEBAUTHN_VERIFICATION_FAILED'),
          `Expected WEBAUTHN_VERIFICATION_FAILED error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  await t.test('3. Rejection of assertion signed with a different key', async () => {
    const mockAuth1 = createMockWebAuthnClient();
    const mockAuth2 = createMockWebAuthnClient(); // Different key

    // Provide assertion from client 1 with public key from client 2
    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: DEFAULT_TRAVELBOT_ID,
          max_amount: 8000,
          merchant_category: 'CAB',
          webauthn_assertion: mockAuth1.assertion,
          webauthn_public_key: mockAuth2.publicKeyBase64URL, // Mismatched key
          expected_challenge: mockAuth1.challenge,
          expected_origin: mockAuth1.origin,
          expected_rp_id: mockAuth1.rpID
        });
      },
      (err) => {
        assert.ok(
          err.message.includes('WEBAUTHN_VERIFICATION_FAILED'),
          `Expected signature mismatch error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  await t.test('4. Rejection of malformed max_amount: negative, zero, or non-numeric', async () => {
    const mockAuth = createMockWebAuthnClient();

    // Test negative amount
    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: DEFAULT_TRAVELBOT_ID,
          max_amount: -5000,
          merchant_category: 'HOTEL',
          webauthn_assertion: mockAuth.assertion,
          webauthn_public_key: mockAuth.publicKeyBase64URL
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_MAX_AMOUNT');
        assert.ok(err.message.includes('must be a positive number greater than 0'));
        return true;
      }
    );

    // Test zero amount
    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: DEFAULT_TRAVELBOT_ID,
          max_amount: 0,
          merchant_category: 'HOTEL',
          webauthn_assertion: mockAuth.assertion,
          webauthn_public_key: mockAuth.publicKeyBase64URL
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_MAX_AMOUNT');
        return true;
      }
    );

    // Test NaN / non-numeric amount
    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: DEFAULT_TRAVELBOT_ID,
          max_amount: 'invalid_number',
          merchant_category: 'HOTEL',
          webauthn_assertion: mockAuth.assertion,
          webauthn_public_key: mockAuth.publicKeyBase64URL
        });
      },
      (err) => {
        assert.equal(err.code, 'INVALID_MAX_AMOUNT');
        return true;
      }
    );
  });

  await t.test('5. Rejection of missing merchant_category or non-existent agent', async () => {
    const mockAuth = createMockWebAuthnClient();

    // Missing merchant category
    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: DEFAULT_TRAVELBOT_ID,
          max_amount: 5000,
          merchant_category: '',
          webauthn_assertion: mockAuth.assertion,
          webauthn_public_key: mockAuth.publicKeyBase64URL
        });
      },
      (err) => {
        assert.equal(err.code, 'MISSING_MERCHANT_CATEGORY');
        return true;
      }
    );

    // Non-existent agent ID
    const randomAgentId = uuidv4();
    await assert.rejects(
      async () => {
        await issueMandate({
          agent_id: randomAgentId,
          max_amount: 5000,
          merchant_category: 'HOTEL',
          webauthn_assertion: mockAuth.assertion,
          webauthn_public_key: mockAuth.publicKeyBase64URL
        });
      },
      (err) => {
        assert.equal(err.code, 'AGENT_NOT_FOUND');
        return true;
      }
    );
  });

  await t.test('6. Challenge generator helper creates valid WebAuthn options', async () => {
    const challengeOptions = await generateMandateChallenge({ rpID: 'localhost' });
    assert.ok(challengeOptions.challenge, 'Challenge string must be present');
    assert.equal(challengeOptions.rpId, 'localhost');
    assert.equal(challengeOptions.timeout, 60000);
  });
});
