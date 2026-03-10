const rateLimit = require('express-rate-limit');
const AppError  = require('../utils/apperror');

// ── General API limiter ────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),  // 15 min
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => res.status(429).json({
    success: false,
    message: 'Too many requests. Please wait a moment and try again.',
  }),
});

// ── Scan limiter — more restrictive ───────────────────────────
const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:      parseInt(process.env.SCAN_RATE_LIMIT_MAX || '10'),
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id || req.ip,
  handler: (req, res) => res.status(429).json({
    success: false,
    message: 'Scan limit reached. Please wait before scanning again.',
  }),
});

// ── Auth limiter ──────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => res.status(429).json({
    success: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
  }),
});

module.exports = { apiLimiter, scanLimiter, authLimiter };