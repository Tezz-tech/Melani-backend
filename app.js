// src/app.js
//
//  CHANGED: express.json limit raised from '2mb' to '15mb'.
//  A 1024×1024 JPEG at quality 0.82 is ~300–700KB raw.
//  Base64 encoding inflates that by ~33%, giving ~400KB–1MB.
//  '15mb' gives comfortable headroom for higher-res captures.
//
const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const compression   = require('compression');
const morgan        = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const path          = require('path');

const { apiLimiter } = require('./middlewares/ratelimiter');
const errorHandler   = require('./middlewares/errorhandler');
const logger         = require('./utils/logger');

// Routes
const authRoutes    = require('./routes/authroutes');
const scanRoutes    = require('./routes/scanRoutes');
const productRoutes = require('./routes/productRoutes');
const routineRoutes = require('./routes/routineRoutes');
const adminRoutes   = require('./routes/adminRoutes');

const app = express();

// ── Security headers ──────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ── Body parsing ──────────────────────────────────────────────
//
//  Limit is '15mb' to handle base64-encoded images from the mobile app.
//  A typical selfie at quality 0.82 → ~500KB JPEG → ~670KB base64.
//  Even at maximum expo-camera quality (quality: 1.0) on a high-res
//  sensor you'd be under 3MB base64.  15mb gives plenty of headroom.
//
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ── NoSQL injection protection ────────────────────────────────
app.use(mongoSanitize());

// ── Compression ───────────────────────────────────────────────
app.use(compression());

// ── HTTP request logging ──────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: msg => logger.http(msg.trim()) } }));
}

// ── Rate limit all /api routes ────────────────────────────────
app.use('/api', apiLimiter);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:  'ok',
  env:     process.env.NODE_ENV,
  uptime:  process.uptime(),
  version: process.env.npm_package_version || '1.0.0',
}));

// ── API routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/scans',    scanRoutes);
app.use('/api/products', productRoutes);
app.use('/api/routine',  routineRoutes);
app.use('/api/admin',    adminRoutes);

// ── 404 ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ status: 'error', message: 'Route not found.' }));

// ── Global error handler ──────────────────────────────────────
app.use(errorHandler);

module.exports = app;