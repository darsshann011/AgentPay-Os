const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const agentRequestsRouter = require('./routes/agentRequests');
const webhooksRouter = require('./routes/webhooks');
const auditRouter = require('./routes/audit');

const app = express();
const PORT = process.env.PORT || 4000;

// Set UTF-8 encoding across all HTTP responses
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Razorpay-Signature', 'Idempotency-Key']
}));

// Capture raw body for Razorpay webhook HMAC signature verification with explicit UTF-8 support
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'HEALTHY',
    service: 'AgentPay OS - Policy Firewall',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/agent-requests', agentRequestsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/audit', auditRouter);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(err.status || 500).json({
    error: true,
    message: err.message || 'Internal Server Error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// Start Server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(`🛡️ AgentPay OS Policy Firewall running on port ${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/api/health`);
    console.log(`📊 Audit API:    http://localhost:${PORT}/api/audit`);
    console.log(`🤖 Agent API:    http://localhost:${PORT}/api/agent-requests`);
    console.log(`⚡ Webhook API:  http://localhost:${PORT}/api/webhooks/razorpay`);
    console.log(`========================================================`);
  });
}

module.exports = app;
