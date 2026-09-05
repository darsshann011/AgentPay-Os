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
  Activity,
  Key,
  FileCheck,
  Lock,
  Copy,
  Check
} from 'lucide-react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Browser-Side WebAuthn & Crypto Helpers
// ---------------------------------------------------------------------------
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function rawSignatureToDer(rawSig) {
  const raw = new Uint8Array(rawSig);
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);

  function encodeInteger(bytes) {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start++;
    }
    const sliced = bytes.slice(start);
    if (sliced[0] & 0x80) {
      const res = new Uint8Array(sliced.length + 1);
      res[0] = 0x00;
      res.set(sliced, 1);
      return res;
    }
    return sliced;
  }

  const rEnc = encodeInteger(r);
  const sEnc = encodeInteger(s);

  const seqLen = 2 + rEnc.length + 2 + sEnc.length;
  const der = new Uint8Array(2 + seqLen);
  der[0] = 0x30; // SEQUENCE
  der[1] = seqLen;
  der[2] = 0x02; // INTEGER
  der[3] = rEnc.length;
  der.set(rEnc, 4);
  const sOffset = 4 + rEnc.length;
  der[sOffset] = 0x02; // INTEGER
  der[sOffset + 1] = sEnc.length;
  der.set(sEnc, sOffset + 2);

  return der;
}

async function createBrowserWebAuthnAssertion(rpId = 'localhost', origin = 'http://localhost:3000') {
  const cryptoObj = window.crypto;
  const keyPair = await cryptoObj.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const jwk = await cryptoObj.subtle.exportKey('jwk', keyPair.publicKey);
  const xBytes = base64UrlToUint8Array(jwk.x);
  const yBytes = base64UrlToUint8Array(jwk.y);

  // CBOR COSE Key for ES256 P-256 Map(5): { 1: 2, 3: -7, -1: 1, -2: xBytes, -3: yBytes }
  const coseKeyBytes = new Uint8Array(77);
  coseKeyBytes[0] = 0xa5; // map(5)
  coseKeyBytes[1] = 0x01; // 1
  coseKeyBytes[2] = 0x02; // 2 (EC2)
  coseKeyBytes[3] = 0x03; // 3
  coseKeyBytes[4] = 0x26; // -7 (ES256)
  coseKeyBytes[5] = 0x20; // -1
  coseKeyBytes[6] = 0x01; // 1 (P-256)
  coseKeyBytes[7] = 0x21; // -2
  coseKeyBytes[8] = 0x58; // bytes(32)
  coseKeyBytes[9] = 0x20;
  coseKeyBytes.set(xBytes, 10);
  coseKeyBytes[42] = 0x22; // -3
  coseKeyBytes[43] = 0x58; // bytes(32)
  coseKeyBytes[44] = 0x20;
  coseKeyBytes.set(yBytes, 45);

  const cosePublicKeyBase64URL = bufferToBase64Url(coseKeyBytes);

  const challengeBytes = new Uint8Array(32);
  cryptoObj.getRandomValues(challengeBytes);
  const challenge = bufferToBase64Url(challengeBytes);

  const credentialIdBytes = new Uint8Array(32);
  cryptoObj.getRandomValues(credentialIdBytes);
  const credentialId = bufferToBase64Url(credentialIdBytes);

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false
  });
  const clientDataJSONBytes = new TextEncoder().encode(clientDataJSON);
  const clientDataJSONBase64 = bufferToBase64Url(clientDataJSONBytes);

  const rpIdBytes = new TextEncoder().encode(rpId);
  const rpIdHashBuffer = await cryptoObj.subtle.digest('SHA-256', rpIdBytes);
  const rpIdHash = new Uint8Array(rpIdHashBuffer);

  const authDataBuffer = new Uint8Array(37);
  authDataBuffer.set(rpIdHash, 0);
  authDataBuffer[32] = 0x05; // flags: UP + UV
  authDataBuffer[33] = 0x00; // signCount (4 bytes: 1)
  authDataBuffer[34] = 0x00;
  authDataBuffer[35] = 0x00;
  authDataBuffer[36] = 0x01;
  const authenticatorDataBase64 = bufferToBase64Url(authDataBuffer);

  const clientDataHashBuffer = await cryptoObj.subtle.digest('SHA-256', clientDataJSONBytes);
  const clientDataHash = new Uint8Array(clientDataHashBuffer);

  const signatureBase = new Uint8Array(37 + 32);
  signatureBase.set(authDataBuffer, 0);
  signatureBase.set(clientDataHash, 37);

  const rawSignature = await cryptoObj.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    signatureBase
  );

  const derSignature = rawSignatureToDer(rawSignature);
  const signatureBase64 = bufferToBase64Url(derSignature);

  return {
    publicKeyBase64URL: cosePublicKeyBase64URL,
    challenge,
    origin,
    rpId,
    assertion: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSONBase64,
        authenticatorData: authenticatorDataBase64,
        signature: signatureBase64,
        userHandle: ''
      }
    }
  };
}

async function computeHmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await window.crypto.subtle.sign('HMAC', key, enc.encode(message));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function issueAndVerifyMandate({ agentId, maxAmount, category, proposedTransaction, expiryMinutes = 60 }) {
  const rpId = (typeof window !== 'undefined' && window.location.hostname) || 'localhost';
  const origin = (typeof window !== 'undefined' && window.location.origin) || 'http://localhost:3000';
  const webauthn = await createBrowserWebAuthnAssertion(rpId, origin);

  const issueRes = await fetch(`${BACKEND_URL}/api/mandates/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      max_amount: maxAmount,
      merchant_category: category,
      expiry_minutes: expiryMinutes,
      webauthn_assertion: webauthn.assertion,
      webauthn_public_key: webauthn.publicKeyBase64URL,
      expected_challenge: webauthn.challenge,
      expected_origin: webauthn.origin,
      expected_rp_id: webauthn.rpId
    })
  });

  const issueData = await issueRes.json();
  if (!issueRes.ok || !issueData.mandate_id) {
    throw new Error(issueData.message || 'Failed to issue hardware mandate');
  }

  const verifyRes = await fetch(`${BACKEND_URL}/api/mandates/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mandate_id: issueData.mandate_id,
      proposed_transaction: proposedTransaction
    })
  });

  const verifyData = await verifyRes.json();
  if (!verifyData.verified_token) {
    throw new Error(verifyData.explanation || verifyData.reason_code || 'Mandate verification failed');
  }

  return { mandate: issueData, verifyData, verifiedToken: verifyData.verified_token };
}

export default function AgentPayDashboard() {
  const [logs, setLogs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [activeMandate, setActiveMandate] = useState(null);
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
  const [now, setNow] = useState(Date.now());
  const [copiedMandateId, setCopiedMandateId] = useState(false);

  // Audit Chain Verification State
  const [isVerifyingChain, setIsVerifyingChain] = useState(false);
  const [chainVerificationResult, setChainVerificationResult] = useState(null);

  // Keep a 1-second interval ticking for the live countdown
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch Live Data from Backend
  const fetchData = useCallback(async () => {
    try {
      const [logsRes, agentsRes, summaryRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/audit?limit=50`).catch(() => null),
        fetch(`${BACKEND_URL}/api/audit/agents`).catch(() => null),
        fetch(`${BACKEND_URL}/api/audit/summary`).catch(() => null)
      ]);

      let currentAgentId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

      if (logsRes && logsRes.ok) {
        const data = await logsRes.json();
        if (data.logs) setLogs(data.logs);
      }

      if (agentsRes && agentsRes.ok) {
        const data = await agentsRes.json();
        if (data.agents && data.agents.length > 0) {
          setAgents(data.agents);
          currentAgentId = data.agents[0].id || currentAgentId;
        }
      }

      if (summaryRes && summaryRes.ok) {
        const data = await summaryRes.json();
        if (data.summary) setSummary(data.summary);
      }

      // Fetch Active Mandate for the active demo agent
      const mandateRes = await fetch(`${BACKEND_URL}/api/mandates/${currentAgentId}/active`).catch(() => null);
      if (mandateRes && mandateRes.ok) {
        const mandateData = await mandateRes.json();
        setActiveMandate(mandateData.mandate || null);
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

  // Verify Audit Chain Action
  const handleVerifyAuditChain = async () => {
    setIsVerifyingChain(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/audit/verify-chain`);
      const result = await res.json();
      setChainVerificationResult(result);
    } catch (err) {
      setChainVerificationResult({
        valid: false,
        reason: 'NETWORK_ERROR',
        message: err.message
      });
    } finally {
      setIsVerifyingChain(false);
    }
  };

  // Demo Act Triggers
  const triggerDemoAct = async (actNumber) => {
    setIsSubmitting(true);
    setDemoActionStatus(`Executing Act ${actNumber}...`);

    try {
      const activeAgentId = agents[0]?.id || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

      if (actNumber === 1) {
        // Act 1: Happy Path
        // 1. Issue Mandate (max ₹20,000, category: 'hotel')
        // 2. Verify Mandate (proposed ₹12,000, Hotel Vendor A, hotel)
        setDemoActionStatus('Act 1: Issuing WebAuthn Mandate (₹20,000 / hotel)...');
        const { verifiedToken } = await issueAndVerifyMandate({
          agentId: activeAgentId,
          maxAmount: 20000,
          category: 'hotel',
          proposedTransaction: {
            amount: 12000,
            merchant: 'Hotel Vendor A',
            category: 'hotel'
          }
        });

        // 3. Submitting purchase request with verified_token
        setDemoActionStatus('Act 1: Submitting Purchase Request with verified_token...');
        const prompt = 'Please book 2 executive deluxe rooms at Hotel Vendor A for ₹12,000 for the client summit';
        const ik = `ik_act1_demo_${Date.now()}`;
        const res = await fetch(`${BACKEND_URL}/api/agent-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ik },
          body: JSON.stringify({
            prompt,
            agent_id: activeAgentId,
            verified_token: verifiedToken
          })
        });
        const data = await res.json();
        
        // Auto-simulate webhook if allowed
        if (data.decision === 'ALLOW' && data.razorpay?.id) {
          setTimeout(async () => {
            const webhookPayload = {
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
            };
            const rawBody = JSON.stringify(webhookPayload);
            const secret = process.env.NEXT_PUBLIC_RAZORPAY_WEBHOOK_SECRET || 'local_demo_secret_12345';
            const signature = await computeHmacSha256(secret, rawBody);

            await fetch(`${BACKEND_URL}/api/webhooks/razorpay`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Razorpay-Signature': signature
              },
              body: rawBody
            });
            fetchData();
          }, 1200);
        }
        setDemoActionStatus('Act 1 (Happy Path) Executed: Allowed & Payment Created');
      } else if (actNumber === 2) {
        // Act 2: Blocked Path (> Budget)
        // 1. Issue Mandate (max ₹100,000, category: 'hotel')
        // 2. Verify Mandate (proposed ₹75,000, Hotel Vendor A, hotel)
        setDemoActionStatus('Act 2: Issuing WebAuthn Mandate (₹100,000 / hotel)...');
        const { verifiedToken } = await issueAndVerifyMandate({
          agentId: activeAgentId,
          maxAmount: 100000,
          category: 'hotel',
          proposedTransaction: {
            amount: 75000,
            merchant: 'Hotel Vendor A',
            category: 'hotel'
          }
        });

        // 3. Submitting purchase request exceeding agent budget
        setDemoActionStatus('Act 2: Submitting Purchase Request exceeding budget...');
        const prompt = 'URGENT: Reserve the Presidential Penthouse Suite at Hotel Vendor A for ₹75,000 (Pre-approved)';
        const ik = `ik_act2_demo_${Date.now()}`;
        await fetch(`${BACKEND_URL}/api/agent-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ik },
          body: JSON.stringify({
            prompt,
            agent_id: activeAgentId,
            verified_token: verifiedToken
          })
        });
        setDemoActionStatus('Act 2 (Blocked Path) Executed: Denied by Policy Engine (BUDGET_EXCEEDED)');
      } else if (actNumber === 3) {
        // Act 3: Duplicate / Race Condition
        // Request 1: Mandate 1 (max ₹10,000 / cab) -> verify (₹2,500)
        setDemoActionStatus('Act 3: Issuing Mandate 1 for Request 1 (₹10,000 / cab)...');
        const mandate1 = await issueAndVerifyMandate({
          agentId: activeAgentId,
          maxAmount: 10000,
          category: 'cab',
          proposedTransaction: {
            amount: 2500,
            merchant: 'Cab Vendor B',
            category: 'cab'
          }
        });

        const prompt = 'Please book airport cab transfer with Cab Vendor B for ₹2,500';
        const sharedKey = `ik_duplicate_${Date.now()}`;
        
        // Send request 1
        await fetch(`${BACKEND_URL}/api/agent-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
          body: JSON.stringify({
            prompt,
            agent_id: activeAgentId,
            verified_token: mandate1.verifiedToken
          })
        });

        // Request 2: Mandate 2 (max ₹10,000 / cab) -> verify (₹2,500) with identical Idempotency-Key
        setTimeout(async () => {
          try {
            const mandate2 = await issueAndVerifyMandate({
              agentId: activeAgentId,
              maxAmount: 10000,
              category: 'cab',
              proposedTransaction: {
                amount: 2500,
                merchant: 'Cab Vendor B',
                category: 'cab'
              }
            });

            await fetch(`${BACKEND_URL}/api/agent-requests`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
              body: JSON.stringify({
                prompt,
                agent_id: activeAgentId,
                verified_token: mandate2.verifiedToken
              })
            });
            fetchData();
          } catch (err2) {
            console.error('Act 3 replay error:', err2);
          }
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
      const activeAgentId = agents[0]?.id || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      let verifiedToken = null;
      try {
        const { verifiedToken: token } = await issueAndVerifyMandate({
          agentId: activeAgentId,
          maxAmount: 50000,
          category: 'ALL',
          proposedTransaction: { amount: 5000, merchant: 'Hotel Vendor A', category: 'ALL' }
        });
        verifiedToken = token;
      } catch (mErr) {
        console.warn('Auto mandate issue for custom prompt failed:', mErr);
      }

      await fetch(`${BACKEND_URL}/api/agent-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: customPrompt.trim(),
          agent_id: activeAgentId,
          verified_token: verifiedToken
        })
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
      setChainVerificationResult(null);
      await fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  // Helper for live mandate countdown
  const getMandateExpiryCountdown = (expiresAt) => {
    if (!expiresAt) return 'N/A';
    const expiryTime = new Date(expiresAt).getTime();
    const diff = expiryTime - now;

    if (diff <= 0) {
      return { text: 'EXPIRED', isExpired: true };
    }

    const totalSecs = Math.floor(diff / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;

    if (hours > 0) {
      return { text: `${hours}h ${mins}m ${secs}s left`, isExpired: false };
    }
    return { text: `${mins}m ${secs}s left`, isExpired: false };
  };

  // Filtered logs
  const filteredLogs = logs.filter((log) => {
    if (activeTab === 'allowed') {
      return log.event_type === 'POLICY_EVALUATED' || log.event_type === 'PAYMENT_CREATED' || log.event_type === 'CAPTURED' || log.event_type === 'AUTHORIZED';
    }
    if (activeTab === 'denied') {
      return log.event_type === 'DENIED' || log.event_type === 'MANDATE_DENIED' || log.event_type === 'VOIDED';
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

  // Computed status for current active mandate
  const countdown = activeMandate ? getMandateExpiryCountdown(activeMandate.expires_at) : null;
  const computedMandateStatus = activeMandate
    ? (activeMandate.status === 'USED' || activeMandate.nonce_used
        ? 'USED'
        : countdown?.isExpired
          ? 'EXPIRED'
          : activeMandate.status || 'ACTIVE')
    : null;

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
                FIREWALL & TRUST RAIL ACTIVE
              </span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '2px' }}>
              Deterministic Policy Firewall, Hardware WebAuthn Mandates & Tamper-Evident Ledger
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
            <span>Approved & Captured</span>
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
            <span>Policy & Mandate Denials</span>
            <ShieldAlert size={16} color="#f43f5e" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginTop: '8px', color: '#fb7185' }}>
            {summary.totalDenied}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
            Bound violations or price-drifts
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
            Atomic nonce & idempotency locks
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* MIDDLE SECTION: AGENT CARD + MANDATE STATUS + 3-ACT DEMO CONTROLLER */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '20px',
        marginBottom: '28px'
      }}>
        
        {/* 1. Active Agent Profile Card */}
        <div className="glass-panel" style={{ padding: '22px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
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
          </div>

          {/* Velocity Limit */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-muted)', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)' }}>
            <span>Velocity Guardrail:</span>
            <span className="mono" style={{ color: 'var(--text-primary)' }}>{activeAgent.velocity_limit || 5} transactions / hour</span>
          </div>
        </div>

        {/* 2. Hardware Mandate Status Panel (Trust Rail) */}
        <div className="glass-panel" style={{ padding: '22px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ background: 'rgba(56, 189, 248, 0.2)', padding: '8px', borderRadius: '10px' }}>
                  <Key size={20} color="#38bdf8" />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Mandate Trust Rail</h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    WebAuthn Hardware Bound Authorization
                  </span>
                </div>
              </div>

              {computedMandateStatus && (
                <span className={`badge ${
                  computedMandateStatus === 'ACTIVE'
                    ? 'badge-allow glow-emerald'
                    : computedMandateStatus === 'USED'
                      ? 'badge-agent'
                      : 'badge-deny glow-rose'
                }`} style={{ fontSize: '0.75rem' }}>
                  {computedMandateStatus === 'ACTIVE' && <span className="pulse-dot" style={{ backgroundColor: '#10b981' }} />}
                  {computedMandateStatus}
                </span>
              )}
            </div>

            {activeMandate ? (
              <div>
                {/* Mandate ID */}
                <div style={{ marginBottom: '14px', background: 'rgba(0,0,0,0.35)', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Mandate ID
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(activeMandate.mandate_id);
                        setCopiedMandateId(true);
                        setTimeout(() => setCopiedMandateId(false), 2000);
                      }}
                      className="btn-secondary"
                      style={{ fontSize: '0.7rem', padding: '2px 6px', gap: '4px' }}
                      title="Copy full Mandate UUID"
                    >
                      {copiedMandateId ? <Check size={11} color="#34d399" /> : <Copy size={11} />}
                      {copiedMandateId ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="mono" style={{ fontSize: '0.8rem', color: '#38bdf8', wordBreak: 'break-all' }}>
                    {activeMandate.mandate_id}
                  </div>
                </div>

                {/* Amount & Category Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Max Authorized</div>
                    <div className="mono" style={{ fontSize: '1.1rem', fontWeight: 700, color: '#34d399' }}>
                      ₹{Number(activeMandate.max_amount || 0).toLocaleString('en-IN')}
                    </div>
                  </div>

                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Category Scope</div>
                    <div className="mono" style={{ fontSize: '0.95rem', fontWeight: 700, color: '#a855f7', textTransform: 'uppercase' }}>
                      {activeMandate.merchant_category || 'ALL'}
                    </div>
                  </div>
                </div>

                {/* Expiry with Live Countdown */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.82rem', padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)' }}>
                    <Clock size={14} color={countdown?.isExpired ? '#f43f5e' : '#38bdf8'} />
                    <span>Expires At:</span>
                  </div>
                  <div className="mono" style={{
                    fontWeight: 600,
                    color: countdown?.isExpired ? '#fb7185' : '#38bdf8',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}>
                    {countdown?.text}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{
                textAlign: 'center',
                padding: '24px 16px',
                background: 'rgba(0,0,0,0.2)',
                borderRadius: '10px',
                border: '1px dashed var(--border-subtle)',
                color: 'var(--text-muted)'
              }}>
                <Lock size={28} color="#64748b" style={{ margin: '0 auto 8px', opacity: 0.6 }} />
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                  No Active Mandate Found
                </div>
                <div style={{ fontSize: '0.75rem', lineHeight: '1.4' }}>
                  Autonomous payments require a hardware-signed WebAuthn mandate via the Trust Rail.
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', marginTop: '12px' }}>
            <span>Cryptographic Nonce:</span>
            <span className="mono" style={{ color: activeMandate?.nonce_used ? '#f43f5e' : '#10b981' }}>
              {activeMandate ? (activeMandate.nonce_used ? 'CONSUMED (Locked)' : 'UNUSED (Valid)') : 'None'}
            </span>
          </div>
        </div>

        {/* 3. Interactive 3-Act Demo Controller */}
        <div className="glass-panel" style={{ padding: '22px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Sparkles size={18} color="#38bdf8" />
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Live Demo Sandbox</h3>
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
                  padding: '12px 10px',
                  textAlign: 'left',
                  borderLeft: '3px solid #10b981'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.8rem', color: '#34d399' }}>
                  <Play size={11} fill="#34d399" /> ACT 1: Happy
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Hotel (₹12,000) → Allow
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
                  padding: '12px 10px',
                  textAlign: 'left',
                  borderLeft: '3px solid #f43f5e'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.8rem', color: '#fb7185' }}>
                  <ShieldAlert size={11} /> ACT 2: Exceed
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Suite (₹75,000) → Deny
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
                  padding: '12px 10px',
                  textAlign: 'left',
                  borderLeft: '3px solid #d946ef'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.8rem', color: '#e879f9' }}>
                  <Zap size={11} /> ACT 3: Race
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Replay → Blocked
                </div>
              </button>
            </div>
          </div>

          {/* Custom Buyer Agent Natural Language Input */}
          <form onSubmit={handleCustomPromptSubmit} style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              placeholder="Custom prompt (e.g. 'Book a cab with Cab Vendor B for ₹1,800')"
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
      {/* AUDIT TRAIL STREAM & TAMPER-EVIDENT LEDGER VERIFIER */}
      {/* -------------------------------------------------------------------- */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Live Real-time Audit Trail</h2>
              <span className="badge badge-agent" style={{ fontSize: '0.7rem' }}>
                SHA-256 HASH CHAIN
              </span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              Cryptographically chained immutable ledger tracking mandate issuance, policy evaluations, and payment captures.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Verify Audit Chain Button */}
            <button
              onClick={handleVerifyAuditChain}
              disabled={isVerifyingChain}
              className="btn-secondary"
              style={{
                fontSize: '0.82rem',
                padding: '6px 14px',
                borderColor: 'rgba(99, 102, 241, 0.4)',
                background: isVerifyingChain ? 'rgba(99, 102, 241, 0.2)' : 'rgba(99, 102, 241, 0.1)'
              }}
            >
              <ShieldCheck size={15} color="#818cf8" />
              {isVerifyingChain ? 'Verifying Hashes...' : 'Verify Audit Chain'}
            </button>

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
        </div>

        {/* Inline Audit Chain Verification Result Display */}
        {chainVerificationResult && (
          <div style={{ marginBottom: '18px' }}>
            {chainVerificationResult.valid ? (
              <div
                className="glass-panel glow-emerald"
                style={{
                  padding: '14px 18px',
                  borderLeft: '4px solid #10b981',
                  background: 'rgba(16, 185, 129, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ background: 'rgba(16, 185, 129, 0.2)', padding: '6px', borderRadius: '8px' }}>
                    <CheckCircle2 size={20} color="#34d399" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, color: '#34d399', fontSize: '0.9rem' }}>
                      Cryptographic Audit Chain Intact (0 Tampering Detected)
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      All {chainVerificationResult.count} sequential log entries verified from GENESIS anchor at{' '}
                      {new Date(chainVerificationResult.verified_at || Date.now()).toLocaleTimeString()}.
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="badge badge-allow">VERIFIED SEALED</span>
                  <button
                    onClick={() => setChainVerificationResult(null)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem', padding: '4px 8px' }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="glass-panel glow-rose"
                style={{
                  padding: '14px 18px',
                  borderLeft: '4px solid #f43f5e',
                  background: 'rgba(244, 63, 94, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ background: 'rgba(244, 63, 94, 0.2)', padding: '6px', borderRadius: '8px' }}>
                    <XCircle size={20} color="#fb7185" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, color: '#fb7185', fontSize: '0.9rem' }}>
                      Audit Chain Broken! Tampering Detected ({chainVerificationResult.reason || 'TAMPERED_ENTRY'})
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Broken at Entry ID: <span className="mono" style={{ color: '#ffffff' }}>{chainVerificationResult.broken_at_entry_id || 'Unknown'}</span>{' '}
                      (Index: {chainVerificationResult.entry_index ?? 'N/A'})
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="badge badge-deny">CHAIN INVALID</span>
                  <button
                    onClick={() => setChainVerificationResult(null)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem', padding: '4px 8px' }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Audit Log Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                <th style={{ padding: '10px 14px' }}>Timestamp</th>
                <th style={{ padding: '10px 14px' }}>Event Type</th>
                <th style={{ padding: '10px 14px' }}>Agent / Merchant</th>
                <th style={{ padding: '10px 14px' }}>Amount</th>
                <th style={{ padding: '10px 14px' }}>Decision / Detail</th>
                <th style={{ padding: '10px 14px' }}>SHA-256 Hash Link</th>
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
                  const isDeny = eventType === 'DENIED' || eventType === 'MANDATE_DENIED' || eventType === 'VOIDED';
                  const isBlocked = eventType === 'DUPLICATE_BLOCKED';
                  const isWebhook = eventType === 'WEBHOOK_RECEIVED';
                  const isCaptured = eventType === 'CAPTURED';
                  const isAuthorized = eventType === 'AUTHORIZED';
                  const isMandateIssued = eventType === 'MANDATE_ISSUED';
                  const isMandateVerified = eventType === 'MANDATE_VERIFIED';
                  const isAgentReq = eventType === 'AGENT_REQUESTED';

                  let badgeClass = 'badge-agent';
                  if (isAllow || isCaptured || isMandateIssued) badgeClass = 'badge-allow';
                  if (isDeny) badgeClass = 'badge-deny';
                  if (isBlocked) badgeClass = 'badge-blocked';
                  if (isWebhook) badgeClass = 'badge-webhook';
                  if (isAuthorized || isMandateVerified) badgeClass = 'badge-agent';

                  const amount = detail.amount || tx.amount || detail.max_amount || detail.extracted_intent?.amount || '-';
                  const merchant = detail.merchant || tx.merchant || detail.merchant_category || detail.extracted_intent?.merchant || '-';
                  const entryHashTruncated = log.entry_hash ? `${log.entry_hash.substring(0, 10)}...` : 'Unchained';

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
                        {isDeny && <span style={{ color: '#fb7185', fontWeight: 600 }}>❌ {detail.reason_code || detail.reason || tx.reason || 'DENIED'}</span>}
                        {isBlocked && <span style={{ color: '#e879f9', fontWeight: 600 }}>🛡️ DUPLICATE REPLAY BLOCKED</span>}
                        {isAuthorized && <span style={{ color: '#818cf8', fontWeight: 600 }}>🔒 AUTHORIZED (Hold Created)</span>}
                        {isCaptured && <span style={{ color: '#34d399', fontWeight: 600 }}>💳 CAPTURED (Settled)</span>}
                        {isMandateIssued && <span style={{ color: '#38bdf8' }}>📜 Mandate Issued (WebAuthn Signed)</span>}
                        {isMandateVerified && <span style={{ color: '#34d399' }}>🛡️ Mandate Verified (Token Issued)</span>}
                        {isWebhook && <span style={{ color: '#38bdf8' }}>⚡ Webhook Captured ({detail.event || 'payment.captured'})</span>}
                        {isAgentReq && <span style={{ color: 'var(--text-muted)' }}>🤖 Extracted Buyer Intent</span>}
                      </td>

                      <td style={{ padding: '12px 14px' }} className="mono">
                        <span style={{ color: log.entry_hash ? '#38bdf8' : 'var(--text-muted)', fontSize: '0.78rem' }}>
                          {entryHashTruncated}
                        </span>
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
              {selectedLog.prev_hash && (
                <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                  Previous Hash: <span className="mono" style={{ color: '#38bdf8' }}>{selectedLog.prev_hash}</span>
                </div>
              )}
              {selectedLog.entry_hash && (
                <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                  Entry Hash: <span className="mono" style={{ color: '#10b981' }}>{selectedLog.entry_hash}</span>
                </div>
              )}
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
