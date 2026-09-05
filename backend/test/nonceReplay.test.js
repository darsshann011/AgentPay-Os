const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');

const {
  issueMandate,
  verifyMandate,
  getVerifiedToken,
  clearMandateTimers
} = require('../src/services/mandateService');

const {
  getMandate,
  createAgent,
  deleteAgent,
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

/**
 * Helper to send HTTP requests to express app
 */
function makeVerifyRequest(serverUrl, mandateId, proposedTx) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      mandate_id: mandateId,
      proposed_transaction: proposedTx
    });

    const url = new URL('/api/mandates/verify', serverUrl);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('Nonce Replay & Atomic Race Condition Protection - Step 3 Verification', async (t) => {
  let server;
  let serverUrl;

  t.before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    clearMandateTimers();
  });

  await t.test('1. Two concurrent POST /api/mandates/verify requests: exactly 1 succeeds and 1 fails with NONCE_ALREADY_USED', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 25000,
      merchant_category: 'HOTEL'
    });

    const proposedTx = {
      amount: 15000,
      merchant: 'Grand Hyatt Mumbai',
      category: 'HOTEL'
    };

    // Fire 2 concurrent verify requests with the identical mandate_id
    const [res1, res2] = await Promise.all([
      makeVerifyRequest(serverUrl, mandate.mandate_id, proposedTx),
      makeVerifyRequest(serverUrl, mandate.mandate_id, proposedTx)
    ]);

    const results = [res1.body, res2.body];
    const verifiedResults = results.filter((r) => r.decision === 'VERIFIED');
    const deniedResults = results.filter((r) => r.decision === 'DENY');

    // Exactly 1 must be VERIFIED
    assert.equal(verifiedResults.length, 1, 'Exactly one concurrent verification request must succeed');
    assert.ok(verifiedResults[0].verified_token, 'Verified result must contain a verified_token');
    assert.ok(verifiedResults[0].verified_token.startsWith('vt_'), 'Verified token must be formatted with vt_ prefix');
    assert.equal(verifiedResults[0].expires_in_seconds, 120);

    // Exactly 1 must be DENIED with NONCE_ALREADY_USED
    assert.equal(deniedResults.length, 1, 'Exactly one concurrent verification request must be denied');
    assert.equal(deniedResults[0].stage, 'MANDATE_VERIFICATION');
    assert.equal(deniedResults[0].reason_code, 'NONCE_ALREADY_USED');
    assert.ok(deniedResults[0].explanation.includes('already been consumed or replayed'));
    assert.equal(deniedResults[0].mandate_id, mandate.mandate_id);

    // Verify DB state
    const storedMandate = await getMandate(mandate.mandate_id);
    assert.equal(storedMandate.nonce_used, true, 'Mandate nonce_used must be true in database');
    assert.equal(storedMandate.status, 'USED', 'Mandate status must be USED in database');

    // Check that verified token is stored and retrievable
    const tokenRecord = getVerifiedToken(verifiedResults[0].verified_token);
    assert.ok(tokenRecord, 'Verified token must exist in server store');
    assert.equal(tokenRecord.mandate_id, mandate.mandate_id);
    assert.equal(tokenRecord.amount, 15000);
  });

  await t.test('2. Sequential replay on a previously verified mandate fails immediately with NONCE_ALREADY_USED', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 30000,
      merchant_category: 'HOTEL'
    });

    const proposedTx = {
      amount: 10000,
      merchant: 'Hotel Vendor A',
      category: 'HOTEL'
    };

    // First request: Must succeed
    const firstRes = await makeVerifyRequest(serverUrl, mandate.mandate_id, proposedTx);
    assert.equal(firstRes.body.decision, 'VERIFIED');
    assert.ok(firstRes.body.verified_token);

    // Second sequential request (Replay attempt): Must be denied
    const secondRes = await makeVerifyRequest(serverUrl, mandate.mandate_id, proposedTx);
    assert.equal(secondRes.body.decision, 'DENY');
    assert.equal(secondRes.body.stage, 'MANDATE_VERIFICATION');
    assert.equal(secondRes.body.reason_code, 'NONCE_ALREADY_USED');
    assert.ok(secondRes.body.explanation.includes('already been consumed or replayed'));
  });

  await t.test('3. High concurrency stress test: 5 concurrent requests against 1 mandate -> exactly 1 succeeds and 4 fail', async () => {
    const { mandate } = await issueTestMandate({
      max_amount: 50000,
      merchant_category: 'TRAVEL'
    });

    const proposedTx = {
      amount: 8000,
      merchant: 'MakeMyTrip',
      category: 'TRAVEL'
    };

    // Fire 5 concurrent requests at the same instant
    const requests = Array.from({ length: 5 }, () =>
      makeVerifyRequest(serverUrl, mandate.mandate_id, proposedTx)
    );

    const responses = await Promise.all(requests);
    const results = responses.map((r) => r.body);

    const verifiedCount = results.filter((r) => r.decision === 'VERIFIED').length;
    const deniedCount = results.filter((r) => r.decision === 'DENY').length;
    const nonceUsedDenials = results.filter((r) => r.reason_code === 'NONCE_ALREADY_USED').length;

    assert.equal(verifiedCount, 1, 'Exactly one of five concurrent requests must be verified');
    assert.equal(deniedCount, 4, 'Exactly four of five concurrent requests must be denied');
    assert.equal(nonceUsedDenials, 4, 'All four denials must cite NONCE_ALREADY_USED');
  });
});
