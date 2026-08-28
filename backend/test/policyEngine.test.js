const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/services/policyEngine');

test('Policy Engine - Step 2 Pure Rule Evaluation', async (t) => {
  const fakeAgentState = {
    id: 'test-agent-001',
    name: 'TravelBot Agent',
    budget_total: 50000,
    budget_remaining: 35000,
    allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
    velocity_limit: 5,
    recentTxCount: 2
  };

  await t.test('1. Should ALLOW valid request within budget, allowed merchant, and under velocity limit', () => {
    const request = {
      amount: 12000,
      merchant: 'Hotel Vendor A',
      sku: 'HOTEL-DELUXE-2N',
      quantity: 1
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'ALLOW');
    assert.match(result.reason, /POLICY_PASSED/);
    assert.equal(result.ruleViolated, undefined);
    assert.equal(result.ruleEvaluations.every(r => r.passed), true);
  });

  await t.test('2. Should DENY request exceeding budget_remaining', () => {
    const request = {
      amount: 40000, // exceeds budget_remaining (35000)
      merchant: 'Hotel Vendor A',
      sku: 'HOTEL-SUITE-5N'
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.ruleViolated, 'BUDGET_CHECK');
    assert.match(result.reason, /BUDGET_EXCEEDED/);
  });

  await t.test('3. Should DENY request with merchant not in allowed_merchants list', () => {
    const request = {
      amount: 5000,
      merchant: 'Unauthorized Luxury Mall',
      sku: 'LUXURY-WATCH'
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.ruleViolated, 'MERCHANT_CHECK');
    assert.match(result.reason, /MERCHANT_NOT_ALLOWED/);
  });

  await t.test('4. Should DENY request when velocity limit is reached in the hour', () => {
    const saturatedAgentState = {
      ...fakeAgentState,
      recentTxCount: 5, // reached velocity_limit (5)
    };

    const request = {
      amount: 1500,
      merchant: 'Cab Vendor B',
      sku: 'AIRPORT-CAB'
    };

    const result = evaluate(request, saturatedAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.ruleViolated, 'VELOCITY_CHECK');
    assert.match(result.reason, /VELOCITY_LIMIT_EXCEEDED/);
  });

  await t.test('5. Should DENY request with zero or negative amount', () => {
    const request = {
      amount: -500,
      merchant: 'Cab Vendor B'
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.ruleViolated, 'SANITY_CHECK');
    assert.match(result.reason, /INVALID_AMOUNT/);
  });
});
