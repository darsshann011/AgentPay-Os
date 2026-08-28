-- ========================================================
-- AgentPay OS - Database Schema (PostgreSQL / Supabase)
-- ========================================================

-- Enable UUID extension if not already enabled
create extension if not exists "uuid-ossp";

-- 1. Agents Table
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  budget_total numeric not null,
  budget_remaining numeric not null,
  allowed_merchants text[] not null,
  velocity_limit int not null default 5,
  created_at timestamptz default now()
);

-- 2. Transactions Table
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  amount numeric not null,
  merchant text not null,
  idempotency_key text unique not null,
  status text not null default 'PENDING', -- PENDING | ALLOWED | DENIED | SUCCESS | FAILED
  razorpay_order_id text,
  reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3. Audit Log Table
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete set null,
  event_type text not null, -- AGENT_REQUESTED | POLICY_EVALUATED | PAYMENT_CREATED | WEBHOOK_RECEIVED | DUPLICATE_BLOCKED | DENIED
  detail jsonb,
  created_at timestamptz default now()
);

-- Indexes for fast lookup
create index if not exists idx_transactions_agent_id on transactions(agent_id);
create index if not exists idx_transactions_idempotency on transactions(idempotency_key);
create index if not exists idx_audit_log_transaction_id on audit_log(transaction_id);
create index if not exists idx_audit_log_created_at on audit_log(created_at desc);

-- ========================================================
-- ATOMIC ROW-LEVEL LOCKING FUNCTION (Race Condition Protection)
-- ========================================================
-- Uses Postgres transaction with row-level locking (SELECT ... FOR UPDATE)
-- to prevent concurrent requests from both passing budget checks simultaneously.

create or replace function process_agent_budget_deduction(
  p_agent_id uuid,
  p_amount numeric,
  p_merchant text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_agent record;
  v_tx_id uuid;
  v_recent_tx_count int;
begin
  -- 1. Acquire exclusive row lock on the agent
  select * into v_agent
  from agents
  where id = p_agent_id
  for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'error_code', 'AGENT_NOT_FOUND',
      'reason', 'Agent does not exist'
    );
  end if;

  -- 2. Check velocity limit (count of transactions in the last hour)
  select count(*) into v_recent_tx_count
  from transactions
  where agent_id = p_agent_id
    and created_at >= (now() - interval '1 hour')
    and status in ('PENDING', 'ALLOWED', 'SUCCESS');

  if v_recent_tx_count >= v_agent.velocity_limit then
    insert into transactions (agent_id, amount, merchant, idempotency_key, status, reason)
    values (p_agent_id, p_amount, p_merchant, p_idempotency_key, 'DENIED', 'VELOCITY_LIMIT_EXCEEDED')
    returning id into v_tx_id;

    insert into audit_log (transaction_id, event_type, detail)
    values (v_tx_id, 'DENIED', jsonb_build_object('reason', 'VELOCITY_LIMIT_EXCEEDED', 'recent_count', v_recent_tx_count));

    return jsonb_build_object(
      'success', false,
      'error_code', 'VELOCITY_LIMIT_EXCEEDED',
      'reason', 'Transaction velocity limit exceeded for the current hour',
      'transaction_id', v_tx_id
    );
  end if;

  -- 3. Check merchant allowance
  if not (p_merchant = any(v_agent.allowed_merchants)) then
    insert into transactions (agent_id, amount, merchant, idempotency_key, status, reason)
    values (p_agent_id, p_amount, p_merchant, p_idempotency_key, 'DENIED', 'MERCHANT_NOT_ALLOWED')
    returning id into v_tx_id;

    insert into audit_log (transaction_id, event_type, detail)
    values (v_tx_id, 'DENIED', jsonb_build_object('reason', 'MERCHANT_NOT_ALLOWED', 'merchant', p_merchant));

    return jsonb_build_object(
      'success', false,
      'error_code', 'MERCHANT_NOT_ALLOWED',
      'reason', 'Merchant is not in agent allowed merchant list',
      'transaction_id', v_tx_id
    );
  end if;

  -- 4. Check budget remaining
  if v_agent.budget_remaining < p_amount then
    insert into transactions (agent_id, amount, merchant, idempotency_key, status, reason)
    values (p_agent_id, p_amount, p_merchant, p_idempotency_key, 'DENIED', 'BUDGET_EXCEEDED')
    returning id into v_tx_id;

    insert into audit_log (transaction_id, event_type, detail)
    values (v_tx_id, 'DENIED', jsonb_build_object(
      'reason', 'BUDGET_EXCEEDED',
      'requested_amount', p_amount,
      'budget_remaining', v_agent.budget_remaining
    ));

    return jsonb_build_object(
      'success', false,
      'error_code', 'BUDGET_EXCEEDED',
      'reason', 'Requested amount exceeds remaining agent budget',
      'budget_remaining', v_agent.budget_remaining,
      'transaction_id', v_tx_id
    );
  end if;

  -- 5. Deduct budget atomically under lock
  update agents
  set budget_remaining = budget_remaining - p_amount
  where id = p_agent_id;

  -- 6. Insert transaction in ALLOWED / PENDING state
  insert into transactions (agent_id, amount, merchant, idempotency_key, status, reason)
  values (p_agent_id, p_amount, p_merchant, p_idempotency_key, 'PENDING', 'POLICY_PASSED')
  returning id into v_tx_id;

  -- 7. Write audit log entry
  insert into audit_log (transaction_id, event_type, detail)
  values (v_tx_id, 'POLICY_EVALUATED', jsonb_build_object(
    'decision', 'ALLOW',
    'amount', p_amount,
    'merchant', p_merchant,
    'new_budget_remaining', v_agent.budget_remaining - p_amount
  ));

  return jsonb_build_object(
    'success', true,
    'transaction_id', v_tx_id,
    'budget_remaining', v_agent.budget_remaining - p_amount
  );
end;
$$;
