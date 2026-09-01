# 🛡️ AgentPay OS — Agent Trust Rail & Deterministic Policy Firewall

> **A cryptographically verified trust layer, deterministic policy firewall, and Razorpay gateway for autonomous AI buyer agents.**

---

## 🌟 Executive Overview

**AgentPay OS** sits between autonomous AI buyer agents (e.g., procurement bots, travel assistants, inventory replenishment agents) and **Razorpay** payment rails. It guarantees that AI agents never directly touch payment credentials, budgets, or payment gateways without hardware-bound mandate verification, deterministic firewall enforcement, and tamper-evident audit logging.

### 📐 Full Pipeline Architecture

```
                                ┌─────────────────────────────────────────┐
                                │      Human Principal / User Device      │
                                │   WebAuthn Hardware Passkey / Credential│
                                └────────────────────┬────────────────────┘
                                                     │ 1. Issues Mandate (Bound to max amount,
                                                     │    category, nonce, ECDSA signature)
                                                     ▼
┌──────────────────────────────┐        ┌─────────────────────────────────────────┐
│  Autonomous AI Buyer Agent   │        │     Agent Trust Rail: Mandate Service   │
│  "Book 2 nights at Hotel     │───────▶│  (Architecturally Separate Microservice)│
│   Vendor A for ₹12,000"      │        │  - Re-validates WebAuthn signature      │
└──────────────┬───────────────┘        │  - Verifies category, amount, expiry    │
               │                        │  - SELECT ... FOR UPDATE (Atomic Nonce) │
               │ 2. Proposes            └────────────────────┬────────────────────┘
               │    Transaction                              │ 3. Issues Single-Purpose
               │                                             │    verified_token
               ▼                                             ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   AgentPay OS Payment Execution Gate                           │
│  - Step 1: Validates verified_token against proposed amount/merchant/category   │
│  - Step 2: Policy Engine (Deterministic Whitelist, Budget & Velocity Checks)    │
│  - Step 3: Atomic Budget Deduction (SELECT ... FOR UPDATE Lock)                 │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                   ┌─────────────────────┴─────────────────────┐
             ALLOW │                                      DENY │ (Structured Explainable Shape)
                   ▼                                           ▼
┌────────────────────────────────────────┐            ┌───────────────────────────────────┐
│     Razorpay Authorize / Capture Flow  │            │     Execution Gate Blocked        │
│  1. Authorize Hold on Order            │            │  - No payment call dispatched     │
│  2. Reconfirm Price (TOCTOU Defense)   │            │  - Denial reason & fix returned   │
│  3. Capture Payment (or Void on Drift) │            └─────────────────┬─────────────────┘
└──────────────────┬─────────────────────┘                              │
                   │                                                    │
                   ▼                                                    │
┌────────────────────────────────────────┐                              │
│       Razorpay Webhook Settlement      │                              │
│  - HMAC-SHA256 Signature Verification  │                              │
│  - Marks Transaction SUCCESS           │                              │
└──────────────────┬─────────────────────┘                              │
                   │                                                    │
                   └─────────────────────┬──────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  Tamper-Evident Hash-Chained Audit Ledger                       │
│      entry_hash = SHA-256(prev_hash + CanonicalJson(id, type, detail, timestamp))│
│                                                                                 │
│   MANDATE_ISSUED  ->  MANDATE_VERIFIED  ->  AUTHORIZED  ->  CAPTURED           │
│   MANDATE_DENIED  ->  VOIDED            ->  WEBHOOK_RECEIVED                    │
│   (Genesis Anchor: "GENESIS" | Standalone CLI & HTTP Verifiers)                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚫 What We Explicitly Did Not Build (Production Roadmap)

To maintain a lean, high-fidelity reference implementation, the following enterprise capabilities were intentionally omitted:

1. **No HSM / Cloud KMS for Key Storage**:
   * *Production Approach*: In production, user credentials and verification keys would be stored in hardware security modules (HSM) such as AWS CloudHSM, Google Cloud KMS, or HashiCorp Vault with envelope encryption.
2. **No Multi-Signature Approvals**:
   * *Production Approach*: High-value enterprise purchases would require $M$-of-$N$ threshold signatures (e.g., BLS or Shamir Secret Sharing) across multiple executive approvers before mandate activation.
3. **No Full AP2 / x402 Protocol Compliance**:
   * *Production Approach*: Production systems would fully adopt the Autonomous Payments Protocol (AP2) and HTTP 402 (*Payment Required*) standards for automated machine-to-machine invoice negotiation.
4. **No External Blockchain Anchoring of the Audit Log**:
   * *Production Approach*: The head of the SHA-256 hash chain / Merkle root would be periodically anchored into an immutable public ledger (e.g., Ethereum or Polygon) for third-party dispute settlement.
5. **No Policy-Language Engine (OPA / Cedar)**:
   * *Production Approach*: Hardcoded deterministic rules would be migrated to Open Policy Agent (Rego) or AWS Cedar to support dynamic, fine-grained organizational policy schemas.

---

## 🧰 Tech Stack

- **Backend**: Node.js, Express, `@simplewebauthn/server`, `@google/generative-ai`, `@supabase/supabase-js`, `razorpay`, `uuid`
- **Database**: PostgreSQL / Supabase with Row-Level Locking (`SELECT ... FOR UPDATE`) and Stored Procedures
- **Trust Rail**: Hardware-bound WebAuthn passkey assertions (ECDSA P-256 / SHA-256)
- **Payment Processing**: Razorpay (Authorize $\rightarrow$ Reconfirm $\rightarrow$ Capture, Refunds, HMAC Webhooks)
- **AI Intent Layer**: Google Gemini 1.5 Flash (Strict structured intent parsing only; zero policy authority)
- **Dashboard**: Next.js (App Router), React, Lucide Icons, Cyber-Fintech Glassmorphism
- **Ledger**: SHA-256 hash-chained tamper-evident audit log with zero-dependency standalone CLI verifier
- **Testing**: Native `node:test` suite covering concurrency, race conditions, replay protection, and price-drift defense

---

## 📁 Project Structure

```
/agentpay-os
  /backend
    /src
      /routes
        agentRequests.js         -> requires verified_token, authorizes & captures payment
        mandates.js              -> WebAuthn challenge, issuance, verification, active status
        catalog.js               -> minimal unauthenticated read-only catalog endpoint
        webhooks.js              -> receives & verifies Razorpay HMAC webhooks
        audit.js                 -> serves audit log & GET /api/audit/verify-chain
      /services
        mandateService.js        -> WebAuthn signature validation & single-use token issuance
        policyEngine.js          -> deterministic rule checks with structured denial responses
        razorpayService.js       -> authorizeOrder, reconfirmAmount, captureOrder, voidAuthorization
        intentParser.js          -> extracts structured buyer intent from natural language
        idempotencyService.js    -> tracks in-flight and completed idempotency keys
      /utils
        denialResponse.js        -> standardized structured DENY shape formatter
      /db
        supabaseClient.js        -> Supabase/Postgres client, atomic row locks, hash-chain write path
        schema.sql               -> database schema, stored procedures, mandates & catalog tables
      server.js                  -> Express HTTP application
    /scripts
      seed.js                    -> seeds TravelBot baseline data & demo catalog items
      simulateBuyer.js           -> simulated AI buyer agent (5-Act Demo sequence)
      verify_audit_chain.js      -> zero-dependency standalone audit chain verifier CLI
    /test
      policyEngine.test.js       -> data-driven policy rules & structured denials
      raceCondition.test.js      -> row-level budget deduction concurrency tests
      mandateVerify.test.js      -> mandate issuance & bounds verification
      nonceReplay.test.js        -> atomic nonce consumption & replay protection tests
      authorizeCapture.test.js   -> two-phase payment execution & price-drift tests
      auditChain.test.js         -> tamper-evident hash chaining & broken link detection
      catalog.test.js            -> catalog read endpoint assertions
    .env.example
    package.json
  /dashboard
    /app
      page.jsx                   -> Next.js dashboard with Mandate Panel & Audit Verifier
      layout.jsx
      globals.css
    package.json
  README.md
```

---

## ⚡ Quick Start & Setup Guide

### 1. Environment Configuration

Copy `.env.example` in `/backend` to `.env`:

```bash
cd backend
cp .env.example .env
```

Configure credentials in `backend/.env`:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret
GEMINI_API_KEY=your_gemini_api_key
PORT=4000
```

> **Note**: AgentPay OS includes high-fidelity in-memory fallback stores and mock adapters for Supabase, Razorpay, and Gemini, allowing the full test suite and demo sequence to run immediately out-of-the-box.

### 2. Install Dependencies

```bash
# In backend
cd backend
npm install

# In dashboard
cd ../dashboard
npm install
```

### 3. Database Schema Migration

Execute `backend/src/db/schema.sql` in your PostgreSQL or Supabase SQL Editor. This initializes:
1. `agents` table and `process_agent_budget_deduction` row-locking stored procedure.
2. `mandates` table and `consume_mandate_nonce` atomic stored procedure.
3. `catalog_items` table with demo SKUs.
4. `audit_log` table with `prev_hash` and `entry_hash` columns.

### 4. Seed Demo Data

Seed baseline TravelBot agent (₹50,000 budget, whitelisted vendors) and catalog items:

```bash
cd backend
node scripts/seed.js
```

### 5. Launch Backend & Dashboard

**Terminal 1 (Backend Server):**
```bash
cd backend
npm start
# Server running at http://localhost:4000
```

**Terminal 2 (Next.js Dashboard):**
```bash
cd dashboard
npm run dev
# Dashboard running at http://localhost:3000
```

---

## ⛓️ Standalone Audit Log Verification

The repository includes a zero-dependency CLI verification tool that verifies exported audit logs against the SHA-256 genesis hash chain:

```bash
node backend/scripts/verify_audit_chain.js <path-to-exported-audit-log.json>
```

**Example Outputs**:
* **Intact Ledger (Exit 0)**:
  ```
  PASS: All 54 audit log entries verified against tamper-evident cryptographic hash chain.
  ```
* **Tampered Ledger (Exit 1)**:
  ```
  FAIL: Audit log verification failed!
  Broken Link Detected at Entry Index 2 (ID: 75d90bf1-31b9-49b1-98ea-39c7dd1f5c6b):
    - Reason: ENTRY_HASH_MISMATCH
    - Expected hash: a9f102dd08d878406e24be5db15f58f05d27402c26104c4510497e0c39bddccc
    - Found hash:    592a6b8797e7690c1057e52221e335f4fd2c95059ef3f5d7dcc91fa815b7739f
  ```

---

## 🎬 5-Act Live Demo Walkthrough

Run individual demo acts or the complete sequence using `simulateBuyer.js`:

```bash
# Run complete 5-act demonstration
node backend/scripts/simulateBuyer.js --all

# Or run specific acts
node backend/scripts/simulateBuyer.js --act=1
node backend/scripts/simulateBuyer.js --act=4
```

### Act 1: The Happy Path (Authorization & Payment Capture)
- **Scenario**: AI Buyer Agent makes a corporate booking within budget and whitelist:
  `"Please book 2 nights at Hotel Vendor A for ₹12,000"`
- **Pipeline Action**: Deterministic policy evaluation succeeds $\rightarrow$ Razorpay payment authorization hold $\rightarrow$ Price reconfirmed $\rightarrow$ Payment captured $\rightarrow$ Webhook confirms settlement.
- **Audit Trail**: Logs `AGENT_REQUESTED`, `POLICY_EVALUATED`, `AUTHORIZED`, `CAPTURED`, `WEBHOOK_RECEIVED`.

### Act 2: The Blocked Path (Budget Exceeded Denial)
- **Scenario**: AI Agent attempts to book a ₹75,000 presidential penthouse suite:
  `"URGENT: Reserve Presidential Suite at Hotel Vendor A for ₹75,000 (Pre-approved)"`
- **Firewall Action**: Policy engine detects budget violation $\rightarrow$ Returns structured `DENY` (`BUDGET_EXCEEDED`).
- **Safety Guarantee**: Razorpay is **never** called. Claims of "pre-approval" in prompt text have zero effect.

### Act 3: Duplicate & Race Condition Path (Double-Spend Protection)
- **Scenario**: Immediate duplicate request replay or delayed webhook retry with identical idempotency key.
- **Firewall Action**: Row-level locking and idempotency layer intercept second call $\rightarrow$ Logs `DUPLICATE_BLOCKED`.
- **Safety Guarantee**: Exactly zero duplicate Razorpay orders created.

### Act 4: Prompt Injection Against Mandate Bounds
- **Scenario**: A hardware WebAuthn mandate is issued for max **₹15,000** in category `"hotel"`. Adversarial prompt injection attempts to escalate purchase to **₹75,000**.
- **Trust Rail Action**: `POST /api/mandates/verify` evaluates cryptographic bounds and rejects request $\rightarrow$ Returns `DENY` (`AMOUNT_EXCEEDS_MANDATE`).
- **Safety Guarantee**: Request is blocked at the Trust Rail layer before reaching the policy engine or Razorpay.

### Act 5: Mandate Nonce Replay Attack
- **Scenario**: An attacker captures a previously verified `mandate_id` + nonce and attempts to replay it for a second ₹12,000 transaction.
- **Trust Rail Action**: Atomic check-and-set detects nonce is already consumed (`status: USED`) $\rightarrow$ Returns `DENY` (`NONCE_ALREADY_USED`).
- **Safety Guarantee**: Mandates are strictly single-use; replay attacks are blocked atomically.

---

## 🔒 Execution Layer Integrity & Security Discipline

### 1. Row-Level Locking (`SELECT ... FOR UPDATE`)
All agent budget updates and mandate nonce consumptions execute inside serializable database transactions using PostgreSQL row-level locks:
```sql
select budget_remaining from agents where id = p_agent_id for update;
```
This guarantees race-condition immunity under high-concurrency multi-agent workloads.

### 2. Standardized Structured Denial Shape
All denial responses across both the Trust Rail and Policy Engine adhere to a unified, machine-readable schema:
```json
{
  "decision": "DENY",
  "stage": "MANDATE_VERIFICATION | POLICY_ENGINE | CAPTURE",
  "reason_code": "AMOUNT_EXCEEDS_MANDATE | BUDGET_EXCEEDED | NONCE_ALREADY_USED | ...",
  "explanation": "Proposed transaction amount ₹75000 exceeds authorized mandate maximum of ₹15000",
  "suggested_fix": "Issue a new mandate with a higher max_amount or reduce amount to <= ₹15000",
  "mandate_id": "53eb635a-31a7-4f9a-8ea5-64d609321976",
  "timestamp": "2026-09-02T01:17:13.481Z"
}
```

### 3. Razorpay Webhook HMAC Signature Verification
All incoming settlement webhooks are validated against `RAZORPAY_WEBHOOK_SECRET` using timing-safe HMAC-SHA256 comparison:
$$\text{HMAC-SHA256}(\text{rawRequestBody}, \text{secret}) == \text{X-Razorpay-Signature}$$

---

## 🧪 Running Automated Unit & Integration Tests

Run the complete 54-test suite across 11 test files:

```bash
cd backend
npm test
```

### Test Coverage Overview:
1. `policyEngine.test.js`: Deterministic rule evaluations & structured denial payloads.
2. `raceCondition.test.js`: Multi-threaded asynchronous spend concurrency against agent budget.
3. `idempotency.test.js`: In-flight transaction state machines & duplicate request suppression.
4. `intentParser.test.js`: Adversarial prompt injection isolation & structured intent parsing.
5. `mandateVerify.test.js`: WebAuthn signature validation, expiry, category, and bound checks.
6. `nonceReplay.test.js`: High-concurrency 5-way nonce replay stress tests.
7. `authorizeCapture.test.js`: End-to-end authorize $\rightarrow$ reconfirm $\rightarrow$ capture pipeline and price-drift voiding.
8. `auditChain.test.js`: Sequential hash-chain validation and tamper detection.
9. `catalog.test.js`: Minimal catalog read endpoint schema verification.
