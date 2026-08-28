const Razorpay = require('razorpay');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const isRazorpayConfigured = Boolean(
  RAZORPAY_KEY_ID &&
  RAZORPAY_KEY_SECRET &&
  !RAZORPAY_KEY_ID.includes('your_') &&
  !RAZORPAY_KEY_SECRET.includes('your_')
);

let razorpayInstance = null;
if (isRazorpayConfigured) {
  try {
    razorpayInstance = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    });
    console.log('[Razorpay] Initialized Razorpay client with Key ID:', RAZORPAY_KEY_ID);
  } catch (err) {
    console.error('[Razorpay] Initialization error:', err.message);
  }
} else {
  console.log('[Razorpay] Test mode / Simulation mode active (No live API keys supplied).');
}

/**
 * Creates a Razorpay Order
 * @param {Object} params - { amount (INR in main units, e.g. 12000), currency: 'INR', receipt: string, notes: Object }
 * @returns {Promise<Object>} Razorpay order object
 */
async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  const amountInPaise = Math.round(Number(amount) * 100);

  if (razorpayInstance) {
    const options = {
      amount: amountInPaise,
      currency,
      receipt: receipt || `rcpt_${Date.now()}`,
      notes: {
        agent_id: notes.agent_id || '',
        sku: notes.sku || '',
        ...notes
      }
    };
    return await razorpayInstance.orders.create(options);
  }

  // Simulated Test-Mode Order Response
  const mockOrderId = `order_test_${uuidv4().substring(0, 14)}`;
  return {
    id: mockOrderId,
    entity: 'order',
    amount: amountInPaise,
    amount_paid: 0,
    amount_due: amountInPaise,
    currency,
    receipt: receipt || `rcpt_${Date.now()}`,
    status: 'created',
    attempts: 0,
    notes: {
      agent_id: notes.agent_id || '',
      sku: notes.sku || '',
      ...notes
    },
    created_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Creates a Razorpay Payment Link
 * @param {Object} params - { amount, currency, customer: { name, email, contact }, description, notes }
 * @returns {Promise<Object>} Payment Link object
 */
async function createPaymentLink({ amount, currency = 'INR', customer = {}, description, notes = {} }) {
  const amountInPaise = Math.round(Number(amount) * 100);

  if (razorpayInstance) {
    const options = {
      amount: amountInPaise,
      currency,
      accept_partial: false,
      description: description || 'AgentPay OS Autonomous Purchase',
      customer: {
        name: customer.name || 'AI Buyer Agent',
        email: customer.email || 'agent@agentpay.os',
        contact: customer.contact || '+919876543210'
      },
      notify: {
        sms: false,
        email: false
      },
      reminder_enable: false,
      notes
    };
    return await razorpayInstance.paymentLink.create(options);
  }

  const mockPlinkId = `plink_test_${uuidv4().substring(0, 14)}`;
  return {
    id: mockPlinkId,
    entity: 'payment_link',
    amount: amountInPaise,
    currency,
    short_url: `https://rzp.io/i/test_${mockPlinkId}`,
    status: 'created',
    description: description || 'AgentPay OS Autonomous Purchase',
    notes,
    created_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Creates a Refund for a given payment
 * @param {Object} params - { paymentId, amount, notes }
 */
async function createRefund({ paymentId, amount, notes = {} }) {
  if (razorpayInstance && paymentId && !paymentId.startsWith('pay_test_')) {
    const options = { notes };
    if (amount) {
      options.amount = Math.round(Number(amount) * 100);
    }
    return await razorpayInstance.payments.refund(paymentId, options);
  }

  return {
    id: `rfnd_test_${uuidv4().substring(0, 14)}`,
    entity: 'refund',
    amount: amount ? Math.round(Number(amount) * 100) : 0,
    currency: 'INR',
    payment_id: paymentId || `pay_test_${uuidv4().substring(0, 10)}`,
    status: 'processed',
    notes,
    created_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Verifies Razorpay Webhook Signature
 * @param {string|Buffer} rawBody - Raw unparsed request body string or buffer
 * @param {string} signature - X-Razorpay-Signature header
 * @param {string} [secret] - Webhook secret override
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature(rawBody, signature, secret = RAZORPAY_WEBHOOK_SECRET) {
  if (!signature) return false;
  if (!secret || secret.includes('your_')) {
    // In test/simulation mode with default secret, allow test signature header
    return signature === 'test_valid_signature' || signature.length > 10;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}

module.exports = {
  createOrder,
  createPaymentLink,
  createRefund,
  verifyWebhookSignature,
  isRazorpayConfigured
};
