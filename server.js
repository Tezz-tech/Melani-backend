require('dotenv').config();
const app       = require('./app');
const connectDB = require('./config/db');
const logger    = require('./utils/logger');

const PORT = parseInt(process.env.PORT || '8001', 10);

// ── Boot sequence ─────────────────────────────────────────────
(async () => {
  await connectDB();

  const server = app.listen(PORT, () => {
    logger.info(`
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      Melanin Scan API
      ENV  : ${process.env.NODE_ENV}
      PORT : ${PORT}
      DB   : ${process.env.MONGO_URI}
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  });

  // ── Graceful shutdown ─────────────────────────────────────
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    // Force close after 10 s
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => {
    logger.error('UNHANDLED REJECTION:', err);
    server.close(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
  });
})();