const express = require('express');
const router = express.Router();
const {
  getAuditLogs,
  listAgents,
  getAgent,
  verifyAuditChain,
  resetMemoryStore
} = require('../db/supabaseClient');

/**
 * GET /api/audit
 * Returns full audit trail ordered by created_at DESC
 */
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const logs = await getAuditLogs(limit);
    return res.json({
      success: true,
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error('[Audit API Error]', err);
    return res.status(500).json({ error: true, message: err.message });
  }
});

/**
 * GET /api/audit/verify-chain
 * Validates the cryptographic integrity of the tamper-evident audit log hash chain.
 * Walks the full audit log in order, recomputing each entry_hash from that row's fields +
 * the previous row's stored entry_hash.
 */
router.get('/verify-chain', async (req, res) => {
  try {
    const verification = await verifyAuditChain();
    return res.status(200).json(verification);
  } catch (err) {
    console.error('[Audit Verify Chain Error]', err);
    return res.status(500).json({
      valid: false,
      error: true,
      message: err.message
    });
  }
});

/**
 * GET /api/audit/agents
 * Returns list of agents with current status, budget remaining, and velocity metrics
 */
router.get('/agents', async (req, res) => {
  try {
    const agents = await listAgents();
    return res.json({
      success: true,
      agents
    });
  } catch (err) {
    console.error('[Audit Agents API Error]', err);
    return res.status(500).json({ error: true, message: err.message });
  }
});

/**
 * GET /api/audit/summary
 * Returns high-level metrics for dashboard header counters
 */
router.get('/summary', async (req, res) => {
  try {
    const logs = await getAuditLogs(500);
    const agents = await listAgents();

    let totalRequested = 0;
    let totalAllowed = 0;
    let totalDenied = 0;
    let totalBlockedDuplicates = 0;
    let totalVolumeAllowed = 0;

    for (const log of logs) {
      if (log.event_type === 'AGENT_REQUESTED') totalRequested++;
      if (log.event_type === 'POLICY_EVALUATED' && log.detail?.decision === 'ALLOW') {
        totalAllowed++;
        if (log.detail?.amount) totalVolumeAllowed += Number(log.detail.amount);
      }
      if (log.event_type === 'DENIED' || log.event_type === 'MANDATE_DENIED') totalDenied++;
      if (log.event_type === 'DUPLICATE_BLOCKED') totalBlockedDuplicates++;
    }

    return res.json({
      success: true,
      summary: {
        totalRequested,
        totalAllowed,
        totalDenied,
        totalBlockedDuplicates,
        totalVolumeAllowed,
        activeAgentsCount: agents.length
      }
    });
  } catch (err) {
    console.error('[Audit Summary API Error]', err);
    return res.status(500).json({ error: true, message: err.message });
  }
});

/**
 * POST /api/audit/reset
 * Resets demo data to initial state for clean demo presentation
 */
router.post('/reset', async (req, res) => {
  try {
    resetMemoryStore();
    return res.json({
      success: true,
      message: 'Demo state reset to initial TravelBot baseline (₹50,000 budget)'
    });
  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
});

module.exports = router;
