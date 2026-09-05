const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const {
  addAuditLog,
  getAuditLogs,
  verifyAuditChain,
  verifyAuditChainForTestRun,
  resetMemoryStore,
  deleteTestAuditLogs,
  computeAuditHash,
  createTransaction,
  DEFAULT_TRAVELBOT_ID
} = require('../src/db/supabaseClient');

test('Tamper-Evident Audit Log Hash Chaining - Step 6 Tests', async (t) => {
  t.after(async () => {
    await deleteTestAuditLogs();
  });

  await t.test('1. Sequential audit writes form a valid cryptographic hash chain starting from GENESIS', async () => {
    const testRunId1 = `test_audit_${uuidv4().substring(0, 8)}`;
    await deleteTestAuditLogs(testRunId1);
    await resetMemoryStore();

    try {
      // Write sequential events representing the trust rail lifecycle
      const txId1 = uuidv4();
      await createTransaction({
        id: txId1,
        agent_id: DEFAULT_TRAVELBOT_ID,
        amount: 12000,
        merchant: 'Hotel Vendor A',
        idempotency_key: `test_ik_${txId1}`,
        status: 'PENDING'
      });
      const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { mandate_id: 'man_1', max_amount: 25000, test_run_id: testRunId1 });
      const log2 = await addAuditLog(null, 'MANDATE_VERIFIED', { mandate_id: 'man_1', verified_token: 'vt_1', test_run_id: testRunId1 });
      const log3 = await addAuditLog(txId1, 'AGENT_REQUESTED', { amount: 12000, merchant: 'Hotel Vendor A', test_run_id: testRunId1 });
      const log4 = await addAuditLog(txId1, 'AUTHORIZED', { order_id: 'order_1', amount: 12000, test_run_id: testRunId1 });
      const log5 = await addAuditLog(txId1, 'CAPTURED', { payment_id: 'pay_1', amount: 12000, test_run_id: testRunId1 });
      const log6 = await addAuditLog(txId1, 'WEBHOOK_RECEIVED', { event: 'payment.captured', test_run_id: testRunId1 });

      // Verify first entry has GENESIS
      assert.equal(log1.prev_hash, 'GENESIS', 'Genesis entry must have prev_hash === GENESIS');
      assert.ok(log1.entry_hash, 'Genesis entry must have a non-empty entry_hash');

      // Verify subsequent links
      assert.equal(log2.prev_hash, log1.entry_hash, 'Log 2 prev_hash must match Log 1 entry_hash');
      assert.equal(log3.prev_hash, log2.entry_hash, 'Log 3 prev_hash must match Log 2 entry_hash');
      assert.equal(log4.prev_hash, log3.entry_hash, 'Log 4 prev_hash must match Log 3 entry_hash');
      assert.equal(log5.prev_hash, log4.entry_hash, 'Log 5 prev_hash must match Log 4 entry_hash');
      assert.equal(log6.prev_hash, log5.entry_hash, 'Log 6 prev_hash must match Log 5 entry_hash');

      // Verify via internal verifyAuditChainForTestRun function
      const res = await verifyAuditChainForTestRun(testRunId1);
      assert.equal(res.valid, true);
      assert.equal(res.count, 6);
    } finally {
      await deleteTestAuditLogs(testRunId1);
    }
  });

  await t.test('2. Tampering with an audit entry detail causes verify-chain to detect the exact broken link', async () => {
    const testRunId2 = `test_audit_${uuidv4().substring(0, 8)}`;
    await deleteTestAuditLogs(testRunId2);
    await resetMemoryStore();

    try {
      const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { max_amount: 10000, test_run_id: testRunId2 });
      const log2 = await addAuditLog(null, 'AUTHORIZED', { amount: 8000, test_run_id: testRunId2 });
      const log3 = await addAuditLog(null, 'CAPTURED', { amount: 8000, test_run_id: testRunId2 });

      // Clean chain passes
      const cleanCheck = await verifyAuditChainForTestRun(testRunId2);
      assert.equal(cleanCheck.valid, true);

      // Tamper with log2's payload in memory (e.g. attacker modifies captured amount)
      log2.detail.amount = 999999;

      // Verify chain detects tampering
      const tamperedCheck = await verifyAuditChainForTestRun(testRunId2);
      assert.equal(tamperedCheck.valid, false, 'Tampered log must invalidate the chain');
      assert.equal(tamperedCheck.broken_at_entry_id, log2.id);
      assert.equal(tamperedCheck.reason, 'ENTRY_HASH_MISMATCH');
    } finally {
      await deleteTestAuditLogs(testRunId2);
    }
  });

  await t.test('3. Tampering with prev_hash link is detected immediately', async () => {
    const testRunId3 = `test_audit_${uuidv4().substring(0, 8)}`;
    await deleteTestAuditLogs(testRunId3);
    await resetMemoryStore();

    try {
      const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { max_amount: 5000, test_run_id: testRunId3 });
      const log2 = await addAuditLog(null, 'MANDATE_VERIFIED', { mandate_id: 'man_x', test_run_id: testRunId3 });
      const log3 = await addAuditLog(null, 'VOIDED', { reason: 'PRICE_DRIFT_AT_CAPTURE', test_run_id: testRunId3 });

      // Corrupt prev_hash link on log3
      log3.prev_hash = 'corrupted_fake_hash_0000000000';

      const check = await verifyAuditChainForTestRun(testRunId3);
      assert.equal(check.valid, false);
      assert.equal(check.broken_at_entry_id, log3.id);
      assert.equal(check.reason, 'PREV_HASH_MISMATCH');
    } finally {
      await deleteTestAuditLogs(testRunId3);
    }
  });

  await t.test('4. Standalone CLI script verify_audit_chain.js independently validates exported logs', async () => {
    const testRunId4 = `test_audit_${uuidv4().substring(0, 8)}`;
    await deleteTestAuditLogs(testRunId4);
    await resetMemoryStore();

    const tmpValidPath = path.join(__dirname, 'temp_valid_audit.json');
    const tmpTamperedPath = path.join(__dirname, 'temp_tampered_audit.json');

    try {
      const txId4 = uuidv4();
      await createTransaction({
        id: txId4,
        agent_id: DEFAULT_TRAVELBOT_ID,
        amount: 15000,
        merchant: 'Hotel Vendor A',
        idempotency_key: `test_ik_${txId4}`,
        status: 'PENDING'
      });
      const log1 = await addAuditLog(null, 'MANDATE_ISSUED', { max_amount: 50000, test_run_id: testRunId4 });
      const log2 = await addAuditLog(null, 'MANDATE_VERIFIED', { verified: true, test_run_id: testRunId4 });
      const log3 = await addAuditLog(txId4, 'CAPTURED', { amount: 15000, test_run_id: testRunId4 });

      const allLogs = await getAuditLogs(50);
      const logs = allLogs.filter((l) => l.detail?.test_run_id === testRunId4);
      const testLogs = logs[0]?.prev_hash === 'GENESIS' ? logs : logs.slice().reverse();

      // Export logs
      fs.writeFileSync(tmpValidPath, JSON.stringify(testLogs, null, 2));

      // Create tampered copy
      const tamperedLogs = JSON.parse(JSON.stringify(testLogs));
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
    } finally {
      // Clean up temporary files
      try { fs.unlinkSync(tmpValidPath); } catch (e) {}
      try { fs.unlinkSync(tmpTamperedPath); } catch (e) {}
      await deleteTestAuditLogs(testRunId4);
    }
  });
});
