const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { isoBase64URL, isoCBOR } = require('@simplewebauthn/server/helpers');

const {
  issueMandate,
  verifyMandate,
  createVerifiedToken,
  getVerifiedToken,
  clearMandateTimers
} = require('../src/services/mandateService');

const {
  reconfirmAmount,
  authorizeOrder,
  captureOrder,
  voidAuthorization
} = require('../src/services/razorpayService');

const {
  getMandate,
  updateMandate,
  getAuditLogs,
  createAgent,
  deleteTestAgents,
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

async function createTestAgent() {
  return await createAgent({
    id: uuidv4(),
    name: 'TEST_AuthCapture_Agent_' + uuidv4().substring(0, 8),
    budget_total: 100000,
    budget_remaining: 100000,
    allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C', 'Airline Vendor', 'Travel Vendor'],
    velocity_limit: 100
  });
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
 * Helper to make HTTP POST requests
 */
function postJson(serverUrl, path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(path, serverUrl);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
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
    req.write(data);
    req.end();
  });
}

test('Authorize/Capture & Price-Drift Protection - Agent Trust Rail Step 5', async (t) => {
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
    await deleteTestAgents();
    clearMandateTimers();
  });

  await t.test('1. Successful end-to-end payment execution with valid verified_token (Authorize -> Reconfirm -> Capture)', async () => {
    const testAgent = await createTestAgent();

    // 1A. Issue mandate
    const { mandate } = await issueTestMandate({
      agent_id: testAgent.id,
      max_amount: 25000,
      merchant_category: 'HOTEL'
    });

    // 1B. Verify mandate & obtain verified_token
    const verifyRes = await postJson(serverUrl, '/api/mandates/verify', {
      mandate_id: mandate.mandate_id,
      proposed_transaction: {
        amount: 15000,
        merchant: 'Hotel Vendor A',
        category: 'HOTEL'
      }
    });

    assert.equal(verifyRes.body.decision, 'VERIFIED');
    assert.ok(verifyRes.body.verified_token);
    const verifiedToken = verifyRes.body.verified_token;

    // 1C. Execute agent request with verified_token
    const agentRes = await postJson(serverUrl, '/api/agent-requests', {
      verified_token: verifiedToken,
      agent_id: testAgent.id,
      amount: 15000,
      merchant: 'Hotel Vendor A',
      sku: 'HOTEL-DELUXE-2N'
    });

    assert.equal(agentRes.statusCode, 200);
    assert.equal(agentRes.body.decision, 'ALLOW');
    assert.equal(agentRes.body.status, 'ALLOWED');
    assert.ok(agentRes.body.transaction_id);
    assert.equal(agentRes.body.razorpay.status, 'captured');
    assert.equal(agentRes.body.razorpay.amount, 15000);

    // 1D. Check audit trail for CAPTURED event
    const logs = await getAuditLogs(20);
    const capturedLog = logs.find(
      (l) => l.event_type === 'CAPTURED' && l.detail?.transaction_id === agentRes.body.transaction_id
    );
    assert.ok(capturedLog, 'CAPTURED audit event must be logged upon successful capture');
    assert.equal(capturedLog.detail?.amount, 15000);
    assert.equal(capturedLog.detail?.mandate_id, mandate.mandate_id);
  });

  await t.test('2. Rejection when verified_token is missing or invalid', async () => {
    const testAgent = await createTestAgent();

    // Attempt payment without verified_token
    const noTokenRes = await postJson(serverUrl, '/api/agent-requests', {
      agent_id: testAgent.id,
      amount: 5000,
      merchant: 'Hotel Vendor A'
    });

    assert.equal(noTokenRes.statusCode, 200);
    assert.equal(noTokenRes.body.decision, 'DENY');
    assert.equal(noTokenRes.body.stage, 'MANDATE_VERIFICATION');
    assert.equal(noTokenRes.body.reason_code, 'TOKEN_MISSING_OR_INVALID');
    assert.ok(noTokenRes.body.explanation.includes('missing a valid verified_token'));

    // Attempt payment with bogus verified_token
    const bogusTokenRes = await postJson(serverUrl, '/api/agent-requests', {
      agent_id: testAgent.id,
      verified_token: 'vt_bogus_token_12345',
      amount: 5000,
      merchant: 'Hotel Vendor A'
    });

    assert.equal(bogusTokenRes.statusCode, 200);
    assert.equal(bogusTokenRes.body.decision, 'DENY');
    assert.equal(bogusTokenRes.body.stage, 'MANDATE_VERIFICATION');
    assert.equal(bogusTokenRes.body.reason_code, 'TOKEN_MISSING_OR_INVALID');
  });

  await t.test('3. Rejection when transaction payload differs from verified token authorization', async () => {
    const testAgent = await createTestAgent();

    // Issue & verify token for ₹10,000 on Hotel Vendor A
    const { mandate } = await issueTestMandate({
      agent_id: testAgent.id,
      max_amount: 20000,
      merchant_category: 'HOTEL'
    });

    const verifyRes = await postJson(serverUrl, '/api/mandates/verify', {
      mandate_id: mandate.mandate_id,
      proposed_transaction: {
        amount: 10000,
        merchant: 'Hotel Vendor A',
        category: 'HOTEL'
      }
    });

    const token = verifyRes.body.verified_token;

    // Send agent request trying to charge ₹15,000 using the ₹10,000 token
    const mismatchRes = await postJson(serverUrl, '/api/agent-requests', {
      agent_id: testAgent.id,
      verified_token: token,
      amount: 15000, // Mismatch vs 10000
      merchant: 'Hotel Vendor A'
    });

    assert.equal(mismatchRes.statusCode, 200);
    assert.equal(mismatchRes.body.decision, 'DENY');
    assert.equal(mismatchRes.body.stage, 'MANDATE_VERIFICATION');
    assert.equal(mismatchRes.body.reason_code, 'TOKEN_MISSING_OR_INVALID');
    assert.ok(mismatchRes.body.explanation.includes('do not match token authorized parameters'));
  });

  await t.test('4. Price-drift protection: Void authorization when final amount exceeds mandate max_amount', async () => {
    const testAgent = await createTestAgent();

    // Issue mandate with max_amount = ₹15,000
    const { mandate } = await issueTestMandate({
      agent_id: testAgent.id,
      max_amount: 15000,
      merchant_category: 'HOTEL'
    });

    // Create a verified token for ₹14,000
    const tokenRecord = createVerifiedToken({
      mandate_id: mandate.mandate_id,
      proposed_transaction: {
        amount: 14000,
        merchant: 'Hotel Vendor A',
        category: 'HOTEL'
      },
      ttlSeconds: 120
    });

    // Simulate price drift: mandate max_amount is lowered or drifted to ₹12,000 in DB
    await updateMandate(mandate.mandate_id, { max_amount: 12000 });

    // Execute agent request for ₹14,000
    const driftRes = await postJson(serverUrl, '/api/agent-requests', {
      agent_id: testAgent.id,
      verified_token: tokenRecord.token,
      amount: 14000,
      merchant: 'Hotel Vendor A'
    });

    assert.equal(driftRes.statusCode, 200);
    assert.equal(driftRes.body.decision, 'DENY');
    assert.equal(driftRes.body.stage, 'CAPTURE');
    assert.equal(driftRes.body.reason_code, 'PRICE_DRIFT_AT_CAPTURE');
    assert.ok(driftRes.body.explanation.includes('Price drift detected at capture'));
    assert.ok(driftRes.body.explanation.includes('14000'));
    assert.ok(driftRes.body.explanation.includes('12000'));
    assert.equal(driftRes.body.mandate_id, mandate.mandate_id);

    // Verify audit log for VOIDED event
    const logs = await getAuditLogs(20);
    const voidedLog = logs.find(
      (l) => l.event_type === 'VOIDED' && l.detail?.reason_code === 'PRICE_DRIFT_AT_CAPTURE'
    );
    assert.ok(voidedLog, 'VOIDED audit event must be logged on price drift rejection');
    assert.equal(voidedLog.detail?.current_amount, 14000);
    assert.equal(voidedLog.detail?.mandate_max_amount, 12000);
  });

  await t.test('5. Single-use token enforcement: Reusing verified_token is rejected', async () => {
    const testAgent = await createTestAgent();

    const { mandate } = await issueTestMandate({
      agent_id: testAgent.id,
      max_amount: 25000,
      merchant_category: 'HOTEL'
    });

    const verifyRes = await postJson(serverUrl, '/api/mandates/verify', {
      mandate_id: mandate.mandate_id,
      proposed_transaction: {
        amount: 8000,
        merchant: 'Hotel Vendor A',
        category: 'HOTEL'
      }
    });

    const token = verifyRes.body.verified_token;

    // 1st request with token -> SUCCESS
    const res1 = await postJson(serverUrl, '/api/agent-requests', {
      agent_id: testAgent.id,
      verified_token: token,
      amount: 8000,
      merchant: 'Hotel Vendor A'
    });
    assert.equal(res1.body.decision, 'ALLOW');

    // 2nd request trying to reuse same token -> REJECTED
    const res2 = await postJson(serverUrl, '/api/agent-requests', {
      agent_id: testAgent.id,
      verified_token: token,
      amount: 8000,
      merchant: 'Hotel Vendor A'
    });
    assert.equal(res2.body.decision, 'DENY');
    assert.equal(res2.body.stage, 'MANDATE_VERIFICATION');
    assert.equal(res2.body.reason_code, 'TOKEN_MISSING_OR_INVALID');
  });
});
