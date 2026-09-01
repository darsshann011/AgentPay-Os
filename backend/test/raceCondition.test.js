const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  processAtomicBudgetDeduction,
  createAgent,
  getAgent,
  resetMemoryStore
} = require('../src/db/supabaseClient');

test('Race Condition Protection - Step 4 Row-Level Locking Verification', async (t) => {
  t.beforeEach(() => {
    resetMemoryStore();
  });

  await t.test('Should prevent race conditions: Two concurrent ₹30,000 requests against ₹50,000 budget should only approve 1', async () => {
    const testAgentId = uuidv4();
    const { deleteAgent } = require('../src/db/supabaseClient');
    try {
      await createAgent({
        id: testAgentId,
        name: 'TEST_Concurrency Test Agent',
        budget_total: 50000,
        budget_remaining: 50000,
        allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B'],
        velocity_limit: 10
      });

      const idempotencyKey1 = `race-test-${uuidv4()}-1`;
      const idempotencyKey2 = `race-test-${uuidv4()}-2`;

      // Fire two near-simultaneous concurrent requests of ₹30,000
      const [result1, result2] = await Promise.all([
        processAtomicBudgetDeduction(testAgentId, 30000, 'Hotel Vendor A', idempotencyKey1),
        processAtomicBudgetDeduction(testAgentId, 30000, 'Hotel Vendor A', idempotencyKey2)
      ]);

      const successes = [result1, result2].filter(r => r.success === true);
      const failures = [result1, result2].filter(r => r.success === false);

      // Exactly 1 must succeed and 1 must fail due to budget exhaustion
      assert.equal(successes.length, 1, 'Exactly one concurrent request must be approved');
      assert.equal(failures.length, 1, 'Exactly one concurrent request must be denied');
      assert.equal(failures[0].error_code, 'BUDGET_EXCEEDED');

      // Verify database state
      const finalAgent = await getAgent(testAgentId);
      assert.equal(finalAgent.budget_remaining, 20000, 'Remaining budget must be exactly ₹20,000 (not -₹10,000)');
    } finally {
      await deleteAgent(testAgentId);
    }
  });

  await t.test('Multiple concurrent requests exhausting budget in sequence without race', async () => {
    const testAgentId = uuidv4();
    const { deleteAgent } = require('../src/db/supabaseClient');
    try {
      await createAgent({
        id: testAgentId,
        name: 'TEST_High Concurrency Agent',
        budget_total: 10000,
        budget_remaining: 10000,
        allowed_merchants: ['Cab Vendor B'],
        velocity_limit: 10
      });

      // Fire 5 concurrent requests of ₹3,000 (Total attempted: ₹15,000 on ₹10,000 budget)
      const requests = Array.from({ length: 5 }, (_, i) =>
        processAtomicBudgetDeduction(testAgentId, 3000, 'Cab Vendor B', `multi-race-${uuidv4()}-${i}`)
      );

      const results = await Promise.all(requests);
      const approvedCount = results.filter(r => r.success === true).length;
      const deniedCount = results.filter(r => r.success === false).length;

      // ₹10,000 / ₹3,000 = 3 allowed, remaining ₹1,000. 2 denied.
      assert.equal(approvedCount, 3, 'Should approve exactly 3 requests (₹9,000 total)');
      assert.equal(deniedCount, 2, 'Should deny exactly 2 requests');

      const finalAgent = await getAgent(testAgentId);
      assert.equal(finalAgent.budget_remaining, 1000, 'Final budget remaining must be ₹1,000');
    } finally {
      await deleteAgent(testAgentId);
    }
  });
});
