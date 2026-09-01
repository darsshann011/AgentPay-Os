const express = require('express');
const router = express.Router();
const {
  issueMandate,
  verifyMandate,
  createVerifiedToken,
  generateMandateChallenge,
  getMandate,
  listMandates,
  consumeMandateNonceAtomic
} = require('../services/mandateService');
const { addAuditLog } = require('../db/supabaseClient');
const { formatDenial } = require('../utils/denialResponse');

/**
 * POST /api/mandates/challenge
 * Generates a cryptographic WebAuthn challenge for client authentication
 */
router.post('/challenge', async (req, res, next) => {
  try {
    const options = await generateMandateChallenge(req.body);
    return res.status(200).json({
      success: true,
      challenge: options.challenge,
      rpId: options.rpId || req.body?.rpID || 'localhost',
      options
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mandates/challenge
 * GET helper to generate a challenge
 */
router.get('/challenge', async (req, res, next) => {
  try {
    const options = await generateMandateChallenge();
    return res.status(200).json({
      success: true,
      challenge: options.challenge,
      rpId: options.rpId || 'localhost',
      options
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mandates/issue
 * Issues a new verified mandate on the Agent Trust Rail
 *
 * Request Body:
 * {
 *   "agent_id": "uuid",
 *   "max_amount": 12000,
 *   "merchant_category": "HOTEL",
 *   "expiry_minutes": 60,
 *   "webauthn_assertion": { ... },
 *   "webauthn_public_key": "base64url_string"
 * }
 */
router.post('/issue', async (req, res, next) => {
  try {
    const {
      agent_id,
      max_amount,
      merchant_category,
      expiry_minutes,
      webauthn_assertion,
      webauthn_public_key,
      expected_challenge,
      expected_origin,
      expected_rp_id
    } = req.body || {};

    const mandateResult = await issueMandate({
      agent_id,
      max_amount,
      merchant_category,
      expiry_minutes,
      webauthn_assertion,
      webauthn_public_key,
      expected_challenge,
      expected_origin,
      expected_rp_id
    });

    return res.status(200).json({
      mandate_id: mandateResult.mandate_id,
      status: mandateResult.status,
      agent_id: mandateResult.agent_id,
      max_amount: mandateResult.max_amount,
      merchant_category: mandateResult.merchant_category,
      nonce: mandateResult.nonce,
      issued_at: mandateResult.issued_at,
      expires_at: mandateResult.expires_at
    });
  } catch (err) {
    console.error('[Mandate Route Error]', err.message);
    const statusCode = err.status || (err.code && err.code.startsWith('INVALID_') ? 400 : 400);
    return res.status(statusCode).json({
      error: true,
      code: err.code || 'MANDATE_ISSUANCE_FAILED',
      message: err.message
    });
  }
});

/**
 * POST /api/mandates/verify
 * Verifies a proposed transaction against an existing mandate on the Agent Trust Rail
 *
 * Request Body:
 * {
 *   "mandate_id": "uuid",
 *   "proposed_transaction": {
 *     "amount": 12000,
 *     "merchant": "Hotel Vendor A",
 *     "category": "HOTEL"
 *   }
 * }
 */
router.post('/verify', async (req, res, next) => {
  try {
    const { mandate_id, proposed_transaction } = req.body || {};

    if (!mandate_id) {
      return res.status(200).json(formatDenial(
        'MANDATE_VERIFICATION',
        'MANDATE_NOT_FOUND',
        'mandate_id is required for verification',
        'Provide a valid mandate_id in the request payload'
      ));
    }

    const verificationResult = await verifyMandate(mandate_id, proposed_transaction);

    if (!verificationResult.valid || verificationResult.decision !== 'VERIFIED') {
      // Denial Path - Structured response from §5
      await addAuditLog(null, 'MANDATE_DENIED', {
        mandate_id,
        stage: 'MANDATE_VERIFICATION',
        reason_code: verificationResult.reason_code,
        explanation: verificationResult.explanation,
        proposed_transaction
      });

      return res.status(200).json(formatDenial(
        verificationResult.stage || 'MANDATE_VERIFICATION',
        verificationResult.reason_code,
        verificationResult.explanation,
        verificationResult.suggested_fix,
        {
          mandate_id: verificationResult.mandate_id,
          timestamp: verificationResult.timestamp
        }
      ));
    }

    // Step 3 Atomic Nonce Check-and-Set: Nonce consumption happens at verified_token issuance time
    const consumption = await consumeMandateNonceAtomic(mandate_id);
    if (!consumption.success) {
      await addAuditLog(null, 'MANDATE_DENIED', {
        mandate_id,
        stage: 'MANDATE_VERIFICATION',
        reason_code: consumption.reason_code,
        explanation: consumption.explanation,
        proposed_transaction
      });

      return res.status(200).json(formatDenial(
        'MANDATE_VERIFICATION',
        consumption.reason_code,
        consumption.explanation,
        consumption.suggested_fix,
        {
          mandate_id,
          timestamp: new Date().toISOString()
        }
      ));
    }

    // Token issuance on successful verification AND atomic nonce consumption
    const tokenRecord = createVerifiedToken({
      mandate_id,
      proposed_transaction: verificationResult.proposed_transaction || proposed_transaction,
      ttlSeconds: 120
    });

    await addAuditLog(null, 'MANDATE_VERIFIED', {
      mandate_id,
      proposed_transaction: verificationResult.proposed_transaction || proposed_transaction,
      verified_token: tokenRecord.token,
      expires_in_seconds: tokenRecord.expires_in_seconds
    });

    return res.status(200).json({
      decision: 'VERIFIED',
      verified_token: tokenRecord.token,
      expires_in_seconds: tokenRecord.expires_in_seconds
    });
  } catch (err) {
    console.error('[Mandate Verify Error]', err);
    return res.status(500).json({
      error: true,
      code: 'MANDATE_VERIFY_ERROR',
      message: err.message
    });
  }
});

/**
 * GET /api/mandates
 * Lists existing issued mandates (optional ?agent_id= query)
 */
router.get('/', async (req, res, next) => {
  try {
    const { agent_id } = req.query;
    const mandates = await listMandates(agent_id);
    return res.status(200).json({
      success: true,
      count: mandates.length,
      mandates
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mandates/agent/:agent_id/active
 * GET /api/mandates/:agent_id/active
 * Fetches the active (or most recent) mandate for a specific agent
 */
router.get('/agent/:agent_id/active', async (req, res, next) => {
  try {
    const { agent_id } = req.params;
    const mandates = await listMandates(agent_id);
    const activeMandate = mandates.find(
      (m) => m.status === 'ACTIVE' && new Date(m.expires_at).getTime() > Date.now() && !m.nonce_used
    ) || mandates[0] || null;

    return res.status(200).json({
      success: true,
      mandate: activeMandate
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:agent_id/active', async (req, res, next) => {
  try {
    const { agent_id } = req.params;
    const mandates = await listMandates(agent_id);
    const activeMandate = mandates.find(
      (m) => m.status === 'ACTIVE' && new Date(m.expires_at).getTime() > Date.now() && !m.nonce_used
    ) || mandates[0] || null;

    return res.status(200).json({
      success: true,
      mandate: activeMandate
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mandates/:id
 * Fetches single mandate by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const mandate = await getMandate(req.params.id);
    if (!mandate) {
      return res.status(404).json({
        error: true,
        code: 'MANDATE_NOT_FOUND',
        message: `Mandate with ID '${req.params.id}' not found`
      });
    }
    return res.status(200).json({
      success: true,
      mandate
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
