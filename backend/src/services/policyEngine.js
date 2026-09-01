/**
 * ============================================================================
 * AgentPay OS - Policy Engine (Deterministic Rule Evaluation)
 * ============================================================================
 * CORE PRINCIPLE:
 * This module is 100% DETERMINISTIC and has ZERO AI/LLM dependencies.
 * It is the ONLY component authorized to decide whether a transaction is
 * ALLOWED or DENIED, and the ONLY component authorized to sanction payments.
 * ============================================================================
 */

const { formatDenial } = require('../utils/denialResponse');

// Data-driven list of policy rules evaluated sequentially in a loop
const DEFAULT_POLICY_RULES = [
  {
    name: 'SANITY_CHECK',
    description: 'Amount must be a positive number and merchant must be specified',
    check: (req, state) => {
      const amount = Number(req?.amount);
      const hasValidAmount = !isNaN(amount) && isFinite(amount) && amount > 0;
      const hasMerchant = typeof req?.merchant === 'string' && req.merchant.trim().length > 0;
      return hasValidAmount && hasMerchant;
    },
    reasonCode: (req, state) => {
      const amount = Number(req?.amount);
      if (isNaN(amount) || !isFinite(amount) || amount <= 0) return 'INVALID_AMOUNT';
      if (!req?.merchant || req.merchant.trim().length === 0) return 'MISSING_MERCHANT';
      return 'INVALID_REQUEST';
    },
    failReason: (req, state) => {
      const amount = Number(req?.amount);
      if (isNaN(amount) || !isFinite(amount) || amount <= 0) return `Amount must be greater than 0. Received: '${req?.amount}'`;
      if (!req?.merchant || req.merchant.trim().length === 0) return 'Merchant name is required';
      return 'Request payload failed sanity check';
    },
    suggestedFix: (req, state) => {
      const amount = Number(req?.amount);
      if (isNaN(amount) || !isFinite(amount) || amount <= 0) return 'Provide a valid positive numeric amount greater than 0';
      if (!req?.merchant || req.merchant.trim().length === 0) return 'Specify a valid merchant name string';
      return 'Check request structure and parameters';
    }
  },
  {
    name: 'BUDGET_CHECK',
    description: 'Requested amount must not exceed remaining budget',
    check: (req, state) => {
      const amount = Number(req?.amount);
      const budgetRemaining = Number(state?.budget_remaining);
      return !isNaN(amount) && !isNaN(budgetRemaining) && amount <= budgetRemaining;
    },
    reasonCode: () => 'BUDGET_EXCEEDED',
    failReason: (req, state) => {
      const amount = Number(req?.amount);
      const budgetRemaining = Number(state?.budget_remaining);
      return `Requested amount ₹${amount} exceeds remaining budget ₹${budgetRemaining}`;
    },
    suggestedFix: (req, state) => {
      const budgetRemaining = Number(state?.budget_remaining);
      return `Reduce transaction amount to <= ₹${budgetRemaining} or request an agent budget top-up`;
    }
  },
  {
    name: 'MERCHANT_CHECK',
    description: 'Merchant must be in the agent whitelist of allowed merchants',
    check: (req, state) => {
      if (!Array.isArray(state?.allowed_merchants)) return false;
      const requestedMerchant = (req?.merchant || '').trim().toLowerCase();
      return state.allowed_merchants.some(
        (allowed) => (allowed || '').trim().toLowerCase() === requestedMerchant
      );
    },
    reasonCode: () => 'MERCHANT_NOT_ALLOWED',
    failReason: (req, state) => {
      const allowedList = Array.isArray(state?.allowed_merchants)
        ? state.allowed_merchants.join(', ')
        : 'None';
      return `'${req?.merchant}' is not authorized. Allowed merchants: [${allowedList}]`;
    },
    suggestedFix: (req, state) => {
      const allowedList = Array.isArray(state?.allowed_merchants)
        ? state.allowed_merchants.join(', ')
        : 'None';
      return `Select an authorized merchant from [${allowedList}] or add '${req?.merchant}' to the agent allowed_merchants whitelist`;
    }
  },
  {
    name: 'VELOCITY_CHECK',
    description: 'Agent transaction count in the last hour must be below velocity limit',
    check: (req, state) => {
      const recentCount = Number(state?.recentTxCount || 0);
      const velocityLimit = Number(state?.velocity_limit !== undefined ? state.velocity_limit : 5);
      return !isNaN(recentCount) && !isNaN(velocityLimit) && recentCount < velocityLimit;
    },
    reasonCode: () => 'VELOCITY_LIMIT_EXCEEDED',
    failReason: (req, state) => {
      const recentCount = Number(state?.recentTxCount || 0);
      const velocityLimit = Number(state?.velocity_limit !== undefined ? state.velocity_limit : 5);
      return `Agent has executed ${recentCount} transactions in the last hour (Limit: ${velocityLimit})`;
    },
    suggestedFix: () => 'Wait for the 1-hour transaction velocity window to roll over or increase the agent velocity_limit'
  }
];

/**
 * Pure policy evaluation function
 * @param {Object} request - { amount: number, merchant: string, sku?: string, quantity?: number }
 * @param {Object} agentState - { budget_total: number, budget_remaining: number, allowed_merchants: string[], velocity_limit: number, recentTxCount?: number }
 * @param {Array} customRules - Optional array of additional or override rules
 * @returns {{ decision: "ALLOW" | "DENY", stage?: string, reason_code?: string, explanation?: string, suggested_fix?: string, reason: string, ruleViolated?: string, ruleEvaluations: Array, timestamp?: string }}
 */
function evaluate(request, agentState, customRules = DEFAULT_POLICY_RULES) {
  if (!agentState) {
    return formatDenial(
      'POLICY_ENGINE',
      'AGENT_NOT_FOUND',
      'Agent state is missing or invalid',
      'Provide a valid agent_id registered in database',
      {
        reason: 'AGENT_NOT_FOUND: Agent state is missing or invalid',
        ruleViolated: 'AGENT_VALIDATION',
        ruleEvaluations: []
      }
    );
  }

  const ruleEvaluations = [];

  // Iterate over data-driven rule list
  for (const rule of customRules) {
    let passed = false;
    let errorDetail = null;

    try {
      passed = Boolean(rule.check(request, agentState));
    } catch (err) {
      passed = false;
      errorDetail = err.message;
    }

    ruleEvaluations.push({
      rule: rule.name,
      passed,
      description: rule.description
    });

    if (!passed) {
      const reasonCode = rule.reasonCode ? rule.reasonCode(request, agentState) : `${rule.name}_FAILED`;
      const explanation = errorDetail || (rule.failReason ? rule.failReason(request, agentState) : `${rule.name} check failed`);
      const suggestedFix = rule.suggestedFix ? rule.suggestedFix(request, agentState) : 'Review policy rules and retry';

      return formatDenial(
        'POLICY_ENGINE',
        reasonCode,
        explanation,
        suggestedFix,
        {
          reason: `${reasonCode}: ${explanation}`,
          ruleViolated: rule.name,
          ruleEvaluations
        }
      );
    }
  }

  // All rules passed
  return {
    decision: 'ALLOW',
    reason: 'POLICY_PASSED: All policy and risk firewall checks approved',
    ruleEvaluations
  };
}

module.exports = {
  evaluate,
  DEFAULT_POLICY_RULES
};
