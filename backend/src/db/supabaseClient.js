const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
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
// In-Memory Fallback Store (Used when Supabase is not configured or offline)
// ---------------------------------------------------------------------------
const DEFAULT_CATALOG_ITEMS = [
  {
    sku: 'HOTEL-DELUXE-2N',
    name: 'Executive Deluxe Suite (2 Nights)',
    merchant: 'Hotel Vendor A',
    category: 'hotel',
    price: 12400,
    currency: 'INR',
    stock: 15
  },
  {
    sku: 'CAB-AIRPORT-SUV',
    name: 'Airport Premium SUV Transfer',
    merchant: 'Cab Vendor B',
    category: 'cab',
    price: 2500,
    currency: 'INR',
    stock: 50
  },
  {
    sku: 'INS-TRAVEL-MED',
    name: 'Comprehensive Travel & Medical Cover',
    merchant: 'Insurance Vendor C',
    category: 'insurance',
    price: 1800,
    currency: 'INR',
    stock: 100
  }
];

const memoryStore = {
  agents: new Map(),
  transactions: new Map(),
  audit_log: [],
  mandates: new Map(),
  catalog: new Map(),
  agentLocks: new Map(), // Mutex locks per agent ID
  mandateLocks: new Map(), // Mutex locks per mandate ID
};

const DEFAULT_TRAVELBOT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

// Seed default TravelBot agent and catalog items in memory store
memoryStore.agents.set(DEFAULT_TRAVELBOT_ID, {
  id: DEFAULT_TRAVELBOT_ID,
  name: 'TravelBot Agent',
  budget_total: 50000,
  budget_remaining: 50000,
  allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
  velocity_limit: 5,
  created_at: new Date().toISOString()
});

DEFAULT_CATALOG_ITEMS.forEach((item) => {
  memoryStore.catalog.set(item.sku, { ...item });
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

// Row-level lock acquisition helper for mandates in-memory store
async function acquireMandateLock(mandateId) {
  while (memoryStore.mandateLocks.get(mandateId)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  memoryStore.mandateLocks.set(mandateId, true);
  return () => {
    memoryStore.mandateLocks.set(mandateId, false);
  };
}

// Helper to ensure numeric Postgres columns are explicitly converted to Numbers in JS
function formatAgentRecord(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    budget_total: Number(agent.budget_total),
    budget_remaining: Number(agent.budget_remaining),
    allowed_merchants: Array.isArray(agent.allowed_merchants)
      ? agent.allowed_merchants
      : (typeof agent.allowed_merchants === 'string' ? JSON.parse(agent.allowed_merchants) : []),
    velocity_limit: Number(agent.velocity_limit || 5),
    created_at: agent.created_at
  };
}

// ---------------------------------------------------------------------------
// Database API Layer
// ---------------------------------------------------------------------------

async function getAgent(agentId) {
  const targetId = agentId || DEFAULT_TRAVELBOT_ID;
  console.log(`[Supabase Agent Lookup] 🔍 Querying agent_id: '${targetId}' | Supabase URL: '${SUPABASE_URL || 'in-memory'}'`);

  if (supabase) {
    try {
      // 1. If explicit agentId is supplied, lookup strictly by ID
      if (agentId) {
        const { data, error } = await supabase
          .from('agents')
          .select('*')
          .eq('id', agentId)
          .maybeSingle();

        console.log(`[Supabase Agent Lookup] 📋 Query for '${agentId}' raw result:`, data ? `Found (${data.name})` : 'Not Found', error ? `| Error: ${error.message}` : '');

        if (data) return formatAgentRecord(data);

        // If it was DEFAULT_TRAVELBOT_ID and missing, auto-seed
        if (agentId === DEFAULT_TRAVELBOT_ID) {
          console.log('[Supabase] TravelBot not found. Auto-seeding default TravelBot Agent...');
          const defaultAgent = {
            id: DEFAULT_TRAVELBOT_ID,
            name: 'TravelBot Agent',
            budget_total: 50000,
            budget_remaining: 50000,
            allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
            velocity_limit: 5
          };
          const { data: seededAgent } = await supabase
            .from('agents')
            .upsert(defaultAgent, { onConflict: 'id' })
            .select()
            .single();
          if (seededAgent) return formatAgentRecord(seededAgent);
        }

        // Check local memory store for this specific agentId before returning null
        if (memoryStore.agents.has(agentId)) {
          return formatAgentRecord(memoryStore.agents.get(agentId));
        }

        return null;
      }

      // 2. If NO agentId was specified, find or seed default TravelBot Agent
      const { data: travelBot, error: tbErr } = await supabase
        .from('agents')
        .select('*')
        .eq('id', DEFAULT_TRAVELBOT_ID)
        .maybeSingle();

      if (travelBot) return formatAgentRecord(travelBot);

      // 3. Otherwise find the first available agent named 'TravelBot Agent'
      const { data: firstAgent } = await supabase
        .from('agents')
        .select('*')
        .eq('name', 'TravelBot Agent')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (firstAgent) return formatAgentRecord(firstAgent);

      // 4. If agents table has other agents, return the first agent
      const { data: anyAgents } = await supabase
        .from('agents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (anyAgents) return formatAgentRecord(anyAgents);

      // 5. If agents table is completely empty, auto-seed default TravelBot agent
      console.log('[Supabase] Agents table is empty. Auto-seeding default TravelBot Agent...');
      const defaultAgent = {
        id: DEFAULT_TRAVELBOT_ID,
        name: 'TravelBot Agent',
        budget_total: 50000,
        budget_remaining: 50000,
        allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
        velocity_limit: 5
      };

      const { data: seededAgent } = await supabase
        .from('agents')
        .upsert(defaultAgent, { onConflict: 'id' })
        .select()
        .single();

      if (seededAgent) return formatAgentRecord(seededAgent);
    } catch (err) {
      console.error('[Supabase getAgent Exception]:', err.message);
    }
  }

  // Memory store fallback
  if (agentId) {
    const inMem = memoryStore.agents.get(agentId);
    return formatAgentRecord(inMem || null);
  }

  const defaultInMem = memoryStore.agents.get(DEFAULT_TRAVELBOT_ID) ||
    Array.from(memoryStore.agents.values())[0] ||
    null;

  return formatAgentRecord(defaultInMem);
}

async function listAgents() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[Supabase Error in listAgents]:', error.message);
      }

      if (data && data.length > 0) {
        const formatted = data.map(formatAgentRecord);
        // Place TravelBot at index 0
        return formatted.sort((a, b) => {
          if (a.id === DEFAULT_TRAVELBOT_ID || a.name === 'TravelBot Agent') return -1;
          if (b.id === DEFAULT_TRAVELBOT_ID || b.name === 'TravelBot Agent') return 1;
          return 0;
        });
      }

      // If empty, auto-seed and return
      const agent = await getAgent(DEFAULT_TRAVELBOT_ID);
      return agent ? [agent] : [];
    } catch (err) {
      console.error('[Supabase listAgents Exception]:', err.message);
    }
  }
  return Array.from(memoryStore.agents.values()).map(formatAgentRecord);
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
    try {
      const { data, error } = await supabase
        .from('agents')
        .insert(agent)
        .select()
        .single();
      if (!error && data) {
        return formatAgentRecord(data);
      }
      if (error) {
        console.error('[Supabase Error in createAgent / Fallback]:', error.message);
      }
    } catch (e) {
      console.error('[Supabase Exception in createAgent / Fallback]:', e.message);
    }
  }

  memoryStore.agents.set(id, agent);
  return formatAgentRecord(agent);
}

async function updateAgent(agentId, updates) {
  const sanitizedUpdates = { ...updates };
  if (sanitizedUpdates.budget_total !== undefined) sanitizedUpdates.budget_total = Number(sanitizedUpdates.budget_total);
  if (sanitizedUpdates.budget_remaining !== undefined) sanitizedUpdates.budget_remaining = Number(sanitizedUpdates.budget_remaining);
  if (sanitizedUpdates.velocity_limit !== undefined) sanitizedUpdates.velocity_limit = Number(sanitizedUpdates.velocity_limit);

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('agents')
        .update(sanitizedUpdates)
        .eq('id', agentId)
        .select()
        .single();
      if (!error && data) {
        return formatAgentRecord(data);
      }
      if (error) {
        console.error('[Supabase Error in updateAgent / Fallback]:', error.message);
      }
    } catch (e) {
      console.error('[Supabase Exception in updateAgent / Fallback]:', e.message);
    }
  }

  const existing = memoryStore.agents.get(agentId);
  if (!existing) return null;
  const updated = { ...existing, ...sanitizedUpdates };
  memoryStore.agents.set(agentId, updated);
  return formatAgentRecord(updated);
}

async function deleteAgent(agentId) {
  if (!agentId) return false;
  if (supabase) {
    try {
      const { error } = await supabase
        .from('agents')
        .delete()
        .eq('id', agentId);
      if (error) {
        console.error(`[Supabase Error in deleteAgent('${agentId}')]:`, error.message);
        return false;
      }
      return true;
    } catch (e) {
      console.error('[Supabase deleteAgent Exception]:', e.message);
      return false;
    }
  }
  return memoryStore.agents.delete(agentId);
}

async function deleteTestAgents() {
  const testNames = [
    'Concurrency Test Agent',
    'Idempotency Test Agent',
    'Executive Assistant Bot',
    'High Concurrency Agent',
    'Webhook Agent'
  ];

  let deletedCount = 0;

  if (supabase) {
    try {
      // Delete agents where name starts with TEST_
      const { data: prefixData, error: prefixErr } = await supabase
        .from('agents')
        .delete()
        .like('name', 'TEST_%')
        .select('id');

      if (!prefixErr && prefixData) {
        deletedCount += prefixData.length;
      }

      // Delete known legacy test agent names
      for (const name of testNames) {
        const { data: namedData, error: namedErr } = await supabase
          .from('agents')
          .delete()
          .eq('name', name)
          .select('id');

        if (!namedErr && namedData) {
          deletedCount += namedData.length;
        }
      }

      console.log(`[Supabase Test Cleanup] Deleted ${deletedCount} test agent rows.`);
    } catch (e) {
      console.error('[Supabase Test Cleanup Exception]:', e.message);
    }
  }

  // Also clean memory store
  for (const [id, agent] of memoryStore.agents.entries()) {
    if (id !== DEFAULT_TRAVELBOT_ID && (agent.name.startsWith('TEST_') || testNames.includes(agent.name))) {
      memoryStore.agents.delete(id);
      deletedCount++;
    }
  }

  return deletedCount;
}

async function getTransaction(txId) {
  if (supabase) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .maybeSingle();
    if (error) {
      console.error(`[Supabase Error in getTransaction('${txId}')]:`, error.message);
      return null;
    }
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
    if (error) {
      console.error(`[Supabase Error in getTransactionByIdempotencyKey('${key}')]:`, error.message);
      return null;
    }
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
    if (error) {
      console.error('[Supabase Error in createTransaction]:', error.message);
      throw error;
    }
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
    if (error) {
      console.error('[Supabase Error in updateTransaction]:', error.message);
      throw error;
    }
    return data;
  }

  const existing = memoryStore.transactions.get(txId);
  if (!existing) return null;
  const updated = { ...existing, ...enrichedUpdates };
  memoryStore.transactions.set(txId, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Tamper-Evident Audit Log Hash Chaining
// ---------------------------------------------------------------------------
let auditLogLock = Promise.resolve();
function acquireAuditLock() {
  let release;
  const p = new Promise(resolve => { release = resolve; });
  const acquire = auditLogLock.then(() => release);
  auditLogLock = auditLogLock.then(() => p);
  return acquire;
}

/**
 * Deterministic canonical JSON serialization
 */
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  return '{' + sortedKeys.map(key => JSON.stringify(key) + ':' + canonicalJson(obj[key])).join(',') + '}';
}

/**
 * Computes entry_hash = SHA-256(prev_hash + JSON-canonical form of entry's own fields)
 */
function computeAuditHash(prevHash, entry) {
  const canonicalPayload = canonicalJson({
    id: entry.id,
    transaction_id: entry.transaction_id || null,
    event_type: entry.event_type,
    detail: entry.detail || {},
    created_at: entry.created_at
  });
  return crypto
    .createHash('sha256')
    .update((prevHash || 'GENESIS') + canonicalPayload)
    .digest('hex');
}

async function addAuditLog(transactionId, eventType, detail = {}) {
  const release = await acquireAuditLock();
  try {
    let prevHash = 'GENESIS';

    if (supabase) {
      try {
        const { data: latestEntry, error: latestErr } = await supabase
          .from('audit_log')
          .select('entry_hash')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!latestErr && latestEntry && latestEntry.entry_hash) {
          prevHash = latestEntry.entry_hash;
        } else {
          const latestMem = memoryStore.audit_log[0];
          if (latestMem && latestMem.entry_hash) {
            prevHash = latestMem.entry_hash;
          }
        }
      } catch (e) {
        const latestMem = memoryStore.audit_log[0];
        if (latestMem && latestMem.entry_hash) {
          prevHash = latestMem.entry_hash;
        }
      }
    } else {
      const latestMem = memoryStore.audit_log[0];
      if (latestMem && latestMem.entry_hash) {
        prevHash = latestMem.entry_hash;
      }
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const entryHash = computeAuditHash(prevHash, {
      id,
      transaction_id: transactionId || null,
      event_type: eventType,
      detail,
      created_at: createdAt
    });

    const logEntry = {
      id,
      transaction_id: transactionId || null,
      event_type: eventType,
      detail,
      created_at: createdAt,
      prev_hash: prevHash,
      entry_hash: entryHash
    };

    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('audit_log')
          .insert(logEntry)
          .select()
          .single();
        if (!error && data && data.entry_hash) {
          memoryStore.audit_log.unshift(data);
          return data;
        }
        if (error) {
          console.error('[Audit Log] Supabase insertion error / Fallback:', error.message);
        }
      } catch (err) {
        console.error('[Audit Log] Supabase insertion exception / Fallback:', err.message);
      }
    }

    memoryStore.audit_log.unshift(logEntry);
    return logEntry;
  } finally {
    release();
  }
}

async function getAuditLogs(limit = 100) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('audit_log')
        .select(`
          id,
          transaction_id,
          event_type,
          detail,
          created_at,
          prev_hash,
          entry_hash,
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

      if (!error && data && data.length > 0 && data[0].entry_hash !== undefined) {
        return data;
      }
      if (error) {
        console.error('[Supabase Error in getAuditLogs]:', error.message);
      }
    } catch (err) {
      console.error('[Supabase getAuditLogs Exception]:', err.message);
    }
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

/**
 * Validates the full audit log cryptographic hash chain in order
 * @returns {Promise<{ valid: boolean, count?: number, broken_at_entry_id?: string, expected_hash?: string, found_hash?: string, reason?: string, verified_at?: string }>}
 */
async function verifyAuditChain() {
  let entries = [];

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .order('created_at', { ascending: true });

      if (!error && data && data.length > 0 && data[0].entry_hash) {
        entries = data;
      }
    } catch (e) {
      console.error('[verifyAuditChain Supabase Exception]:', e.message);
    }
  }

  if (entries.length === 0) {
    entries = memoryStore.audit_log.slice().reverse();
  }

  if (entries.length === 0) {
    return {
      valid: true,
      count: 0,
      verified_at: new Date().toISOString()
    };
  }

  let previousHash = 'GENESIS';

  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];

    // Check prev_hash
    if (row.prev_hash !== previousHash) {
      return {
        valid: false,
        broken_at_entry_id: row.id,
        entry_index: i,
        expected_prev_hash: previousHash,
        found_prev_hash: row.prev_hash,
        expected_hash: computeAuditHash(previousHash, row),
        found_hash: row.entry_hash,
        reason: 'PREV_HASH_MISMATCH'
      };
    }

    // Check entry_hash
    const expectedEntryHash = computeAuditHash(previousHash, row);
    if (row.entry_hash !== expectedEntryHash) {
      return {
        valid: false,
        broken_at_entry_id: row.id,
        entry_index: i,
        expected_hash: expectedEntryHash,
        found_hash: row.entry_hash,
        reason: 'ENTRY_HASH_MISMATCH'
      };
    }

    previousHash = row.entry_hash;
  }

  return {
    valid: true,
    count: entries.length,
    verified_at: new Date().toISOString()
  };
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
      if (error) {
        console.warn('[Supabase RPC Error / Fallback]:', error.message);
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

    if (supabase) {
      try {
        const { count, error: countErr } = await supabase
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('agent_id', agent.id)
          .gte('created_at', oneHourAgo)
          .in('status', ['PENDING', 'ALLOWED', 'SUCCESS']);
        if (!countErr && typeof count === 'number') {
          recentTxCount = count;
        }
      } catch (e) {
        // continue with 0
      }
    } else {
      for (const tx of memoryStore.transactions.values()) {
        if (tx.agent_id === agent.id && tx.created_at >= oneHourAgo && ['PENDING', 'ALLOWED', 'SUCCESS'].includes(tx.status)) {
          recentTxCount++;
        }
      }
    }

    if (recentTxCount >= agent.velocity_limit) {
      const tx = await createTransaction({
        agent_id: agent.id,
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
        agent_id: agent.id,
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
    if (Number(agent.budget_remaining) < Number(amount)) {
      const tx = await createTransaction({
        agent_id: agent.id,
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
    await updateAgent(agent.id, { budget_remaining: newBudgetRemaining });

    const tx = await createTransaction({
      agent_id: agent.id,
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

// ---------------------------------------------------------------------------
// Mandates API Layer (Agent Trust Rail)
// ---------------------------------------------------------------------------

function formatMandateRecord(mandate) {
  if (!mandate) return null;
  return {
    mandate_id: mandate.mandate_id || mandate.id,
    agent_id: mandate.agent_id,
    max_amount: Number(mandate.max_amount),
    merchant_category: mandate.merchant_category,
    nonce: mandate.nonce,
    nonce_used: Boolean(mandate.nonce_used),
    webauthn_credential_id: mandate.webauthn_credential_id,
    webauthn_signature: mandate.webauthn_signature,
    webauthn_public_key: mandate.webauthn_public_key,
    issued_at: mandate.issued_at,
    expires_at: mandate.expires_at,
    status: mandate.status || 'ACTIVE'
  };
}

async function createMandate(mandateData) {
  const mandate_id = mandateData.mandate_id || uuidv4();
  const mandate = {
    mandate_id,
    agent_id: mandateData.agent_id,
    max_amount: Number(mandateData.max_amount),
    merchant_category: mandateData.merchant_category,
    nonce: mandateData.nonce,
    nonce_used: Boolean(mandateData.nonce_used || false),
    webauthn_credential_id: mandateData.webauthn_credential_id,
    webauthn_signature: mandateData.webauthn_signature,
    webauthn_public_key: mandateData.webauthn_public_key,
    issued_at: mandateData.issued_at || new Date().toISOString(),
    expires_at: mandateData.expires_at,
    status: mandateData.status || 'ACTIVE'
  };

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('mandates')
        .insert(mandate)
        .select()
        .single();
      if (!error && data) {
        return formatMandateRecord(data);
      }
      if (error) {
        console.warn('[Supabase Warning in createMandate / Fallback]:', error.message);
      }
    } catch (e) {
      console.warn('[Supabase createMandate Exception / Fallback]:', e.message);
    }
  }

  memoryStore.mandates.set(mandate_id, mandate);
  return formatMandateRecord(mandate);
}

async function getMandate(mandateId) {
  if (!mandateId) return null;
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('mandates')
        .select('*')
        .eq('mandate_id', mandateId)
        .maybeSingle();
      if (!error && data) {
        return formatMandateRecord(data);
      }
    } catch (e) {
      // fallback to memoryStore
    }
  }
  return formatMandateRecord(memoryStore.mandates.get(mandateId) || null);
}

async function getMandateByNonce(nonce) {
  if (!nonce) return null;
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('mandates')
        .select('*')
        .eq('nonce', nonce)
        .maybeSingle();
      if (!error && data) {
        return formatMandateRecord(data);
      }
    } catch (e) {
      // fallback to memoryStore
    }
  }
  for (const mandate of memoryStore.mandates.values()) {
    if (mandate.nonce === nonce) return formatMandateRecord(mandate);
  }
  return null;
}

async function updateMandate(mandateId, updates) {
  if (!mandateId) return null;
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('mandates')
        .update(updates)
        .eq('mandate_id', mandateId)
        .select()
        .single();
      if (!error && data) {
        return formatMandateRecord(data);
      }
    } catch (e) {
      // fallback to memoryStore
    }
  }
  const existing = memoryStore.mandates.get(mandateId);
  if (!existing) return null;
  const updated = { ...existing, ...updates };
  memoryStore.mandates.set(mandateId, updated);
  return formatMandateRecord(updated);
}

async function listMandates(agentId) {
  if (supabase) {
    try {
      let query = supabase.from('mandates').select('*').order('issued_at', { ascending: false });
      if (agentId) query = query.eq('agent_id', agentId);
      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        return data.map(formatMandateRecord);
      }
    } catch (e) {
      // fallback to memoryStore
    }
  }
  const results = Array.from(memoryStore.mandates.values());
  if (agentId) return results.filter(m => m.agent_id === agentId).map(formatMandateRecord);
  return results.map(formatMandateRecord);
}

async function consumeMandateNonceAtomic(mandateId) {
  if (!mandateId) {
    return {
      success: false,
      reason_code: 'MANDATE_NOT_FOUND',
      explanation: 'mandateId is required',
      suggested_fix: 'Provide a valid mandate_id'
    };
  }

  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('consume_mandate_nonce', {
        p_mandate_id: mandateId
      });
      if (!error && data) {
        return data;
      }
      if (error) {
        console.warn('[Supabase consume_mandate_nonce RPC Warning / Fallback]:', error.message);
      }
    } catch (err) {
      console.warn('[Supabase RPC consume_mandate_nonce Exception / Fallback]:', err.message);
    }
  }

  // Fallback to in-memory mutex row lock
  const releaseLock = await acquireMandateLock(mandateId);
  try {
    const mandate = memoryStore.mandates.get(mandateId);
    if (!mandate) {
      return {
        success: false,
        reason_code: 'MANDATE_NOT_FOUND',
        explanation: `Mandate with ID '${mandateId}' was not found in database`,
        suggested_fix: 'Provide a valid mandate_id issued via POST /api/mandates/issue'
      };
    }

    if (mandate.nonce_used === true) {
      return {
        success: false,
        reason_code: 'NONCE_ALREADY_USED',
        explanation: 'The single-use nonce for this mandate has already been consumed or replayed',
        suggested_fix: 'Issue a new mandate with a fresh cryptographic nonce to prevent replay attacks'
      };
    }

    if (new Date(mandate.expires_at).getTime() <= Date.now()) {
      return {
        success: false,
        reason_code: 'MANDATE_EXPIRED',
        explanation: `Mandate expired at ${mandate.expires_at}`,
        suggested_fix: 'Issue a fresh mandate with updated expiry window'
      };
    }

    // Atomic update
    mandate.nonce_used = true;
    mandate.status = 'USED';
    memoryStore.mandates.set(mandateId, mandate);

    return {
      success: true,
      mandate_id: mandateId,
      nonce: mandate.nonce,
      status: 'USED'
    };
  } finally {
    releaseLock();
  }
}

async function listCatalogItems() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('catalog_items')
        .select('sku, name, merchant, category, price, currency, stock');

      if (!error && data && data.length > 0) {
        return data.map((item) => ({
          sku: item.sku,
          name: item.name,
          merchant: item.merchant,
          category: item.category,
          price: Number(item.price),
          currency: item.currency || 'INR',
          stock: Number(item.stock || 0)
        }));
      }
      if (error) {
        console.error('[Supabase listCatalogItems Error / Fallback]:', error.message);
      }
    } catch (err) {
      console.error('[Supabase listCatalogItems Exception / Fallback]:', err.message);
    }
  }

  // Memory store fallback
  return Array.from(memoryStore.catalog.values());
}

async function resetDatabaseState() {
  if (supabase) {
    try {
      console.log('[Supabase] Resetting TravelBot agent baseline (₹50,000 budget, all vendors)...');
      await supabase
        .from('agents')
        .upsert({
          id: DEFAULT_TRAVELBOT_ID,
          name: 'TravelBot Agent',
          budget_total: 50000,
          budget_remaining: 50000,
          allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
          velocity_limit: 5
        });
    } catch (e) {
      console.error('[Supabase Reset Error]:', e.message);
    }
  }

  memoryStore.agents.clear();
  memoryStore.transactions.clear();
  memoryStore.audit_log = [];
  memoryStore.mandates.clear();
  memoryStore.catalog.clear();
  DEFAULT_CATALOG_ITEMS.forEach((item) => {
    memoryStore.catalog.set(item.sku, { ...item });
  });
  memoryStore.agentLocks.clear();
  memoryStore.mandateLocks.clear();
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
  DEFAULT_CATALOG_ITEMS,
  getAgent,
  listAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  deleteTestAgents,
  formatAgentRecord,
  getTransaction,
  getTransactionByIdempotencyKey,
  createTransaction,
  updateTransaction,
  addAuditLog,
  getAuditLogs,
  processAtomicBudgetDeduction,
  createMandate,
  getMandate,
  getMandateByNonce,
  updateMandate,
  listMandates,
  formatMandateRecord,
  consumeMandateNonceAtomic,
  listCatalogItems,
  verifyAuditChain,
  canonicalJson,
  computeAuditHash,
  resetDatabaseState,
  resetMemoryStore: resetDatabaseState
};


