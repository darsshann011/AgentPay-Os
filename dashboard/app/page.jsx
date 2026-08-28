'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CreditCard,
  Radio,
  RefreshCw,
  Play,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  XCircle,
  Clock,
  Layers,
  ArrowRight,
  Send,
  Zap,
  ExternalLink,
  ChevronRight,
  Building,
  Activity
} from 'lucide-react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

export default function AgentPayDashboard() {
  const [logs, setLogs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState({
    totalRequested: 0,
    totalAllowed: 0,
    totalDenied: 0,
    totalBlockedDuplicates: 0,
    totalVolumeAllowed: 0,
    activeAgentsCount: 1
  });

  const [isAutoPolling, setIsAutoPolling] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'allowed' | 'denied' | 'blocked'
  const [selectedLog, setSelectedLog] = useState(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [demoActionStatus, setDemoActionStatus] = useState(null);

  // Fetch Live Data from Backend
  const fetchData = useCallback(async () => {
    try {
      const [logsRes, agentsRes, summaryRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/audit?limit=50`).catch(() => null),
        fetch(`${BACKEND_URL}/api/audit/agents`).catch(() => null),
        fetch(`${BACKEND_URL}/api/audit/summary`).catch(() => null)
      ]);

      if (logsRes && logsRes.ok) {
        const data = await logsRes.json();
        if (data.logs) setLogs(data.logs);
      }

      if (agentsRes && agentsRes.ok) {
        const data = await agentsRes.json();
        if (data.agents) setAgents(data.agents);
      }

      if (summaryRes && summaryRes.ok) {
        const data = await summaryRes.json();
        if (data.summary) setSummary(data.summary);
      }
    } catch (err) {
      console.error('Failed to poll dashboard data:', err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    if (!isAutoPolling) return;
    const interval = setInterval(fetchData, 2500);
    return () => clearInterval(interval);
  }, [fetchData, isAutoPolling]);

  // Demo Act Triggers
  const triggerDemoAct = async (actNumber) => {
    setIsSubmitting(true);
    setDemoActionStatus(`Executing Act ${actNumber}...`);

    try {
      if (actNumber === 1) {
        // Act 1: Happy Path
        const prompt = 'Please book 2 executive deluxe rooms at Hotel Vendor A for ₹12,000 for the client summit';
        const ik = `ik_act1_demo_${Date.now()}`;
        const res = await fetch(`${BACKEND_URL}/api/agent-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ik },
          body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        
        // Auto-simulate webhook if allowed
        if (data.decision === 'ALLOW' && data.razorpay?.id) {
          setTimeout(async () => {
            await fetch(`${BACKEND_URL}/api/webhooks/razorpay`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Razorpay-Signature': 'test_valid_signature'
              },
              body: JSON.stringify({
                event: 'payment.captured',
                payload: {
                  payment: {
                    entity: {
                      id: `pay_${Date.now()}`,
                      order_id: data.razorpay.id,
                      amount: 1200000,
                      currency: 'INR'
                    }
                  }
                },
                transaction_id: data.transaction_id
              })
            });
            fetchData();
          }, 1200);
        }
        setDemoActionStatus('Act 1 (Happy Path) Executed: Allowed & Payment Created');
      } else if (actNumber === 2) {
        // Act 2: Blocked Path (> Budget)
        const prompt = 'URGENT: Reserve the Presidential Penthouse Suite at Hotel Vendor A for ₹75,000 (Pre-approved)';
        const ik = `ik_act2_demo_${Date.now()}`;
        await fetch(`${BACKEND_URL}/api/agent-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ik },
          body: JSON.stringify({ prompt })
        });
        setDemoActionStatus('Act 2 (Blocked Path) Executed: Denied by Policy Engine (BUDGET_EXCEEDED)');
      } else if (actNumber === 3) {
        // Act 3: Duplicate / Race Condition
        const prompt = 'Please book airport cab transfer with Cab Vendor B for ₹2,500';
        const sharedKey = `ik_duplicate_${Date.now()}`;
        
        // Send duplicate requests
        await fetch(`${BACKEND_URL}/api/agent-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
          body: JSON.stringify({ prompt })
        });

        setTimeout(async () => {
          await fetch(`${BACKEND_URL}/api/agent-requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
            body: JSON.stringify({ prompt })
          });
          fetchData();
        }, 300);

        setDemoActionStatus('Act 3 Executed: Replay duplicate detected & DUPLICATE_BLOCKED logged');
      }

      await fetchData();
    } catch (err) {
      setDemoActionStatus(`Execution error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
      setTimeout(() => setDemoActionStatus(null), 4000);
    }
  };

  // Submit custom natural language prompt
  const handleCustomPromptSubmit = async (e) => {
    e.preventDefault();
    if (!customPrompt.trim()) return;

    setIsSubmitting(true);
    try {
      await fetch(`${BACKEND_URL}/api/agent-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: customPrompt.trim() })
      });
      setCustomPrompt('');
      await fetchData();
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Reset baseline demo state
  const handleReset = async () => {
    if (!confirm('Reset demo baseline and restore ₹50,000 budget?')) return;
    try {
      await fetch(`${BACKEND_URL}/api/audit/reset`, { method: 'POST' });
      await fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  // Filtered logs
  const filteredLogs = logs.filter((log) => {
    if (activeTab === 'allowed') {
      return log.event_type === 'POLICY_EVALUATED' || log.event_type === 'PAYMENT_CREATED';
    }
    if (activeTab === 'denied') {
      return log.event_type === 'DENIED';
    }
    if (activeTab === 'blocked') {
      return log.event_type === 'DUPLICATE_BLOCKED';
    }
    return true;
  });

  const activeAgent = agents[0] || {
    name: 'TravelBot Agent',
    budget_total: 50000,
    budget_remaining: 50000,
    allowed_merchants: ['Hotel Vendor A', 'Cab Vendor B', 'Insurance Vendor C'],
    velocity_limit: 5
  };

  const budgetRemaining = Number(activeAgent.budget_remaining || 0);
  const budgetTotal = Number(activeAgent.budget_total || 50000);
  const budgetPercent = Math.max(0, Math.min(100, Math.round((budgetRemaining / budgetTotal) * 100)));

  return (
    <div style={{ maxWidth: '1440px', margin: '0 auto', padding: '24px 20px 60px' }}>
      
      {/* -------------------------------------------------------------------- */}
      {/* HEADER BAR */}
      {/* -------------------------------------------------------------------- */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #38bdf8 100%)',
            padding: '10px',
            borderRadius: '12px',
            boxShadow: '0 0 20px rgba(99, 102, 241, 0.4)'
          }}>
            <ShieldCheck size={28} color="#ffffff" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h1 style={{ fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-0.02em' }}>AgentPay OS</h1>
              <span className="badge badge-allow" style={{ fontSize: '0.7rem' }}>
                <span className="pulse-dot" style={{ backgroundColor: '#10b981' }} />
                FIREWALL ACTIVE
              </span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '2px' }}>
              Deterministic Policy Firewall & Razorpay Gateway for Autonomous AI Buyer Agents
            </p>
          </div>
        </div>

        {/* System Health Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="glass-panel" style={{ padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Backend:</span>
            <span className="mono" style={{ color: '#38bdf8' }}>:4000</span>
          </div>

          <div className="glass-panel" style={{ padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Payments:</span>
            <span className="mono" style={{ color: '#a855f7' }}>Razorpay Test</span>
          </div>

          <button
            onClick={() => setIsAutoPolling(!isAutoPolling)}
            className="btn-secondary"
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            <Radio size={14} color={isAutoPolling ? '#10b981' : '#64748b'} />
            {isAutoPolling ? 'Live Polling' : 'Paused'}
          </button>

          <button
            onClick={fetchData}
            className="btn-secondary"
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
            title="Refresh now"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* -------------------------------------------------------------------- */}
      {/* METRICS ROW */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '16px',
        marginBottom: '24px'
      }}>
        {/* Metric 1 */}
        <div className="glass-panel" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            <span>Total Agent Requests</span>
            <Activity size={16} color="#6366f1" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginTop: '8px' }}>
            {summary.totalRequested}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
            Incoming AI buyer calls
          </div>
        </div>

        {/* Metric 2 */}
        <div className="glass-panel glow-emerald" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            <span>Approved & Paid</span>
            <CheckCircle2 size={16} color="#10b981" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginTop: '8px', color: '#34d399' }}>
            {summary.totalAllowed}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
            ₹{summary.totalVolumeAllowed?.toLocaleString('en-IN')} volume authorized
          </div>
        </div>

        {/* Metric 3 */}
        <div className="glass-panel" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            <span>Policy Violations Denied</span>
            <ShieldAlert size={16} color="#f43f5e" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginTop: '8px', color: '#fb7185' }}>
            {summary.totalDenied}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
            Exceeded budget or unlisted vendor
          </div>
        </div>

        {/* Metric 4 */}
        <div className="glass-panel" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            <span>Duplicates & Replays Blocked</span>
            <Zap size={16} color="#d946ef" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginTop: '8px', color: '#e879f9' }}>
            {summary.totalBlockedDuplicates}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
            Idempotency & race protection
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* MIDDLE SECTION: AGENT CARD & INTERACTIVE 3-ACT DEMO CONTROLLER */}
      {/* -------------------------------------------------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: '20px', marginBottom: '28px' }}>
        
        {/* Active Agent Profile Card */}
        <div className="glass-panel" style={{ padding: '22px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ background: 'rgba(99, 102, 241, 0.2)', padding: '8px', borderRadius: '10px' }}>
                <Building size={20} color="#818cf8" />
              </div>
              <div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>{activeAgent.name}</h3>
                <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  ID: {activeAgent.id ? `${activeAgent.id.substring(0, 13)}...` : 'Default'}
                </span>
              </div>
            </div>
            <button onClick={handleReset} className="btn-secondary" style={{ fontSize: '0.75rem', padding: '5px 10px' }}>
              <RotateCcw size={12} /> Reset
            </button>
          </div>

          {/* Budget Gauge */}
          <div style={{ marginBottom: '18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '0.85rem' }}>
              <span style={{ color: 'var(--text-muted)' }}>Budget Remaining</span>
              <span className="mono" style={{ fontWeight: 700, color: budgetRemaining < 10000 ? '#fb7185' : '#34d399' }}>
                ₹{budgetRemaining.toLocaleString('en-IN')} / ₹{budgetTotal.toLocaleString('en-IN')}
              </span>
            </div>
            <div style={{ width: '100%', height: '10px', background: 'rgba(255,255,255,0.06)', borderRadius: '9999px', overflow: 'hidden' }}>
              <div style={{
                width: `${budgetPercent}%`,
                height: '100%',
                background: budgetPercent < 25 ? '#f43f5e' : budgetPercent < 60 ? '#f59e0b' : 'linear-gradient(90deg, #6366f1, #10b981)',
                transition: 'width 0.5s ease-in-out'
              }} />
            </div>
          </div>

          {/* Whitelisted Merchants */}
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Whitelisted Merchants
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {activeAgent.allowed_merchants?.map((m, idx) => (
                <span key={idx} style={{
                  fontSize: '0.75rem',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)'
                }}>
                  ✓ {m}
                </span>
              ))}
            </div>
          </div>

          {/* Velocity Limit */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-muted)', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)' }}>
            <span>Velocity Guardrail:</span>
            <span className="mono" style={{ color: 'var(--text-primary)' }}>{activeAgent.velocity_limit || 5} transactions / hour</span>
          </div>
        </div>

        {/* 3-Act Demo Controller & Interactive Sandbox */}
        <div className="glass-panel" style={{ padding: '22px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={18} color="#38bdf8" />
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Live Demo Controller & Sandbox</h3>
            </div>
            {demoActionStatus && (
              <span className="badge badge-webhook" style={{ fontSize: '0.75rem' }}>
                {demoActionStatus}
              </span>
            )}
          </div>

          {/* 3 Acts Trigger Buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '18px' }}>
            {/* Act 1 Button */}
            <button
              onClick={() => triggerDemoAct(1)}
              disabled={isSubmitting}
              className="btn-secondary"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '12px',
                textAlign: 'left',
                borderLeft: '3px solid #10b981'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.82rem', color: '#34d399' }}>
                <Play size={12} fill="#34d399" /> ACT 1: Happy Path
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Hotel Vendor A (₹12,000) → Allow + Payment
              </div>
            </button>

            {/* Act 2 Button */}
            <button
              onClick={() => triggerDemoAct(2)}
              disabled={isSubmitting}
              className="btn-secondary"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '12px',
                textAlign: 'left',
                borderLeft: '3px solid #f43f5e'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.82rem', color: '#fb7185' }}>
                <ShieldAlert size={12} /> ACT 2: Blocked Path
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Presidential Suite (₹75,000) → Denied
              </div>
            </button>

            {/* Act 3 Button */}
            <button
              onClick={() => triggerDemoAct(3)}
              disabled={isSubmitting}
              className="btn-secondary"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '12px',
                textAlign: 'left',
                borderLeft: '3px solid #d946ef'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.82rem', color: '#e879f9' }}>
                <Zap size={12} /> ACT 3: Duplicate/Race
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Simultaneous Replay → Blocked
              </div>
            </button>
          </div>

          {/* Custom Buyer Agent Natural Language Input */}
          <form onSubmit={handleCustomPromptSubmit} style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              placeholder="Or type natural language buyer prompt (e.g. 'Book a cab with Cab Vendor B for ₹1,800')"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid var(--border-subtle)',
                color: '#ffffff',
                fontSize: '0.85rem',
                outline: 'none'
              }}
            />
            <button
              type="submit"
              disabled={isSubmitting || !customPrompt.trim()}
              className="btn-primary"
              style={{ fontSize: '0.85rem', padding: '8px 16px' }}
            >
              <Send size={14} /> Send
            </button>
          </form>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* AUDIT TRAIL STREAM */}
      {/* -------------------------------------------------------------------- */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Live Firewall Audit Trail</h2>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              Real-time cryptographic audit log of all agent requests, deterministic policy checks, payment dispatches, and webhooks.
            </p>
          </div>

          {/* Filter Tabs */}
          <div style={{ display: 'flex', gap: '6px', background: 'rgba(0,0,0,0.3)', padding: '4px', borderRadius: '8px' }}>
            {[
              { id: 'all', label: 'All Events' },
              { id: 'allowed', label: 'Allowed' },
              { id: 'denied', label: 'Denied' },
              { id: 'blocked', label: 'Duplicates Blocked' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  background: activeTab === tab.id ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: activeTab === tab.id ? '#ffffff' : 'var(--text-muted)',
                  transition: 'all 0.2s ease'
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Audit Log Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                <th style={{ padding: '10px 14px' }}>Timestamp</th>
                <th style={{ padding: '10px 14px' }}>Event</th>
                <th style={{ padding: '10px 14px' }}>Agent / Merchant</th>
                <th style={{ padding: '10px 14px' }}>Amount</th>
                <th style={{ padding: '10px 14px' }}>Firewall Decision / Reason</th>
                <th style={{ padding: '10px 14px' }}>Razorpay Order</th>
                <th style={{ padding: '10px 14px' }}>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                    No audit logs recorded yet. Trigger one of the demo acts above!
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => {
                  const eventType = log.event_type;
                  const tx = log.transactions || {};
                  const detail = log.detail || {};
                  const time = new Date(log.created_at).toLocaleTimeString();
                  
                  const isAllow = eventType === 'POLICY_EVALUATED' && detail.decision === 'ALLOW';
                  const isDeny = eventType === 'DENIED';
                  const isBlocked = eventType === 'DUPLICATE_BLOCKED';
                  const isWebhook = eventType === 'WEBHOOK_RECEIVED';
                  const isPayment = eventType === 'PAYMENT_CREATED';
                  const isAgentReq = eventType === 'AGENT_REQUESTED';

                  let badgeClass = 'badge-agent';
                  if (isAllow) badgeClass = 'badge-allow';
                  if (isDeny) badgeClass = 'badge-deny';
                  if (isBlocked) badgeClass = 'badge-blocked';
                  if (isWebhook) badgeClass = 'badge-webhook';
                  if (isPayment) badgeClass = 'badge-allow';

                  const amount = detail.amount || tx.amount || detail.extracted_intent?.amount || '-';
                  const merchant = detail.merchant || tx.merchant || detail.extracted_intent?.merchant || '-';
                  const razorpayId = detail.razorpay_id || tx.razorpay_order_id || '-';

                  return (
                    <tr
                      key={log.id}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        transition: 'background 0.15s ease'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }} className="mono">
                        <span style={{ color: 'var(--text-muted)' }}>{time}</span>
                      </td>

                      <td style={{ padding: '12px 14px' }}>
                        <span className={`badge ${badgeClass}`}>
                          {eventType}
                        </span>
                      </td>

                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ fontWeight: 600 }}>{merchant}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {tx.agents?.name || 'TravelBot Agent'}
                        </div>
                      </td>

                      <td style={{ padding: '12px 14px' }} className="mono">
                        {amount !== '-' ? (
                          <span style={{ fontWeight: 700, color: isDeny ? '#fb7185' : '#f8fafc' }}>
                            ₹{Number(amount).toLocaleString('en-IN')}
                          </span>
                        ) : '-'}
                      </td>

                      <td style={{ padding: '12px 14px' }}>
                        {isAllow && <span style={{ color: '#34d399', fontWeight: 600 }}>✅ ALLOWED (Policy Passed)</span>}
                        {isDeny && <span style={{ color: '#fb7185', fontWeight: 600 }}>❌ {detail.reason || tx.reason || 'DENIED'}</span>}
                        {isBlocked && <span style={{ color: '#e879f9', fontWeight: 600 }}>🛡️ DUPLICATE REPLAY BLOCKED</span>}
                        {isPayment && <span style={{ color: '#38bdf8' }}>💳 Order Created on Razorpay</span>}
                        {isWebhook && <span style={{ color: '#38bdf8' }}>⚡ Webhook Captured ({detail.target_status || 'SUCCESS'})</span>}
                        {isAgentReq && <span style={{ color: 'var(--text-muted)' }}>🤖 Extracted Intent from prompt</span>}
                      </td>

                      <td style={{ padding: '12px 14px' }} className="mono">
                        {razorpayId !== '-' ? (
                          <span style={{ color: '#a855f7', fontSize: '0.8rem' }}>
                            {razorpayId}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>N/A (Blocked)</span>
                        )}
                      </td>

                      <td style={{ padding: '12px 14px' }}>
                        <button
                          onClick={() => setSelectedLog(log)}
                          className="btn-secondary"
                          style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* DETAIL MODAL / DRAWER */}
      {/* -------------------------------------------------------------------- */}
      {selectedLog && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(6px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div className="glass-panel" style={{
            maxWidth: '650px',
            width: '100%',
            maxHeight: '85vh',
            overflowY: 'auto',
            padding: '24px',
            background: '#0f1422',
            border: '1px solid rgba(255,255,255,0.15)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <span className="badge badge-agent" style={{ marginBottom: '6px' }}>
                  {selectedLog.event_type}
                </span>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 700 }}>Audit Event Inspection</h3>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="btn-secondary"
                style={{ fontSize: '0.8rem', padding: '4px 10px' }}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ marginBottom: '14px', fontSize: '0.85rem' }}>
              <div style={{ color: 'var(--text-muted)' }}>Event ID: <span className="mono" style={{ color: '#fff' }}>{selectedLog.id}</span></div>
              <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>Recorded At: <span className="mono" style={{ color: '#fff' }}>{new Date(selectedLog.created_at).toISOString()}</span></div>
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
              Raw Event Payload (JSON):
            </div>
            <pre style={{
              background: '#080b11',
              padding: '14px',
              borderRadius: '8px',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.78rem',
              color: '#38bdf8',
              overflowX: 'auto'
            }} className="mono">
              {JSON.stringify(selectedLog, null, 2)}
            </pre>
          </div>
        </div>
      )}

    </div>
  );
}
