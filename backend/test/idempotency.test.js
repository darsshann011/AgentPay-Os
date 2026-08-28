const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  checkIdempotency,
  handleDuplicateRequest,
  updateTransactionFromWebhook
} = require('../src/services/idempotencyService');
const {
  createAgent,
  createTransaction,
  getAuditLogs,
  resetMemoryStore
} = require('../src/db/supabaseClient');

test('Idempotency & Webhook Service - Step 5 Verification', async (t) => {
  t.beforeEach(() => {
    resetMemoryStore();
  });

  await t.test('1. Should return isDuplicate: false for a fresh idempotency key', async () => {
    const key = `fresh-key-${uuidv4()}`;
    const result = await checkIdempotency(key);
    assert.equal(result.isDuplicate, false);
  });

  await t.test('2. Should detect duplicate key and record DUPLICATE_BLOCKED audit event', async () => {
    const agentId = uuidv4();
    await createAgent({
      id: agentId,
      name: 'Idempotency Test Agent',
      budget_total: 50000,
      budget_remaining: 50000,
      allowed_merchants: ['Hotel Vendor A'],
      velocity_limit: 5
    });

    const key = `duplicate-key-${uuidv4()}`;
    const tx = await createTransaction({
      agent_id: agentId,
      amount: 10000,
      merchant: 'Hotel Vendor A',
      idempotency_key: key,
      status: 'PENDING'
    });

    // Check duplicate
    const checkResult = await checkIdempotency(key);
    assert.equal(checkResult.isDuplicate, true);
    assert.equal(checkResult.status, 'PENDING');

    // Handle duplicate
    const blockResult = await handleDuplicateRequest(key, tx, { retry: true });
    assert.equal(blockResult.blocked, true);
    assert.equal(blockResult.event, 'DUPLICATE_BLOCKED');

    // Verify audit log has DUPLICATE_BLOCKED
    const logs = await getAuditLogs(10);
    const blockedLog = logs.find(l => l.event_type === 'DUPLICATE_BLOCKED');
    assert.ok(blockedLog, 'Audit log must record DUPLICATE_BLOCKED');
    assert.equal(blockedLog.transaction_id, tx.id);
  });

  await t.test('3. Should update transaction state upon webhook arrival', async () => {
    const agentId = uuidv4();
    await createAgent({
      id: agentId,
      name: 'Webhook Agent',
      budget_total: 50000,
      budget_remaining: 50000,
      allowed_merchants: ['Cab Vendor B'],
      velocity_limit: 5
    });

    const tx = await createTransaction({
      agent_id: agentId,
      amount: 5000,
      merchant: 'Cab Vendor B',
      idempotency_key: `webhook-test-${uuidv4()}`,
      status: 'PENDING'
    });

    const updated = await updateTransactionFromWebhook(tx.id, 'SUCCESS', {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_test_123' } } }
    });

    assert.equal(updated.status, 'SUCCESS');

    // Verify audit log has WEBHOOK_RECEIVED
    const logs = await getAuditLogs(10);
    const webhookLog = logs.find(l => l.event_type === 'WEBHOOK_RECEIVED');
    assert.ok(webhookLog, 'Audit log must record WEBHOOK_RECEIVED');
  });
});
