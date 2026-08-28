const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { parseIntent } = require('../services/intentParser');
const { evaluate } = require('../services/policyEngine');
const { createOrder, createPaymentLink } = require('../services/razorpayService');
const { checkIdempotency, handleDuplicateRequest } = require('../services/idempotencyService');
const {
  getAgent,
  createTransaction,
  updateTransaction,
  addAuditLog,
  processAtomicBudgetDeduction,
  DEFAULT_TRAVELBOT_ID
} = require('../db/supabaseClient');

/**
 * POST /api/agent-requests
 * Handles incoming natural-language or structured buyer agent requests
 */
router.post('/', async (req, res) => {
  try {
    const {
      prompt,
      agent_id,
      amount: rawAmount,
      merchant: rawMerchant,
      sku: rawSku,
      quantity: rawQuantity,
      payment_type = 'ORDER' // ORDER | PAYMENT_LINK
    } = req.body;

    // 1. Resolve Active Agent
    const agent = await getAgent(agent_id);
    if (!agent) {
      console.error(`[Policy Firewall] ❌ Agent lookup failed for agent_id: '${agent_id}'`);
      await addAuditLog(null, 'DENIED', { reason: 'AGENT_NOT_FOUND', agent_id: agent_id || 'unspecified' });
      return res.status(404).json({
        decision: 'DENY',
        reason: `Agent with ID '${agent_id}' not found in database`,
        ruleViolated: 'AGENT_NOT_FOUND'
      });
    }

    const resolvedAgentId = agent.id;

    // 2. Determine or generate Idempotency Key
    const idempotencyKey =
      req.headers['idempotency-key'] ||
      req.body.idempotency_key ||
      (prompt
        ? `ik_prompt_${crypto.createHash('sha256').update(`${resolvedAgentId}:${prompt}`).digest('hex').substring(0, 16)}`
        : `ik_tx_${uuidv4().substring(0, 16)}`);

    // 3. Check Idempotency State (Block Replays & Concurrent Duplicates)
    const idempotencyCheck = await checkIdempotency(idempotencyKey);
    if (idempotencyCheck.isDuplicate) {
      console.log(`[Policy Firewall] 🛡️ Duplicate request intercepted for key: ${idempotencyKey}`);
      const duplicateResult = await handleDuplicateRequest(
        idempotencyKey,
        idempotencyCheck.transaction,
        { prompt, body: req.body }
      );
      return res.status(409).json({
        decision: 'DENIED',
        blocked: true,
        reason: duplicateResult.reason,
        event: 'DUPLICATE_BLOCKED',
        transaction: duplicateResult.transaction
      });
    }

    // 4. Extract Intent (AI Layer / Natural Language Parser)
    let structuredIntent = null;
    let purchaseRequest = {};

    if (prompt) {
      console.log(`[AI Intent Layer] 🤖 Parsing buyer prompt: "${prompt}"`);
      structuredIntent = await parseIntent(prompt);
      purchaseRequest = {
        amount: structuredIntent.amount,
        merchant: structuredIntent.merchant,
        sku: structuredIntent.sku,
        quantity: structuredIntent.quantity,
        reason: structuredIntent.reason
      };
    } else {
      purchaseRequest = {
        amount: Number(rawAmount),
        merchant: rawMerchant,
        sku: rawSku || 'DIRECT-PURCHASE',
        quantity: Number(rawQuantity) || 1,
        reason: req.body.reason || 'Direct structured agent request'
      };
    }

    // 5. Log AGENT_REQUESTED audit event
    await addAuditLog(null, 'AGENT_REQUESTED', {
      agent_id: resolvedAgentId,
      agent_name: agent.name,
      prompt: prompt || null,
      idempotency_key: idempotencyKey,
      extracted_intent: purchaseRequest
    });

    // 6. Atomic Policy Evaluation with Row Locking (SELECT ... FOR UPDATE)
    console.log(`[Policy Engine] ⚖️ Deterministic evaluation for Agent: '${agent.name}', Amount: ₹${purchaseRequest.amount}, Merchant: '${purchaseRequest.merchant}'`);
    const deductionResult = await processAtomicBudgetDeduction(
      resolvedAgentId,
      purchaseRequest.amount,
      purchaseRequest.merchant,
      idempotencyKey
    );

    if (!deductionResult.success) {
      console.log(`[Policy Engine] ❌ DENIED: ${deductionResult.reason}`);
      return res.status(200).json({
        decision: 'DENY',
        status: 'DENIED',
        reason: deductionResult.reason,
        error_code: deductionResult.error_code,
        transaction_id: deductionResult.transaction_id || null,
        budget_remaining: deductionResult.budget_remaining !== undefined ? deductionResult.budget_remaining : agent.budget_remaining,
        structured_intent: structuredIntent
      });
    }

    const transactionId = deductionResult.transaction_id;

    // 7. Policy ALLOWED -> Call Razorpay API
    console.log(`[Razorpay Service] ✅ Policy ALLOWED. Initiating Razorpay payment...`);
    let razorpayResponse = null;

    try {
      if (payment_type === 'PAYMENT_LINK') {
        razorpayResponse = await createPaymentLink({
          amount: purchaseRequest.amount,
          description: `Agent purchase: ${purchaseRequest.sku}`,
          notes: {
            agent_id: resolvedAgentId,
            transaction_id: transactionId,
            sku: purchaseRequest.sku,
            merchant: purchaseRequest.merchant
          }
        });
      } else {
        razorpayResponse = await createOrder({
          amount: purchaseRequest.amount,
          receipt: `rcpt_${transactionId.substring(0, 8)}`,
          notes: {
            agent_id: resolvedAgentId,
            transaction_id: transactionId,
            sku: purchaseRequest.sku,
            merchant: purchaseRequest.merchant
          }
        });
      }

      // 8. Update transaction with Razorpay order/link ID
      const orderOrLinkId = razorpayResponse.id;
      await updateTransaction(transactionId, {
        razorpay_order_id: orderOrLinkId,
        status: 'ALLOWED'
      });

      // 9. Log PAYMENT_CREATED in Audit Log
      await addAuditLog(transactionId, 'PAYMENT_CREATED', {
        razorpay_id: orderOrLinkId,
        payment_type,
        amount: purchaseRequest.amount,
        merchant: purchaseRequest.merchant,
        sku: purchaseRequest.sku,
        details: razorpayResponse
      });

      return res.status(200).json({
        decision: 'ALLOW',
        status: 'ALLOWED',
        transaction_id: transactionId,
        idempotency_key: idempotencyKey,
        razorpay: {
          id: orderOrLinkId,
          type: payment_type,
          short_url: razorpayResponse.short_url || null,
          amount: purchaseRequest.amount,
          currency: 'INR'
        },
        budget_remaining: deductionResult.budget_remaining,
        structured_intent: structuredIntent
      });
    } catch (paymentErr) {
      console.error('[Razorpay Error]', paymentErr);
      await updateTransaction(transactionId, {
        status: 'FAILED',
        reason: `RAZORPAY_API_ERROR: ${paymentErr.message}`
      });
      await addAuditLog(transactionId, 'DENIED', {
        reason: 'RAZORPAY_API_ERROR',
        error: paymentErr.message
      });

      return res.status(502).json({
        decision: 'ALLOW_PAYMENT_FAILED',
        reason: paymentErr.message,
        transaction_id: transactionId
      });
    }
  } catch (err) {
    console.error('[Agent Request Handler Error]', err);
    return res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

module.exports = router;
