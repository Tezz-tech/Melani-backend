// src/routes/subscription.routes.js
'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/subscription.controller');
const { protect }     = require('../middlewares/auth');
const { apiLimiter }  = require('../middlewares/ratelimiter');

// ── Note on webhook ───────────────────────────────────────────
// POST /api/subscription/webhook is intentionally NOT registered here.
// It is registered directly in app.js with express.raw() middleware
// BEFORE express.json(), so Paystack's raw body is preserved for
// HMAC signature verification. Registering it here would parse the
// body as JSON first and break the signature check.
// ─────────────────────────────────────────────────────────────

// All routes below require a valid JWT
router.use(protect);

// GET  /api/subscription
// Returns current subscription plan + billing history for the logged-in user
router.get('/', ctrl.getSubscription);

// POST /api/subscription/initiate
// Step 1 of checkout: creates a Paystack transaction and returns
// { reference, authorizationUrl, accessCode, amount, plan, billing }
// The client opens authorizationUrl in an in-app browser / WebBrowser
router.post('/initiate', apiLimiter, ctrl.initiatePayment);

// POST /api/subscription/verify
// Step 2: called by the client after Paystack redirects back.
// Body: { reference }
// Verifies the transaction with Paystack, activates the plan,
// and returns the updated user object so the client can sync auth state.
router.post('/verify', ctrl.verifyPayment);

// POST /api/subscription/cancel
// Disables recurring billing on Paystack (if subscription code exists)
// and marks the local subscription as cancelled.
// Access continues until expiresAt.
router.post('/cancel', ctrl.cancelSubscription);

module.exports = router;