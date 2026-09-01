const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { parseIntent } = require('../services/intentParser');
const { evaluate } = require('../services/policyEngine');
const {
  createOrder,
  authorizeOrder,
  reconfirmAmount,
  captureOrder,
  voidAuthorization,
  createPaymentLink
} = require('../services/razorpayService');
const { getVerifiedToken, consumeVerifiedToken } = require('../services/mandateService');
const { checkIdempotency, handleDuplicateRequest } = require('../services/idempotencyService');
const { formatDenial } = require('../utils/denialResponse');
const {
  getAgent,
  getMandate,
  createTransaction,
  updateTransaction,
  addAuditLog,
  processAtomicBudgetDeduction,
  DEFAULT_TRAVELBOT_ID
} = require('../db/supabaseClient');

/**
 * POST /api/agent-requests
 * Handles incoming natural-language or structured buyer agent requests.
 *
 * PART A: Hard-requires a valid verified_token from the Mandate Trust Rail.
 * PART B: Runs Policy Engine & Atomic Budget deduction (2nd defense layer).
 * PART C: Authorize -> Reconfirm (Price-drift protection) -> Capture / Void.
 */
router.post('/', async (req, res) => {
  try {
    const {
      verified_token,
      prompt,
      agent_id,
      amount: rawAmount,
      merchant: rawMerchant,
      sku: rawSku,
      quantity: rawQuantity,
      payment_type = 'ORDER' // ORDER | PAYMENT_LINK
    } = req.body || {};

    // ------------------------------------------------------------------------
    // STEP 1: Hard-Require verified_token (Trust Rail Defense Layer 1)
    // ------------------------------------------------------------------------
    if (!verified_token || typeof verified_token !== 'string') {
      return res.status(200).json(formatDenial(
        'MANDATE_VERIFICATION',
        'TOKEN_MISSING_OR_INVALID',
        'Request is missing a valid verified_token or token has expired',
        'Obtain a fresh verified_token by calling POST /api/mandates/verify prior to payment request'
      ));
    }

    const tokenRecord = getVerifiedToken(verified_token);
    if (!tokenRecord || tokenRecord.consumed) {
      return res.status(200).json(formatDenial(
        'MANDATE_VERIFICATION',
        'TOKEN_MISSING_OR_INVALID',
        'The provided verified_token is invalid, expired, or already consumed',
        'Obtain a fresh verified_token by calling POST /api/mandates/verify prior to payment request'
      ));
    }

    // ------------------------------------------------------------------------
    // STEP 2: Extract Intent / Request Payload
    // ------------------------------------------------------------------------
    let structuredIntent = null;
    let purchaseRequest = {};

    if (prompt) {
      console.log(`[AI Intent Layer] 🤖 Parsing buyer prompt: "${prompt}"`);
      structuredIntent = await parseIntent(prompt);
      purchaseRequest = {
        amount: Number(structuredIntent.amount),
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
        reason: req.body?.reason || 'Direct structured agent request'
      };
    }

    // ------------------------------------------------------------------------
    // STEP 3: Validate Request against Verified Token Payload (Single-Purpose Check)
    // ------------------------------------------------------------------------
    const isAmountMatching = Number(purchaseRequest.amount) === Number(tokenRecord.amount);
    const isMerchantMatching =
      !tokenRecord.merchant ||
      (purchaseRequest.merchant || '').trim().toLowerCase() === (tokenRecord.merchant || '').trim().toLowerCase();

    if (!isAmountMatching || !isMerchantMatching) {
      return res.status(200).json(formatDenial(
        'MANDATE_VERIFICATION',
        'TOKEN_MISSING_OR_INVALID',
        `Transaction parameters (Amount: ₹${purchaseRequest.amount}, Merchant: '${purchaseRequest.merchant}') do not match token authorized parameters (Amount: ₹${tokenRecord.amount}, Merchant: '${tokenRecord.merchant}')`,
        'Re-verify the updated transaction payload via POST /api/mandates/verify',
        { mandate_id: tokenRecord.mandate_id }
      ));
    }

    // Consume the verified token so it cannot be used again
    consumeVerifiedToken(verified_token);

    // ------------------------------------------------------------------------
    // STEP 4: Resolve Active Agent
    // ------------------------------------------------------------------------
    const targetAgentId = agent_id || tokenRecord.agent_id || DEFAULT_TRAVELBOT_ID;
    const agent = await getAgent(targetAgentId);
    if (!agent) {
      console.error(`[Policy Firewall] ❌ Agent lookup failed for agent_id: '${targetAgentId}'`);
      await addAuditLog(null, 'DENIED', { reason: 'AGENT_NOT_FOUND', agent_id: targetAgentId });
      return res.status(200).json(formatDenial(
        'POLICY_ENGINE',
        'AGENT_NOT_FOUND',
        `Agent with ID '${targetAgentId}' not found in database`,
        'Register or specify a valid agent ID'
      ));
    }

    const resolvedAgentId = agent.id;

    // ------------------------------------------------------------------------
    // STEP 5: Idempotency Check (Block Replays & Duplicates)
    // ------------------------------------------------------------------------
    const idempotencyKey =
      req.headers['idempotency-key'] ||
      req.body?.idempotency_key ||
      (prompt
        ? `ik_prompt_${crypto.createHash('sha256').update(`${resolvedAgentId}:${prompt}`).digest('hex').substring(0, 16)}`
        : `ik_tx_${uuidv4().substring(0, 16)}`);

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

    // Log AGENT_REQUESTED audit event
    await addAuditLog(null, 'AGENT_REQUESTED', {
      agent_id: resolvedAgentId,
      agent_name: agent.name,
      mandate_id: tokenRecord.mandate_id,
      verified_token,
      prompt: prompt || null,
      idempotency_key: idempotencyKey,
      extracted_intent: purchaseRequest
    });

    // ------------------------------------------------------------------------
    // STEP 6: Policy Engine & Atomic Row-Locked Budget Deduction (2nd Defense Layer)
    // ------------------------------------------------------------------------
    console.log(`[Policy Engine] ⚖️ Deterministic evaluation for Agent: '${agent.name}', Amount: ₹${purchaseRequest.amount}, Merchant: '${purchaseRequest.merchant}'`);
    const deductionResult = await processAtomicBudgetDeduction(
      resolvedAgentId,
      purchaseRequest.amount,
      purchaseRequest.merchant,
      idempotencyKey
    );

    if (!deductionResult.success) {
      console.log(`[Policy Engine] ❌ DENIED: ${deductionResult.reason}`);
      return res.status(200).json(formatDenial(
        'POLICY_ENGINE',
        deductionResult.error_code || 'BUDGET_EXCEEDED',
        deductionResult.reason,
        'Review agent budget or merchant constraints',
        {
          transaction_id: deductionResult.transaction_id || null,
          budget_remaining: deductionResult.budget_remaining !== undefined ? deductionResult.budget_remaining : agent.budget_remaining,
          structured_intent: structuredIntent,
          mandate_id: tokenRecord.mandate_id
        }
      ));
    }

    const transactionId = deductionResult.transaction_id;

    // ------------------------------------------------------------------------
    // STEP 7: Authorize -> Reconfirm (Price-Drift Protection) -> Capture
    // ------------------------------------------------------------------------
    console.log(`[Razorpay Service] ✅ Policy ALLOWED. Authorizing payment hold...`);

    // 7A. Authorize Order / Payment Hold
    const authOrder = await authorizeOrder({
      amount: purchaseRequest.amount,
      receipt: `rcpt_${transactionId.substring(0, 8)}`,
      notes: {
        agent_id: resolvedAgentId,
        transaction_id: transactionId,
        mandate_id: tokenRecord.mandate_id,
        sku: purchaseRequest.sku,
        merchant: purchaseRequest.merchant
      }
    });

    // Log AUTHORIZED in Audit Trail
    await addAuditLog(transactionId, 'AUTHORIZED', {
      order_id: authOrder.id,
      amount: purchaseRequest.amount,
      merchant: purchaseRequest.merchant,
      sku: purchaseRequest.sku,
      mandate_id: tokenRecord.mandate_id,
      transaction_id: transactionId
    });

    // 7B. Reconfirm Amount against Mandate Max Amount (TOCTOU Price-Drift Protection)
    const mandate = await getMandate(tokenRecord.mandate_id);
    const mandateMax = mandate ? Number(mandate.max_amount) : Number(tokenRecord.amount);

    const reconfirmation = reconfirmAmount(authOrder.id, purchaseRequest.amount, mandateMax);

    if (!reconfirmation.passed) {
      // Void Authorization on Price Drift
      console.warn(`[Price Drift Protection] ⚠️ Final amount ₹${purchaseRequest.amount} exceeds mandate ceiling ₹${mandateMax}. Voiding authorization...`);
      await voidAuthorization({
        orderId: authOrder.id,
        notes: {
          reason: 'PRICE_DRIFT_AT_CAPTURE',
          requested_amount: purchaseRequest.amount,
          mandate_max: mandateMax
        }
      });

      await updateTransaction(transactionId, {
        status: 'DENIED',
        reason: 'PRICE_DRIFT_AT_CAPTURE'
      });

      await addAuditLog(transactionId, 'VOIDED', {
        order_id: authOrder.id,
        reason_code: 'PRICE_DRIFT_AT_CAPTURE',
        current_amount: purchaseRequest.amount,
        mandate_max_amount: mandateMax,
        mandate_id: tokenRecord.mandate_id
      });

      return res.status(200).json(formatDenial(
        'CAPTURE',
        'PRICE_DRIFT_AT_CAPTURE',
        `Price drift detected at capture: final amount ₹${purchaseRequest.amount} exceeds authorized mandate cap ₹${mandateMax}`,
        'Re-issue a new mandate with a higher max_amount to accommodate price changes',
        {
          mandate_id: tokenRecord.mandate_id,
          transaction_id: transactionId
        }
      ));
    }

    // 7C. Capture Order on Successful Reconfirmation
    const captureResult = await captureOrder({
      orderId: authOrder.id,
      amount: purchaseRequest.amount,
      notes: {
        agent_id: resolvedAgentId,
        transaction_id: transactionId,
        mandate_id: tokenRecord.mandate_id
      }
    });

    // Update Transaction State to ALLOWED
    await updateTransaction(transactionId, {
      razorpay_order_id: authOrder.id,
      status: 'ALLOWED'
    });

    // Log CAPTURED Audit Event
    await addAuditLog(transactionId, 'CAPTURED', {
      razorpay_order_id: authOrder.id,
      payment_id: captureResult.id,
      amount: purchaseRequest.amount,
      merchant: purchaseRequest.merchant,
      sku: purchaseRequest.sku,
      mandate_id: tokenRecord.mandate_id,
      transaction_id: transactionId
    });

    return res.status(200).json({
      decision: 'ALLOW',
      status: 'ALLOWED',
      transaction_id: transactionId,
      idempotency_key: idempotencyKey,
      mandate_id: tokenRecord.mandate_id,
      razorpay: {
        id: authOrder.id,
        payment_id: captureResult.id,
        type: payment_type,
        amount: purchaseRequest.amount,
        currency: 'INR',
        status: 'captured'
      },
      budget_remaining: deductionResult.budget_remaining,
      structured_intent: structuredIntent
    });
  } catch (err) {
    console.error('[Agent Request Handler Error]', err);
    return res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

module.exports = router;
