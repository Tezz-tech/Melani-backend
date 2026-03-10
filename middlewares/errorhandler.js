const AppError = require('../utils/apperror');
const logger   = require('../utils/logger');

// ── Specific Mongoose / JWT error converters ──────────────────
const handleCastError         = (e) => new AppError(`Invalid ${e.path}: ${e.value}`, 400);
const handleDuplicateKey      = (e) => new AppError(`Duplicate value: ${JSON.stringify(e.keyValue)}. Please use a different value.`, 400);
const handleValidationError   = (e) => new AppError(Object.values(e.errors).map(v => v.message).join('. '), 400);
const handleJWTError          = ()  => new AppError('Invalid token. Please log in again.', 401);
const handleJWTExpiredError   = ()  => new AppError('Your session has expired. Please log in again.', 401);

// ── Dev response ──────────────────────────────────────────────
const sendDev = (err, res) => res.status(err.statusCode).json({
  success:    false,
  message:    err.message,
  error:      err,
  stack:      err.stack,
});

// ── Prod response ─────────────────────────────────────────────
const sendProd = (err, res) => {
  if (err.isOperational) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }
  // Programming error — don't leak details
  logger.error('UNEXPECTED ERROR:', err);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};

// ── Global error handler ──────────────────────────────────────
module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;

  if (process.env.NODE_ENV === 'development') return sendDev(err, res);

  let error = { ...err, message: err.message };

  if (error.name === 'CastError')           error = handleCastError(error);
  if (error.code  === 11000)               error = handleDuplicateKey(error);
  if (error.name === 'ValidationError')    error = handleValidationError(error);
  if (error.name === 'JsonWebTokenError')  error = handleJWTError();
  if (error.name === 'TokenExpiredError')  error = handleJWTExpiredError();

  sendProd(error, res);
};