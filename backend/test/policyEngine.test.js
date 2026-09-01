const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/services/policyEngine');

test('Policy Engine - Step 2 Pure Rule Evaluation & Structured Denials', async (t) => {
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

  await t.test('2. Should DENY request exceeding budget_remaining with structured denial shape', () => {
    const request = {
      amount: 40000, // exceeds budget_remaining (35000)
      merchant: 'Hotel Vendor A',
      sku: 'HOTEL-SUITE-5N'
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.stage, 'POLICY_ENGINE');
    assert.equal(result.reason_code, 'BUDGET_EXCEEDED');
    assert.equal(result.ruleViolated, 'BUDGET_CHECK');
    assert.ok(result.explanation.includes('40000'));
    assert.ok(result.explanation.includes('35000'));
    assert.ok(result.suggested_fix.includes('35000'));
    assert.ok(result.timestamp);
    assert.equal(result.mandate_id, undefined, 'mandate_id should be omitted when not applicable');
  });

  await t.test('3. Should DENY request with merchant not in allowed_merchants list', () => {
    const request = {
      amount: 5000,
      merchant: 'Unauthorized Luxury Mall',
      sku: 'LUXURY-WATCH'
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.stage, 'POLICY_ENGINE');
    assert.equal(result.reason_code, 'MERCHANT_NOT_ALLOWED');
    assert.equal(result.ruleViolated, 'MERCHANT_CHECK');
    assert.ok(result.explanation.includes('Unauthorized Luxury Mall'));
    assert.ok(result.suggested_fix.includes('allowed_merchants'));
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
    assert.equal(result.stage, 'POLICY_ENGINE');
    assert.equal(result.reason_code, 'VELOCITY_LIMIT_EXCEEDED');
    assert.equal(result.ruleViolated, 'VELOCITY_CHECK');
    assert.ok(result.explanation.includes('5'));
    assert.ok(result.suggested_fix.includes('velocity'));
  });

  await t.test('5. Should DENY request with zero or negative amount', () => {
    const request = {
      amount: -500,
      merchant: 'Cab Vendor B'
    };

    const result = evaluate(request, fakeAgentState);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.stage, 'POLICY_ENGINE');
    assert.equal(result.reason_code, 'INVALID_AMOUNT');
    assert.equal(result.ruleViolated, 'SANITY_CHECK');
    assert.ok(result.explanation.includes('-500'));
  });

  await t.test('6. Should correctly evaluate string-typed numeric values from Postgres/Supabase JSON', () => {
    // Supabase returns numeric columns as strings
    const stringAgentState = {
      id: 'test-agent-str',
      name: 'TravelBot Agent',
      budget_total: '50000.00',
      budget_remaining: '21000.00',
      allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B'],
      velocity_limit: '5',
      recentTxCount: '2'
    };

    // Valid purchase within budget with string amounts
    const validRequest = {
      amount: '12000',
      merchant: 'Hotel Vendor A',
      sku: 'HOTEL-STAY-2N'
    };

    const validResult = evaluate(validRequest, stringAgentState);
    assert.equal(validResult.decision, 'ALLOW');
    assert.match(validResult.reason, /POLICY_PASSED/);

    // Over budget purchase with string amounts
    const overBudgetRequest = {
      amount: '25000.00',
      merchant: 'Hotel Vendor A',
      sku: 'HOTEL-STAY-5N'
    };

    const overBudgetResult = evaluate(overBudgetRequest, stringAgentState);
    assert.equal(overBudgetResult.decision, 'DENY');
    assert.equal(overBudgetResult.stage, 'POLICY_ENGINE');
    assert.equal(overBudgetResult.reason_code, 'BUDGET_EXCEEDED');
    assert.equal(overBudgetResult.ruleViolated, 'BUDGET_CHECK');
    assert.ok(overBudgetResult.explanation.includes('25000'));
    assert.ok(overBudgetResult.explanation.includes('21000'));
  });
});
