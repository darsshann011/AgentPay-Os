/**
 * ============================================================================
 * AgentPay OS - Standardized Denial Response Formatter
 * ============================================================================
 * Ensures all DENY responses across Mandate Verification, Policy Engine,
 * and Payment Capture conform to the unified §5 structured specification:
 *
 * {
 *   "decision": "DENY",
 *   "stage": "<MANDATE_VERIFICATION | POLICY_ENGINE | CAPTURE>",
 *   "reason_code": "...",
 *   "explanation": "<human-readable, states the actual numbers involved>",
 *   "suggested_fix": "...",
 *   "mandate_id": "...",   // omitted if not applicable
 *   "timestamp": "..."
 * }
 * ============================================================================
 */

/**
 * Formats a standardized denial response
 *
 * @param {string} stage - Stage where denial occurred: 'MANDATE_VERIFICATION' | 'POLICY_ENGINE' | 'CAPTURE'
 * @param {string} reason_code - Standardized uppercase error/denial code
 * @param {string} explanation - Human-readable explanation with exact values/numbers
 * @param {string} suggested_fix - Actionable remediation guidance
 * @param {Object} [extra={}] - Optional metadata (mandate_id, ruleViolated, ruleEvaluations, etc.)
 * @returns {Object} Standardized denial response object
 */
function formatDenial(stage, reason_code, explanation, suggested_fix, extra = {}) {
  const denial = {
    decision: 'DENY',
    stage: stage || 'POLICY_ENGINE',
    reason_code: reason_code || 'REQUEST_DENIED',
    explanation: explanation || 'Transaction policy check failed',
    suggested_fix: suggested_fix || 'Review policy constraints and retry',
    ...extra,
    timestamp: extra?.timestamp || new Date().toISOString()
  };

  // Omit mandate_id if not applicable
  if (!denial.mandate_id) {
    delete denial.mandate_id;
  }

  return denial;
}

module.exports = {
  formatDenial
};
