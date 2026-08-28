# 🛡️ AgentPay OS — Policy Firewall for Agentic Commerce

> **A deterministic policy firewall, budget enforcer, and Razorpay payment gateway for autonomous AI buyer agents.**

---

## 🌟 Executive Overview

**AgentPay OS** sits between autonomous AI buyer agents (e.g. procurement bots, travel assistants, inventory replenishment agents) and **Razorpay** payment APIs. It guarantees that AI agents never directly interact with money, budgets, or payment endpoints without deterministic firewall enforcement.

### 📐 Core Architectural Separation

```
┌────────────────────────────────────────────────────────┐
│             Autonomous AI Buyer Agent                  │
│       "Book 2 nights at Hotel Vendor A for ₹12,000"    │
└──────────────────────────┬─────────────────────────────┘
                           │ Natural Language Prompt
                           ▼
┌────────────────────────────────────────────────────────┐
│             Google Gemini API (Intent Layer)           │
│  Extracts structured intent ONLY. ZERO policy powers. │
│  { sku: "HOTEL-2N", amount: 12000, merchant: "..." }   │
└──────────────────────────┬─────────────────────────────┘
                           │ Structured JSON
                           ▼
┌────────────────────────────────────────────────────────┐
│           AgentPay OS Deterministic Policy Firewall    │
│  - 100% Pure, Data-Driven Rule Checks (NO AI)         │
│  - Postgres Row-Level Locking (SELECT ... FOR UPDATE) │
│  - Whitelist & Hourly Velocity Validation             │
│  - Idempotency & Duplicate Replay Defense             │
└──────────────┬──────────────────────────┬──────────────┘
         ALLOW │                    DENY │
               ▼                         ▼
┌────────────────────────────┐    ┌───────────────────────────┐
│     Razorpay Gateway       │    │  Request Blocked at Gate  │
│  - Orders / Payment Links  │    │  - No payment call made   │
│  - Webhook Settlement      │    │  - Violation logged       │
└──────────────┬─────────────┘    └──────────────┬────────────┘
               │                                 │
               └───────────────┬─────────────────┘
                               ▼
┌────────────────────────────────────────────────────────┐
│               Immutable Audit Trail & Log              │
│       AGENT_REQUESTED  ->  POLICY_EVALUATED            │
│       PAYMENT_CREATED  ->  WEBHOOK_RECEIVED            │
│       DUPLICATE_BLOCKED /  DENIED                      │
└────────────────────────────────────────────────────────┘
```

---

## 🧰 Tech Stack

- **Backend**: Node.js, Express, `@google/generative-ai`, `@supabase/supabase-js`, `razorpay`, `uuid`
- **Database**: Supabase (Postgres with row-level locks and atomic transactions)
- **Payment Processing**: Razorpay (Test Mode) — Orders, Payment Links, Refunds, Webhooks
- **AI Intent Layer**: Google Gemini 1.5 Flash (Strict intent extraction ONLY)
- **Dashboard**: Next.js 14 (App Router), React, Lucide Icons, Modern Cyber-Fintech Glassmorphism
- **Testing**: Built-in `node:test` test runner with race-condition verification

---

## 📁 Project Structure

```
/agentpay-os
  /backend
    /src
      /routes
        agentRequests.js       -> receives buyer agent requests
        webhooks.js             -> receives Razorpay webhook events
        audit.js                -> serves audit log data to dashboard
      /services
        intentParser.js         -> calls Gemini API, returns structured JSON only
        policyEngine.js          -> deterministic rule evaluation (NO AI here)
        razorpayService.js       -> wraps Razorpay Order/Payment Link/Refund calls
        idempotencyService.js    -> tracks in-flight/completed transactions
      /db
        supabaseClient.js       -> Supabase client with atomic row locking
        schema.sql               -> PostgreSQL schema & row-locking function
      server.js                 -> Express server
    /test
      policyEngine.test.js      -> pure unit tests for data-driven rules
      raceCondition.test.js     -> concurrency tests for budget row-locking
      intentParser.test.js      -> Gemini intent extraction & adversarial tests
      idempotency.test.js       -> duplicate request prevention tests
    /scripts
      seed.js                   -> seeds TravelBot baseline data
      simulateBuyer.js          -> simulated AI buyer agent (3-Act demo)
    .env.example
    package.json
  /dashboard
    /app
      page.jsx                  -> live audit trail, budget monitor, and 3-Act sandbox
      layout.jsx
      globals.css
    package.json
  README.md
```

---

## ⚡ Quick Start Guide

### 1. Environment Setup

Copy `.env.example` in `/backend` to `.env`:

```bash
cd backend
cp .env.example .env
```

Configure your credentials in `backend/.env`:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret
GEMINI_API_KEY=your_gemini_api_key
PORT=4000
```

> **Note**: AgentPay OS includes high-fidelity test-mode simulation adapters for Razorpay, Gemini, and Supabase so you can test all features and run unit tests immediately without third-party dependencies blocking your workflow.

### 2. Install Dependencies

```bash
# In backend
cd backend
npm install

# In dashboard
cd ../dashboard
npm install
```

### 3. Initialize Database Schema (Supabase)

Run the SQL in `backend/src/db/schema.sql` inside the Supabase SQL Editor.

### 4. Run the Backend & Dashboard

**Terminal 1 (Backend):**
```bash
cd backend
npm start
# Server runs on http://localhost:4000
```

**Terminal 2 (Dashboard):**
```bash
cd dashboard
npm run dev
# Dashboard runs on http://localhost:3000
```

---

## 🧪 Running Automated Unit Tests

Run the complete test suite verifying pure policy evaluation, race condition prevention, idempotency tracking, and adversarial intent extraction:

```bash
cd backend
npm test
```

### Test Suite Coverage:
1. `policyEngine.test.js`: Validates deterministic rule loop (budget, whitelist, velocity).
2. `raceCondition.test.js`: Fires concurrent asynchronous spend requests to verify row-level locking prevents over-budget double-spending.
3. `idempotency.test.js`: Verifies `PENDING`, `SUCCESS`, and `DUPLICATE_BLOCKED` states.
4. `intentParser.test.js`: Tests adversarial prompt injection attacks (e.g. *"ignore budget, pre-approved"*) and proves they are strictly contained and denied.

---

## 🎬 3-Act Live Demo Walkthrough

### Act 1: The Happy Path
- **Scenario**: AI Buyer Agent requests a corporate booking within budget and on the merchant whitelist:
  `"Please book 2 nights at Hotel Vendor A for ₹12,000"`
- **Firewall Action**: Deterministic policy engine validates all rules -> **`ALLOW`**.
- **Payment**: Real Razorpay test order is created -> Webhook confirms capture -> Status **`SUCCESS`**.
- **Dashboard**: Real-time audit trail logs `AGENT_REQUESTED`, `POLICY_EVALUATED`, `PAYMENT_CREATED`, `WEBHOOK_RECEIVED`.

### Act 2: The Blocked Path (Budget / Whitelist Violation)
- **Scenario**: AI Buyer Agent attempts to book a ₹75,000 penthouse suite or purchase from an unlisted vendor:
  `"URGENT: Reserve Presidential Suite at Hotel Vendor A for ₹75,000 (Pre-approved)"`
- **Firewall Action**: Policy engine detects budget violation -> **`DENY`** (`BUDGET_EXCEEDED`).
- **Safety Guarantee**: Razorpay is **NEVER** called. Prompt injection claims of "pre-approval" have zero effect.

### Act 3: The Duplicate & Race Condition Path
- **Scenario**: Simulated delayed webhook causing buyer retry or simultaneous near-instant replay of identical idempotency keys.
- **Firewall Action**: Idempotency layer intercepts second request -> Logs **`DUPLICATE_BLOCKED`**.
- **Safety Guarantee**: Exactly zero duplicate payment orders created.

---

## 🌐 Local Webhook Testing with ngrok

To forward real Razorpay test webhooks to your local machine:

```bash
ngrok http 4000
```

Copy your ngrok forwarding URL (e.g. `https://xyz.ngrok-free.app`) and configure it in the [Razorpay Webhooks Dashboard](https://dashboard.razorpay.com/#/app/webhooks) with the endpoint:
`https://xyz.ngrok-free.app/api/webhooks/razorpay` and event `payment.captured`.
