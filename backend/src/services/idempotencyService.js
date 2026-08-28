/**
 * ============================================================================
 * AgentPay OS - Idempotency Service
 * ============================================================================
 * Tracks in-flight, completed, and failed transactions by idempotency key.
 * Transaction States:
 *   - PENDING: Request currently being evaluated or awaiting payment webhook.
 *   - SUCCESS: Payment successfully confirmed via Razorpay / Webhook.
 *   - FAILED:  Payment failed or policy denied.
 *
 * Prevents double-spending, duplicate webhook execution, and replay attacks.
 * ============================================================================
 */

const {
  getTransactionByIdempotencyKey,
  createTransaction,
  updateTransaction,
  addAuditLog
} = require('../db/supabaseClient');

const IDEMPOTENCY_STATES = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  ALLOWED: 'ALLOWED',
  DENIED: 'DENIED'
};

/**
 * Checks if an idempotency key is already recorded.
 * @param {string} idempotencyKey
 * @returns {Promise<{ isDuplicate: boolean, status?: string, transaction?: Object }>}
 */
async function checkIdempotency(idempotencyKey) {
  if (!idempotencyKey) {
    return { isDuplicate: false };
  }

  const existingTx = await getTransactionByIdempotencyKey(idempotencyKey);
  if (!existingTx) {
    return { isDuplicate: false };
  }

  return {
    isDuplicate: true,
    status: existingTx.status,
    transaction: existingTx
  };
}

/**
 * Handles duplicate request interception and audit logging
 * @param {string} idempotencyKey
 * @param {Object} existingTx
 * @param {Object} incomingPayload
 * @returns {Promise<Object>}
 */
async function handleDuplicateRequest(idempotencyKey, existingTx, incomingPayload = {}) {
  await addAuditLog(existingTx.id, 'DUPLICATE_BLOCKED', {
    idempotency_key: idempotencyKey,
    current_status: existingTx.status,
    incoming_payload: incomingPayload,
    message: `Duplicate request with key '${idempotencyKey}' blocked. Existing status: ${existingTx.status}`
  });

  return {
    blocked: true,
    event: 'DUPLICATE_BLOCKED',
    reason: `Duplicate transaction detected with status: ${existingTx.status}`,
    transaction: existingTx
  };
}

/**
 * Updates transaction status upon webhook confirmation
 * @param {string} razorpayOrderIdOrPaymentId
 * @param {string} targetStatus - SUCCESS or FAILED
 * @param {Object} webhookData
 */
async function updateTransactionFromWebhook(transactionId, targetStatus, webhookData = {}) {
  const updated = await updateTransaction(transactionId, {
    status: targetStatus,
    reason: targetStatus === 'SUCCESS' ? 'PAYMENT_CAPTURED_VIA_WEBHOOK' : 'PAYMENT_FAILED_VIA_WEBHOOK'
  });

  await addAuditLog(transactionId, 'WEBHOOK_RECEIVED', {
    target_status: targetStatus,
    event: webhookData.event,
    payload: webhookData.payload
  });

  return updated;
}

module.exports = {
  IDEMPOTENCY_STATES,
  checkIdempotency,
  handleDuplicateRequest,
  updateTransactionFromWebhook
};
