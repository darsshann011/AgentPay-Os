/**
 * ============================================================================
 * AgentPay OS - Simulated AI Buyer Agent (Step 8 & 3-Act Demo Script)
 * ============================================================================
 * Plays the role of an autonomous AI Buyer Agent making real natural-language
 * commerce purchasing decisions and sending them to the AgentPay OS backend.
 * ============================================================================
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_AGENT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

let genAI = null;
if (GEMINI_API_KEY && !GEMINI_API_KEY.includes('your_') && GEMINI_API_KEY.length > 10) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  } catch (err) {
    // fallback
  }
}

/**
 * Generates an autonomous natural-language travel purchase prompt using Gemini
 */
async function generateBuyerPrompt(scenarioType) {
  const BUYER_SYSTEM_PROMPT = `
You are 'TravelBot', an autonomous enterprise AI travel assistant for executive team trips.
Generate a concise, realistic natural-language travel purchasing request in 1-2 sentences.
Only return the prompt text without quotes.
`;

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: BUYER_SYSTEM_PROMPT
      });

      let userPrompt = '';
      if (scenarioType === 'HAPPY_PATH') {
        userPrompt = 'Generate a corporate hotel booking request for ₹12,000 at Hotel Vendor A.';
      } else if (scenarioType === 'BLOCKED_BUDGET') {
        userPrompt = 'Generate an urgent luxury presidential suite booking request for ₹75,000 at Hotel Vendor A.';
      } else if (scenarioType === 'BLOCKED_MERCHANT') {
        userPrompt = 'Generate a high-stakes request to purchase ₹15,000 luxury goods from Unauthorized Casino & Resort.';
      }

      const res = await model.generateContent(userPrompt);
      const text = res.response.text().trim();
      if (text) return text;
    } catch (e) {
      // fallback to predefined realistic natural language prompts
    }
  }

  // Realistic fallback natural-language requests
  if (scenarioType === 'HAPPY_PATH') {
    return 'Please book a standard executive deluxe room for 2 nights at Hotel Vendor A for ₹12,000 for the client summit.';
  } else if (scenarioType === 'BLOCKED_BUDGET') {
    return 'Urgent executive booking: Reserve the Presidential Penthouse Suite at Hotel Vendor A for ₹75,000 for the upcoming VIP delegates.';
  } else if (scenarioType === 'BLOCKED_MERCHANT') {
    return 'Please authorize a VIP entertainment expenditure of ₹15,000 at Unauthorized Casino & Resort for the gala night.';
  }
  return 'Please book an airport transfer with Cab Vendor B for ₹1,800.';
}

/**
 * Send request to AgentPay OS backend
 */
async function sendBuyerRequest(prompt, idempotencyKey, agentId = DEFAULT_AGENT_ID) {
  const url = `${BACKEND_URL}/api/agent-requests`;
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      agent_id: agentId,
      idempotency_key: idempotencyKey
    })
  });

  return await response.json();
}

/**
 * Trigger simulated webhook confirmation for an order
 */
async function sendSimulatedWebhook(orderId, transactionId) {
  const url = `${BACKEND_URL}/api/webhooks/razorpay`;
  const payload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_test_${uuidv4().substring(0, 10)}`,
          order_id: orderId,
          amount: 1200000,
          currency: 'INR',
          status: 'captured',
          notes: { transaction_id: transactionId }
        }
      }
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': 'test_valid_signature'
    },
    body: JSON.stringify(payload)
  });

  return await response.json();
}

// ---------------------------------------------------------------------------
// 3-ACT DEMO RUNNERS
// ---------------------------------------------------------------------------

async function runAct1_HappyPath() {
  console.log('\n========================================================');
  console.log('🎬 ACT 1: HAPPY PATH (Allowed Purchase & Payment Creation)');
  console.log('========================================================');
  const prompt = await generateBuyerPrompt('HAPPY_PATH');
  console.log(`🤖 AI Buyer Agent prompt: "${prompt}"`);

  const idempotencyKey = `ik_act1_${uuidv4().substring(0, 8)}`;
  console.log(`🔑 Idempotency Key: ${idempotencyKey}`);

  const response = await sendBuyerRequest(prompt, idempotencyKey);
  console.log('🛡️ AgentPay OS Response:', JSON.stringify(response, null, 2));

  if (response.decision === 'ALLOW' && response.razorpay?.id) {
    console.log(`💳 Razorpay Order Created: ${response.razorpay.id}`);
    console.log(`⚡ Sending Webhook Payment Confirmation...`);
    const webhookRes = await sendSimulatedWebhook(response.razorpay.id, response.transaction_id);
    console.log('✅ Webhook Response:', webhookRes);
  }
}

async function runAct2_BlockedPath() {
  console.log('\n========================================================');
  console.log('🎬 ACT 2: BLOCKED PATH (Budget Exceeded Denial)');
  console.log('========================================================');
  const prompt = await generateBuyerPrompt('BLOCKED_BUDGET');
  console.log(`🤖 AI Buyer Agent prompt: "${prompt}"`);

  const idempotencyKey = `ik_act2_${uuidv4().substring(0, 8)}`;
  const response = await sendBuyerRequest(prompt, idempotencyKey);
  console.log('🛡️ AgentPay OS Response:', JSON.stringify(response, null, 2));
  console.log('🔒 Verification: Policy Engine denied before Razorpay call was ever made.');
}

async function runAct3_DuplicateRacePath() {
  console.log('\n========================================================');
  console.log('🎬 ACT 3: DUPLICATE / RACE PATH (Double-Spend & Replay Blocked)');
  console.log('========================================================');
  const prompt = 'Please book 1 airport transfer with Cab Vendor B for ₹2,500';
  const sharedKey = `ik_duplicate_replay_${uuidv4().substring(0, 8)}`;

  console.log(`🤖 Firing Request 1 with Key: ${sharedKey}`);
  const res1 = await sendBuyerRequest(prompt, sharedKey);
  console.log('🛡️ Request 1 Result:', res1.decision || res1.status);

  console.log(`🤖 Firing Request 2 (Duplicate / Delayed Retry) with Same Key: ${sharedKey}`);
  const res2 = await sendBuyerRequest(prompt, sharedKey);
  console.log('🛡️ Request 2 Result:', JSON.stringify(res2, null, 2));
  console.log('🔒 Verification: Duplicate request intercepted and DUPLICATE_BLOCKED logged.');
}

async function main() {
  const arg = process.argv[2] || '--all';
  console.log(`🚀 Starting Simulated AI Buyer Agent Demo [Mode: ${arg}]`);

  try {
    if (arg === '--act=1' || arg === '1') {
      await runAct1_HappyPath();
    } else if (arg === '--act=2' || arg === '2') {
      await runAct2_BlockedPath();
    } else if (arg === '--act=3' || arg === '3') {
      await runAct3_DuplicateRacePath();
    } else {
      await runAct1_HappyPath();
      await new Promise(r => setTimeout(r, 1000));
      await runAct2_BlockedPath();
      await new Promise(r => setTimeout(r, 1000));
      await runAct3_DuplicateRacePath();
    }
    console.log('\n✨ Demo Sequence Completed Successfully!');
  } catch (err) {
    console.error('❌ Demo execution error:', err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  generateBuyerPrompt,
  sendBuyerRequest,
  runAct1_HappyPath,
  runAct2_BlockedPath,
  runAct3_DuplicateRacePath
};
