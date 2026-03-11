// src/controllers/subscription.controller.js
'use strict';

const crypto = require('crypto');
const https  = require('https');
const User         = require('../models/User');
const Subscription = require('../models/Subscription.model');
const logger = require('../utils/logger');

const PAYSTACK_HOST = 'api.paystack.co';
const SECRET_KEY    = () => process.env.PAYSTACK_SECRET_KEY || '';

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Plan config ───────────────────────────────────────────────
const PLAN_CODES = {
  pro_monthly:   process.env.PAYSTACK_PRO_MONTHLY_CODE   || '',
  pro_yearly:    process.env.PAYSTACK_PRO_YEARLY_CODE    || '',
  elite_monthly: process.env.PAYSTACK_ELITE_MONTHLY_CODE || '',
  elite_yearly:  process.env.PAYSTACK_ELITE_YEARLY_CODE  || '',
};

const PLAN_PRICES_KOBO = {
  pro_monthly:   250000,
  pro_yearly:    2400000,
  elite_monthly: 550000,
  elite_yearly:  5280000,
};

const PLAN_PRICES_NGN = {
  pro_monthly:   2500,
  pro_yearly:    24000,
  elite_monthly: 5500,
  elite_yearly:  52800,
};

// ── Paystack HTTP helper ──────────────────────────────────────
function paystackRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: PAYSTACK_HOST,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${SECRET_KEY()}`,
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, data: JSON.parse(data) });
        } catch {
          reject(new Error(`Paystack response parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Paystack request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────
const verifySignature = (rawBody, signature) => {
  if (!SECRET_KEY() || !signature) return false;
  const hash = crypto
    .createHmac('sha512', SECRET_KEY())
    .update(rawBody)
    .digest('hex');
  return hash === signature;
};

const activatePlan = async (userId, plan, billing, durationDays) => {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 3600 * 1000);
  await User.findByIdAndUpdate(userId, {
    'subscription.plan':      plan,
    'subscription.status':    'active',
    'subscription.startedAt': now,
    'subscription.expiresAt': expiresAt,
  });
  return expiresAt;
};

// ─────────────────────────────────────────────────────────────

// GET /api/subscription
exports.getSubscription = wrap(async (req, res) => {
  const user    = await User.findById(req.user._id).select('subscription email firstName lastName');
  const history = await Subscription.find({ userId: req.user._id })
    .sort({ createdAt: -1 }).limit(5).lean();

  res.json({
    success: true,
    data: { current: user.subscription, history },
  });
});

// POST /api/subscription/initiate
exports.initiatePayment = wrap(async (req, res) => {
  const { plan, billing = 'monthly' } = req.body;

  if (!['pro', 'elite'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Plan must be "pro" or "elite"' });
  }

  const key        = `${plan}_${billing}`;
  const amountNGN  = PLAN_PRICES_NGN[key];
  const amountKobo = PLAN_PRICES_KOBO[key];

  if (!amountNGN) {
    return res.status(400).json({ success: false, message: 'Invalid plan/billing combination' });
  }

  const reference = `MS-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const payload = {
    email:        req.user.email,
    amount:       amountKobo,
    reference,
    currency:     'NGN',
    callback_url: `${process.env.CLIENT_URL || 'https://melaninscan.com'}/payment/verify`,
    metadata: {
      cancel_action: `${process.env.CLIENT_URL || 'https://melaninscan.com'}/payment/cancel`,
      userId:  req.user._id.toString(),
      plan,
      billing,
      custom_fields: [
        { display_name: 'Plan',    variable_name: 'plan',    value: plan },
        { display_name: 'Billing', variable_name: 'billing', value: billing },
      ],
    },
  };

  // Attach recurring plan code if configured in Paystack dashboard
  if (PLAN_CODES[key]) payload.plan = PLAN_CODES[key];

  let authorizationUrl, accessCode;

  try {
    const { data: psRes } = await paystackRequest('POST', '/transaction/initialize', payload);

    if (!psRes.status) {
      throw new Error(psRes.message || 'Paystack initialisation failed');
    }

    authorizationUrl = psRes.data.authorization_url;
    accessCode       = psRes.data.access_code;

  } catch (err) {
    logger.error('Paystack initiate error:', err.message);
    return res.status(502).json({
      success: false,
      message: 'Payment gateway error. Please try again.',
    });
  }

  // Record pending transaction
  await Subscription.create({
    userId:            req.user._id,
    plan,
    billing,
    status:            'pending',
    paystackReference: reference,
    amountNGN,
  });

  logger.info(`Payment initiated: ${req.user.email} → ${plan} ${billing} ref:${reference}`);

  res.json({
    success: true,
    message: 'Payment session created',
    data: { reference, authorizationUrl, accessCode, amount: amountNGN, plan, billing },
  });
});

// POST /api/subscription/verify
exports.verifyPayment = wrap(async (req, res) => {
  const { reference } = req.body;
  if (!reference) {
    return res.status(400).json({ success: false, message: 'reference is required' });
  }

  const sub = await Subscription.findOne({ paystackReference: reference, userId: req.user._id });
  if (!sub) {
    return res.status(404).json({ success: false, message: 'Payment reference not found' });
  }

  // Webhook may have already activated this — if so, just confirm
  if (sub.status === 'active') {
    const user = await User.findById(req.user._id).select('-password');
    return res.json({
      success: true,
      message: `${sub.plan} Plan is active`,
      data: { plan: sub.plan, billing: sub.billing, expiresAt: sub.expiresAt, amountNGN: sub.amountNGN, user },
    });
  }

  // Verify with Paystack
  let psData;
  try {
    const { data: psRes } = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

    if (!psRes.status || psRes.data?.status !== 'success') {
      return res.status(402).json({
        success: false,
        message: psRes.data?.gateway_response || 'Payment was not successful',
      });
    }

    // Guard against amount tampering
    const expectedKobo = PLAN_PRICES_KOBO[`${sub.plan}_${sub.billing}`];
    if (psRes.data.amount < expectedKobo) {
      logger.error(`Amount mismatch ref ${reference}: got ${psRes.data.amount} expected ${expectedKobo}`);
      return res.status(402).json({ success: false, message: 'Payment amount mismatch. Contact support.' });
    }

    psData = psRes.data;
  } catch (err) {
    logger.error('Paystack verify error:', err.message);
    return res.status(502).json({ success: false, message: 'Could not verify payment. Contact support.' });
  }

  const durationDays = sub.billing === 'yearly' ? 365 : 30;
  const expiresAt    = await activatePlan(req.user._id, sub.plan, sub.billing, durationDays);

  sub.status    = 'active';
  sub.startedAt = new Date();
  sub.expiresAt = expiresAt;
  if (psData?.customer?.customer_code) sub.paystackCustomerId = psData.customer.customer_code;
  await sub.save();

  const updatedUser = await User.findById(req.user._id).select('-password');

  logger.info(`Plan activated: ${req.user.email} → ${sub.plan} until ${expiresAt.toDateString()}`);

  res.json({
    success: true,
    message: `${sub.plan.charAt(0).toUpperCase() + sub.plan.slice(1)} Plan activated`,
    data: { plan: sub.plan, billing: sub.billing, expiresAt, amountNGN: sub.amountNGN, user: updatedUser },
  });
});

// POST /api/subscription/cancel
exports.cancelSubscription = wrap(async (req, res) => {
  const sub = await Subscription.findOne({ userId: req.user._id, status: 'active' })
    .sort({ createdAt: -1 });

  if (!sub) {
    return res.status(404).json({ success: false, message: 'No active subscription found' });
  }

  // Cancel recurring billing on Paystack if subscription ID exists
  if (sub.paystackSubscriptionId && sub.paystackEmailToken) {
    try {
      await paystackRequest('POST', '/subscription/disable', {
        code:  sub.paystackSubscriptionId,
        token: sub.paystackEmailToken,
      });
    } catch (err) {
      logger.warn('Paystack cancel warning (continuing):', err.message);
    }
  }

  sub.status      = 'cancelled';
  sub.cancelledAt = new Date();
  await sub.save();

  await User.findByIdAndUpdate(req.user._id, { 'subscription.status': 'cancelled' });

  logger.info(`Subscription cancelled: ${req.user.email} — access until ${sub.expiresAt?.toDateString()}`);

  res.json({
    success: true,
    message: 'Subscription cancelled. You retain access until the end of your billing period.',
    data: { accessUntil: sub.expiresAt },
  });
});

// POST /api/subscription/webhook
// NOTE: Must receive raw body for signature verification.
// In app.js register this route with express.raw() BEFORE express.json():
//   app.post('/api/subscription/webhook',
//     express.raw({ type: 'application/json' }),
//     subscriptionRoutes  ← or directly ctrl.handleWebhook
//   );
exports.handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody   = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);

    if (!verifySignature(rawBody, signature)) {
      logger.warn('Invalid Paystack webhook signature');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const { event, data } = JSON.parse(rawBody);
    logger.info(`Webhook: ${event}`);

    switch (event) {

      case 'charge.success': {
        const { reference, metadata, customer } = data;
        const { userId, plan, billing } = metadata || {};
        if (userId && plan) {
          const durationDays = billing === 'yearly' ? 365 : 30;
          const expiresAt    = await activatePlan(userId, plan, billing, durationDays);
          await Subscription.findOneAndUpdate(
            { paystackReference: reference },
            {
              status:             'active',
              startedAt:          new Date(),
              expiresAt,
              paystackCustomerId: customer?.customer_code,
              $push: { webhookEvents: { event, receivedAt: new Date() } },
            }
          );
          logger.info(`Webhook activated ${plan} for ${userId}`);
        }
        break;
      }

      case 'subscription.create': {
        const { subscription_code, email_token } = data;
        const ref = data.most_recent_invoice?.transaction?.reference;
        if (ref) {
          await Subscription.findOneAndUpdate(
            { paystackReference: ref },
            {
              paystackSubscriptionId: subscription_code,
              paystackEmailToken:     email_token,
              $push: { webhookEvents: { event, receivedAt: new Date() } },
            }
          );
        }
        break;
      }

      case 'subscription.disable':
      case 'subscription.not_renew': {
        const sub = await Subscription.findOneAndUpdate(
          { paystackSubscriptionId: data.subscription_code },
          { status: 'cancelled', cancelledAt: new Date(), $push: { webhookEvents: { event, receivedAt: new Date() } } },
          { new: true }
        );
        if (sub) await User.findByIdAndUpdate(sub.userId, { 'subscription.status': 'cancelled' });
        break;
      }

      case 'invoice.payment_failed': {
        const subCode = data.subscription?.subscription_code;
        if (subCode) {
          await Subscription.findOneAndUpdate(
            { paystackSubscriptionId: subCode },
            { status: 'past_due', $push: { webhookEvents: { event, receivedAt: new Date() } } }
          );
        }
        break;
      }

      case 'invoice.update': {
        // Recurring renewal succeeded
        const subCode = data.subscription?.subscription_code;
        if (subCode) {
          const sub = await Subscription.findOne({ paystackSubscriptionId: subCode });
          if (sub) {
            const durationDays = sub.billing === 'yearly' ? 365 : 30;
            const expiresAt    = await activatePlan(sub.userId, sub.plan, sub.billing, durationDays);
            sub.expiresAt = expiresAt;
            sub.status    = 'active';
            await sub.save();
            logger.info(`Webhook renewal: ${sub.plan} for ${sub.userId}`);
          }
        }
        break;
      }

      default:
        logger.debug(`Unhandled webhook event: ${event}`);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    logger.error('Webhook error:', err.message);
    res.status(500).json({ message: 'Webhook processing failed' });
  }
};