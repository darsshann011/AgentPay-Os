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
    failReason: (req, state) => {
      const amount = Number(req?.amount);
      if (isNaN(amount) || !isFinite(amount) || amount <= 0) return 'INVALID_AMOUNT: Amount must be greater than 0';
      if (!req?.merchant || req.merchant.trim().length === 0) return 'MISSING_MERCHANT: Merchant name is required';
      return 'INVALID_REQUEST: Request payload failed sanity check';
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
    failReason: (req, state) => {
      const amount = Number(req?.amount);
      const budgetRemaining = Number(state?.budget_remaining);
      return `BUDGET_EXCEEDED: Requested amount ₹${amount} exceeds remaining budget ₹${budgetRemaining}`;
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
    failReason: (req, state) => {
      const allowedList = Array.isArray(state?.allowed_merchants)
        ? state.allowed_merchants.join(', ')
        : 'None';
      return `MERCHANT_NOT_ALLOWED: '${req.merchant}' is not authorized. Allowed merchants: [${allowedList}]`;
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
    failReason: (req, state) => {
      const recentCount = Number(state?.recentTxCount || 0);
      const velocityLimit = Number(state?.velocity_limit !== undefined ? state.velocity_limit : 5);
      return `VELOCITY_LIMIT_EXCEEDED: Agent has executed ${recentCount} transactions in the last hour (Limit: ${velocityLimit})`;
    }
  }
];

/**
 * Pure policy evaluation function
 * @param {Object} request - { amount: number, merchant: string, sku?: string, quantity?: number }
 * @param {Object} agentState - { budget_total: number, budget_remaining: number, allowed_merchants: string[], velocity_limit: number, recentTxCount?: number }
 * @param {Array} customRules - Optional array of additional or override rules
 * @returns {{ decision: "ALLOW" | "DENY", reason: string, ruleViolated?: string, ruleEvaluations: Array }}
 */
function evaluate(request, agentState, customRules = DEFAULT_POLICY_RULES) {
  if (!agentState) {
    return {
      decision: 'DENY',
      reason: 'AGENT_NOT_FOUND: Agent state is missing or invalid',
      ruleViolated: 'AGENT_VALIDATION',
      ruleEvaluations: []
    };
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
      const reason = errorDetail || (rule.failReason ? rule.failReason(request, agentState) : `${rule.name}_FAILED`);
      return {
        decision: 'DENY',
        reason,
        ruleViolated: rule.name,
        ruleEvaluations
      };
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
