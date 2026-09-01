const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const {
  addAuditLog,
  getAuditLogs,
  verifyAuditChain,
  resetMemoryStore,
  computeAuditHash
} = require('../src/db/supabaseClient');

const app = require('../src/server');

/**
 * Helper to make HTTP GET requests
 */
function getJson(serverUrl, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, serverUrl);
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('Tamper-Evident Audit Log Hash Chaining - Step 6 Tests', async (t) => {
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
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('1. Sequential audit writes form a valid cryptographic hash chain starting from GENESIS', async () => {
    await resetMemoryStore();

    // Write sequential events representing the trust rail lifecycle
    const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { mandate_id: 'man_1', max_amount: 25000 });
    const log2 = await addAuditLog(null, 'MANDATE_VERIFIED', { mandate_id: 'man_1', verified_token: 'vt_1' });
    const log3 = await addAuditLog('tx_1', 'AGENT_REQUESTED', { amount: 12000, merchant: 'Hotel Vendor A' });
    const log4 = await addAuditLog('tx_1', 'AUTHORIZED', { order_id: 'order_1', amount: 12000 });
    const log5 = await addAuditLog('tx_1', 'CAPTURED', { payment_id: 'pay_1', amount: 12000 });
    const log6 = await addAuditLog('tx_1', 'WEBHOOK_RECEIVED', { event: 'payment.captured' });

    // Verify first entry has GENESIS
    assert.equal(log1.prev_hash, 'GENESIS', 'Genesis entry must have prev_hash === GENESIS');
    assert.ok(log1.entry_hash, 'Genesis entry must have a non-empty entry_hash');

    // Verify subsequent links
    assert.equal(log2.prev_hash, log1.entry_hash, 'Log 2 prev_hash must match Log 1 entry_hash');
    assert.equal(log3.prev_hash, log2.entry_hash, 'Log 3 prev_hash must match Log 2 entry_hash');
    assert.equal(log4.prev_hash, log3.entry_hash, 'Log 4 prev_hash must match Log 3 entry_hash');
    assert.equal(log5.prev_hash, log4.entry_hash, 'Log 5 prev_hash must match Log 4 entry_hash');
    assert.equal(log6.prev_hash, log5.entry_hash, 'Log 6 prev_hash must match Log 5 entry_hash');

    // Verify via GET /api/audit/verify-chain HTTP endpoint
    const res = await getJson(serverUrl, '/api/audit/verify-chain');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.count, 6);
  });

  await t.test('2. Tampering with an audit entry detail causes verify-chain to detect the exact broken link', async () => {
    await resetMemoryStore();

    const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { max_amount: 10000 });
    const log2 = await addAuditLog(null, 'AUTHORIZED', { amount: 8000 });
    const log3 = await addAuditLog(null, 'CAPTURED', { amount: 8000 });

    // Clean chain passes
    const cleanCheck = await verifyAuditChain();
    assert.equal(cleanCheck.valid, true);

    // Tamper with log2's payload in memory (e.g. attacker modifies captured amount)
    log2.detail.amount = 999999;

    // Verify chain detects tampering
    const tamperedCheck = await verifyAuditChain();
    assert.equal(tamperedCheck.valid, false, 'Tampered log must invalidate the chain');
    assert.equal(tamperedCheck.broken_at_entry_id, log2.id);
    assert.equal(tamperedCheck.reason, 'ENTRY_HASH_MISMATCH');

    // HTTP endpoint also reflects invalid chain
    const res = await getJson(serverUrl, '/api/audit/verify-chain');
    assert.equal(res.body.valid, false);
    assert.equal(res.body.broken_at_entry_id, log2.id);
  });

  await t.test('3. Tampering with prev_hash link is detected immediately', async () => {
    await resetMemoryStore();

    const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { max_amount: 5000 });
    const log2 = await addAuditLog(null, 'MANDATE_VERIFIED', { mandate_id: 'man_x' });
    const log3 = await addAuditLog(null, 'VOIDED', { reason: 'PRICE_DRIFT_AT_CAPTURE' });

    // Corrupt prev_hash link on log3
    log3.prev_hash = 'corrupted_fake_hash_0000000000';

    const check = await verifyAuditChain();
    assert.equal(check.valid, false);
    assert.equal(check.broken_at_entry_id, log3.id);
    assert.equal(check.reason, 'PREV_HASH_MISMATCH');
  });

  await t.test('4. Standalone CLI script verify_audit_chain.js independently validates exported logs', async () => {
    await resetMemoryStore();

    await addAuditLog(null, 'MANDATE_ISSUED', { max_amount: 50000 });
    await addAuditLog(null, 'MANDATE_VERIFIED', { verified: true });
    await addAuditLog('tx_99', 'CAPTURED', { amount: 15000 });

    const logs = await getAuditLogs(10);
    // Export logs
    const tmpValidPath = path.join(__dirname, 'temp_valid_audit.json');
    const tmpTamperedPath = path.join(__dirname, 'temp_tampered_audit.json');

    fs.writeFileSync(tmpValidPath, JSON.stringify(logs, null, 2));

    // Create tampered copy
    const tamperedLogs = JSON.parse(JSON.stringify(logs));
    tamperedLogs[1].detail = { tampered: true }; // modify middle entry
    fs.writeFileSync(tmpTamperedPath, JSON.stringify(tamperedLogs, null, 2));

    const scriptPath = path.resolve(__dirname, '../scripts/verify_audit_chain.js');

    // 4A. Run standalone script on valid export -> Expect PASS (exit code 0)
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [scriptPath, tmpValidPath], (err, stdout, stderr) => {
        try {
          assert.equal(err, null, 'Valid audit file must exit with code 0');
          assert.ok(stdout.includes('PASS'), 'Output must contain PASS');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    // 4B. Run standalone script on tampered export -> Expect FAIL (exit code 1)
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [scriptPath, tmpTamperedPath], (err, stdout, stderr) => {
        try {
          assert.ok(err, 'Tampered audit file must exit with non-zero error code');
          assert.equal(err.code, 1);
          assert.ok(stdout.includes('FAIL') || stderr.includes('Broken Link Detected'), 'Output must indicate failure');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    // Clean up temporary files
    try { fs.unlinkSync(tmpValidPath); } catch (e) {}
    try { fs.unlinkSync(tmpTamperedPath); } catch (e) {}
  });
});
