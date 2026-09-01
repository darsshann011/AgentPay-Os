const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  getAgent,
  createAgent,
  resetDatabaseState,
  processAtomicBudgetDeduction
} = require('../src/db/supabaseClient');
const { parseIntent } = require('../src/services/intentParser');

test('Agent Lookup & UTF-8 Encoding Tests (Bug 1 & Bug 2 Prevention)', async (t) => {
  t.beforeEach(async () => {
    await resetDatabaseState();
  });

  await t.test('1. Should resolve existing or default agent without AGENT_NOT_FOUND error', async () => {
    const customAgentId = uuidv4();
    try {
      await createAgent({
        id: customAgentId,
        name: 'TEST_Executive Assistant Bot',
        budget_total: 60000,
        budget_remaining: 60000,
        allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B'],
        velocity_limit: 5
      });

      // 1. Direct ID lookup
      const resolvedAgent = await getAgent(customAgentId);
      assert.ok(resolvedAgent, 'Agent must be found by ID');
      assert.equal(resolvedAgent.id, customAgentId);
      assert.equal(resolvedAgent.name, 'TEST_Executive Assistant Bot');

      // 2. Policy engine deduction test
      const deduction = await processAtomicBudgetDeduction(
        customAgentId,
        12000,
        'Hotel Vendor A',
        `test_key_${uuidv4()}`
      );

      assert.equal(deduction.success, true);
      assert.notEqual(deduction.error_code, 'AGENT_NOT_FOUND');
      assert.equal(deduction.budget_remaining, 48000);
    } finally {
      const { deleteAgent } = require('../src/db/supabaseClient');
      await deleteAgent(customAgentId);
    }
  });

  await t.test('2. Should handle currency symbol (₹) cleanly in intent extraction and prompts', async () => {
    const prompt = 'Please book 2 nights at Hotel Vendor A for ₹12,000 for team summit';
    const parsed = await parseIntent(prompt);

    assert.equal(parsed.amount, 12000);
    assert.equal(parsed.merchant, 'Hotel Vendor A');
    assert.ok(!parsed.reason.includes('â‚¹'), 'Extracted reason must not contain garbled UTF-8 artifacts');
  });
});
