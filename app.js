const express        = require('express');
const helmet         = require('helmet');
const cors           = require('cors');
const compression    = require('compression');
const morgan         = require('morgan');
const mongoSanitize  = require('express-mongo-sanitize');
const path           = require('path');

const { apiLimiter } = require('./middlewares/ratelimiter');
const errorHandler   = require('./middlewares/errorhandler');
const logger         = require('./utils/logger');

// Route files
const authRoutes         = require('./routes/authroutes');
const scanRoutes         = require('./routes/scanRoutes');
const productRoutes      = require('./routes/productRoutes');
const routineRoutes      = require('./routes/routineRoutes');
const adminRoutes        = require('./routes/adminRoutes');
const subscriptionRoutes = require('./routes/subscription.routes');
const subscriptionCtrl   = require('./controllers/subscription.controller');

const app = express();

// ── Security headers ──────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Sanitise query strings against NoSQL injection ────────────
app.use(mongoSanitize());

// ── Compression ───────────────────────────────────────────────
app.use(compression());

// ── HTTP logging ──────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: (msg) => logger.http(msg.trim()) } }));
}

// ── Static uploads ────────────────────────────────────────────
app.use('/uploads', express.static(path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads')));

// ── Rate limit all /api routes ────────────────────────────────
app.use('/api', apiLimiter);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:  'ok',
  env:     process.env.NODE_ENV,
  uptime:  process.uptime(),
  version: process.env.npm_package_version || '1.0.0',
}));

// ── Paystack webhook: needs raw body BEFORE express.json() ──
// Registered here explicitly so it captures the raw Buffer
app.post(
  '/api/subscription/webhook',
  express.raw({ type: 'application/json' }),
  subscriptionCtrl.handleWebhook
);

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/scans',        scanRoutes);
app.use('/api/products',     productRoutes);
app.use('/api/routine',      routineRoutes);
app.use('/api/admin',        adminRoutes);
app.use('/api/subscription', subscriptionRoutes);

// ── 404 handler ───────────────────────────────────────────────
app.all('*', (req, res) => res.status(404).json({
  success: false,
  message: `Route ${req.method} ${req.originalUrl} not found`,
}));

// ── Global error handler ──────────────────────────────────────
app.use(errorHandler);

module.exports = app;