const express = require('express');
const router = express.Router();
const { verifyWebhookSignature } = require('../services/razorpayService');
const {
  checkIdempotency,
  updateTransactionFromWebhook,
  handleDuplicateRequest
} = require('../services/idempotencyService');
const {
  getTransaction,
  getAuditLogs,
  addAuditLog,
  listAgents,
  updateTransaction
} = require('../db/supabaseClient');

/**
 * POST /api/webhooks/razorpay
 * Receives and processes Razorpay Webhooks
 */
router.post('/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    // 1. Verify Webhook HMAC Signature
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.warn('[Webhook] Invalid Razorpay webhook signature received');
      return res.status(400).json({ error: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' });
    }

    const eventPayload = req.body || {};
    const eventName = eventPayload.event;
    const paymentEntity = eventPayload.payload?.payment?.entity || {};
    const orderEntity = eventPayload.payload?.order?.entity || {};
    const orderId = paymentEntity.order_id || orderEntity.id || eventPayload.order_id;
    const notes = paymentEntity.notes || orderEntity.notes || eventPayload.notes || {};
    const transactionId = notes.transaction_id || eventPayload.transaction_id;

    console.log(`[Webhook] Received event: ${eventName} for Order ID: ${orderId}`);

    // If transaction ID is directly known or lookup by orderId
    let targetTx = null;
    if (transactionId) {
      targetTx = await getTransaction(transactionId);
    }

    if (!targetTx && orderId) {
      // Find transaction matching orderId
      const recentLogs = await getAuditLogs(50);
      for (const log of recentLogs) {
        if (log.transactions?.razorpay_order_id === orderId) {
          targetTx = log.transactions;
          break;
        }
      }
    }

    if (targetTx) {
      // Check idempotency: If already SUCCESS or FAILED, log duplicate blocked
      if (targetTx.status === 'SUCCESS' || targetTx.status === 'FAILED') {
        console.log(`[Webhook] Duplicate webhook event '${eventName}' for transaction ${targetTx.id}`);
        await handleDuplicateRequest(targetTx.idempotency_key, targetTx, { webhookEvent: eventName });
        return res.status(200).json({ status: 'ignored_duplicate', message: 'Transaction already settled' });
      }

      // Determine target state
      let targetStatus = 'SUCCESS';
      if (eventName === 'payment.failed' || eventName === 'order.failed') {
        targetStatus = 'FAILED';
      }

      await updateTransactionFromWebhook(targetTx.id, targetStatus, eventPayload);
      console.log(`[Webhook] Updated transaction ${targetTx.id} -> ${targetStatus}`);
    } else {
      // Unassociated or standalone webhook event
      await addAuditLog(null, 'WEBHOOK_RECEIVED', {
        event: eventName,
        order_id: orderId,
        unmatched: true,
        payload: eventPayload
      });
    }

    return res.status(200).json({ status: 'ok', event: eventName, processed: true });
  } catch (err) {
    console.error('[Webhook Error]', err);
    return res.status(500).json({ error: 'WEBHOOK_ERROR', message: err.message });
  }
});

module.exports = router;
