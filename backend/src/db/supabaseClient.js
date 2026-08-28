const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
  SUPABASE_SERVICE_ROLE_KEY &&
  !SUPABASE_URL.includes('your-project') &&
  !SUPABASE_SERVICE_ROLE_KEY.includes('your-')
);

if (isSupabaseConfigured) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
    console.log('[Supabase] Initialized real Supabase connection:', SUPABASE_URL);
  } catch (err) {
    console.error('[Supabase] Initialization failed, falling back to local store:', err.message);
  }
} else {
  console.log('[Supabase] No credentials configured. Operating with local high-performance in-memory store.');
}

// ---------------------------------------------------------------------------
// In-Memory Fallback & Local Test Store (Includes Atomic Row-Level Mutex Lock)
// ---------------------------------------------------------------------------
const memoryStore = {
  agents: new Map(),
  transactions: new Map(),
  audit_log: [],
  agentLocks: new Map(), // Mutex locks per agent ID
};

// Seed default TravelBot agent in memory store for instant test readiness
const DEFAULT_TRAVELBOT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
memoryStore.agents.set(DEFAULT_TRAVELBOT_ID, {
  id: DEFAULT_TRAVELBOT_ID,
  name: 'TravelBot Agent',
  budget_total: 50000,
  budget_remaining: 50000,
  allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
  velocity_limit: 5,
  created_at: new Date().toISOString()
});

// Row-level lock acquisition helper for in-memory store
async function acquireAgentLock(agentId) {
  while (memoryStore.agentLocks.get(agentId)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  memoryStore.agentLocks.set(agentId, true);
  return () => {
    memoryStore.agentLocks.set(agentId, false);
  };
}

// ---------------------------------------------------------------------------
// Database API Layer
// ---------------------------------------------------------------------------

async function getAgent(agentId) {
  if (supabase) {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', agentId)
      .single();
    if (error) return null;
    return data;
  }
  return memoryStore.agents.get(agentId) || null;
}

async function listAgents() {
  if (supabase) {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }
  return Array.from(memoryStore.agents.values());
}

async function createAgent(agentData) {
  const id = agentData.id || uuidv4();
  const agent = {
    id,
    name: agentData.name,
    budget_total: Number(agentData.budget_total),
    budget_remaining: Number(agentData.budget_remaining !== undefined ? agentData.budget_remaining : agentData.budget_total),
    allowed_merchants: agentData.allowed_merchants || [],
    velocity_limit: Number(agentData.velocity_limit || 5),
    created_at: new Date().toISOString()
  };

  if (supabase) {
    const { data, error } = await supabase
      .from('agents')
      .insert(agent)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  memoryStore.agents.set(id, agent);
  return agent;
}

async function updateAgent(agentId, updates) {
  if (supabase) {
    const { data, error } = await supabase
      .from('agents')
      .update(updates)
      .eq('id', agentId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const existing = memoryStore.agents.get(agentId);
  if (!existing) return null;
  const updated = { ...existing, ...updates };
  memoryStore.agents.set(agentId, updated);
  return updated;
}

async function getTransaction(txId) {
  if (supabase) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .single();
    if (error) return null;
    return data;
  }
  return memoryStore.transactions.get(txId) || null;
}

async function getTransactionByIdempotencyKey(key) {
  if (!key) return null;
  if (supabase) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('idempotency_key', key)
      .maybeSingle();
    if (error) return null;
    return data;
  }
  for (const tx of memoryStore.transactions.values()) {
    if (tx.idempotency_key === key) return tx;
  }
  return null;
}

async function createTransaction(txData) {
  const id = txData.id || uuidv4();
  const tx = {
    id,
    agent_id: txData.agent_id,
    amount: Number(txData.amount),
    merchant: txData.merchant,
    idempotency_key: txData.idempotency_key,
    status: txData.status || 'PENDING',
    razorpay_order_id: txData.razorpay_order_id || null,
    reason: txData.reason || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (supabase) {
    const { data, error } = await supabase
      .from('transactions')
      .insert(tx)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  memoryStore.transactions.set(id, tx);
  return tx;
}

async function updateTransaction(txId, updates) {
  const enrichedUpdates = {
    ...updates,
    updated_at: new Date().toISOString()
  };

  if (supabase) {
    const { data, error } = await supabase
      .from('transactions')
      .update(enrichedUpdates)
      .eq('id', txId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const existing = memoryStore.transactions.get(txId);
  if (!existing) return null;
  const updated = { ...existing, ...enrichedUpdates };
  memoryStore.transactions.set(txId, updated);
  return updated;
}

async function addAuditLog(transactionId, eventType, detail = {}) {
  const logEntry = {
    id: uuidv4(),
    transaction_id: transactionId,
    event_type: eventType,
    detail,
    created_at: new Date().toISOString()
  };

  if (supabase) {
    const { data, error } = await supabase
      .from('audit_log')
      .insert(logEntry)
      .select()
      .single();
    if (error) {
      console.error('[Audit Log] Supabase insertion error:', error.message);
    }
    return data || logEntry;
  }

  memoryStore.audit_log.unshift(logEntry);
  return logEntry;
}

async function getAuditLogs(limit = 100) {
  if (supabase) {
    const { data, error } = await supabase
      .from('audit_log')
      .select(`
        id,
        transaction_id,
        event_type,
        detail,
        created_at,
        transactions (
          id,
          agent_id,
          amount,
          merchant,
          status,
          razorpay_order_id,
          reason,
          agents (
            id,
            name
          )
        )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!error && data) return data;
  }

  // Format memory store logs with joined transaction and agent info
  return memoryStore.audit_log.slice(0, limit).map((log) => {
    const tx = log.transaction_id ? memoryStore.transactions.get(log.transaction_id) : null;
    const agent = tx && tx.agent_id ? memoryStore.agents.get(tx.agent_id) : null;
    return {
      ...log,
      transactions: tx ? {
        ...tx,
        agents: agent ? { id: agent.id, name: agent.name } : null
      } : null
    };
  });
}

// ---------------------------------------------------------------------------
// Atomic Row-Level Locking Execution (Step 4 & Step 2/3 Core)
// ---------------------------------------------------------------------------
async function processAtomicBudgetDeduction(agentId, amount, merchant, idempotencyKey) {
  // If Supabase is connected and RPC function exists, use RPC
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('process_agent_budget_deduction', {
        p_agent_id: agentId,
        p_amount: amount,
        p_merchant: merchant,
        p_idempotency_key: idempotencyKey
      });

      if (!error && data) {
        return data;
      }
    } catch (err) {
      console.warn('[Supabase RPC] Falling back to atomic locked JS execution:', err.message);
    }
  }

  // Row-level lock acquisition to prevent race conditions
  const releaseLock = await acquireAgentLock(agentId);
  try {
    const agent = await getAgent(agentId);
    if (!agent) {
      return {
        success: false,
        error_code: 'AGENT_NOT_FOUND',
        reason: 'Agent does not exist'
      };
    }

    // 1. Calculate velocity count in last 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let recentTxCount = 0;
    for (const tx of memoryStore.transactions.values()) {
      if (tx.agent_id === agentId && tx.created_at >= oneHourAgo && ['PENDING', 'ALLOWED', 'SUCCESS'].includes(tx.status)) {
        recentTxCount++;
      }
    }

    if (recentTxCount >= agent.velocity_limit) {
      const tx = await createTransaction({
        agent_id: agentId,
        amount,
        merchant,
        idempotency_key: idempotencyKey,
        status: 'DENIED',
        reason: 'VELOCITY_LIMIT_EXCEEDED'
      });
      await addAuditLog(tx.id, 'DENIED', { reason: 'VELOCITY_LIMIT_EXCEEDED', recent_count: recentTxCount });
      return {
        success: false,
        error_code: 'VELOCITY_LIMIT_EXCEEDED',
        reason: 'Transaction velocity limit exceeded for the current hour',
        transaction_id: tx.id
      };
    }

    // 2. Merchant check
    if (!agent.allowed_merchants.includes(merchant)) {
      const tx = await createTransaction({
        agent_id: agentId,
        amount,
        merchant,
        idempotency_key: idempotencyKey,
        status: 'DENIED',
        reason: 'MERCHANT_NOT_ALLOWED'
      });
      await addAuditLog(tx.id, 'DENIED', { reason: 'MERCHANT_NOT_ALLOWED', merchant });
      return {
        success: false,
        error_code: 'MERCHANT_NOT_ALLOWED',
        reason: `Merchant '${merchant}' is not in agent allowed merchant list`,
        transaction_id: tx.id
      };
    }

    // 3. Budget check
    if (agent.budget_remaining < amount) {
      const tx = await createTransaction({
        agent_id: agentId,
        amount,
        merchant,
        idempotency_key: idempotencyKey,
        status: 'DENIED',
        reason: 'BUDGET_EXCEEDED'
      });
      await addAuditLog(tx.id, 'DENIED', {
        reason: 'BUDGET_EXCEEDED',
        requested_amount: amount,
        budget_remaining: agent.budget_remaining
      });
      return {
        success: false,
        error_code: 'BUDGET_EXCEEDED',
        reason: 'Requested amount exceeds remaining agent budget',
        budget_remaining: agent.budget_remaining,
        transaction_id: tx.id
      };
    }

    // 4. Deduct budget atomically
    const newBudgetRemaining = Number(agent.budget_remaining) - Number(amount);
    await updateAgent(agentId, { budget_remaining: newBudgetRemaining });

    const tx = await createTransaction({
      agent_id: agentId,
      amount,
      merchant,
      idempotency_key: idempotencyKey,
      status: 'PENDING',
      reason: 'POLICY_PASSED'
    });

    await addAuditLog(tx.id, 'POLICY_EVALUATED', {
      decision: 'ALLOW',
      amount,
      merchant,
      new_budget_remaining: newBudgetRemaining
    });

    return {
      success: true,
      transaction_id: tx.id,
      budget_remaining: newBudgetRemaining
    };
  } finally {
    releaseLock();
  }
}

function resetMemoryStore() {
  memoryStore.agents.clear();
  memoryStore.transactions.clear();
  memoryStore.audit_log = [];
  memoryStore.agentLocks.clear();
  memoryStore.agents.set(DEFAULT_TRAVELBOT_ID, {
    id: DEFAULT_TRAVELBOT_ID,
    name: 'TravelBot Agent',
    budget_total: 50000,
    budget_remaining: 50000,
    allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
    velocity_limit: 5,
    created_at: new Date().toISOString()
  });
}

module.exports = {
  supabase,
  isSupabaseConfigured,
  DEFAULT_TRAVELBOT_ID,
  getAgent,
  listAgents,
  createAgent,
  updateAgent,
  getTransaction,
  getTransactionByIdempotencyKey,
  createTransaction,
  updateTransaction,
  addAuditLog,
  getAuditLogs,
  processAtomicBudgetDeduction,
  resetMemoryStore
};
