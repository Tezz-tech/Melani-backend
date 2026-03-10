const jwt      = require('jsonwebtoken');
const User     = require('../models/User');
const AppError = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');

// ── Protect: verify JWT ───────────────────────────────────────
const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies?.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) throw new AppError('Not authenticated. Please log in.', 401);

  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  const user = await User.findById(decoded.id).select('-password');
  if (!user)        throw new AppError('User no longer exists.', 401);
  if (!user.isActive) throw new AppError('Account has been deactivated.', 401);

  req.user = user;
  next();
});

// ── Restrict to roles ─────────────────────────────────────────
const restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(new AppError('You do not have permission for this action.', 403));
  }
  next();
};

// ── Require verified email ─────────────────────────────────────
const requireVerified = (req, res, next) => {
  if (!req.user.isEmailVerified) {
    return next(new AppError('Please verify your email address first.', 403));
  }
  next();
};

// ── Require active subscription ────────────────────────────────
const requireSubscription = (...plans) => (req, res, next) => {
  const userPlan = req.user.subscription?.plan || 'free';
  if (!plans.includes(userPlan)) {
    return next(new AppError(`This feature requires a ${plans.join(' or ')} plan.`, 403));
  }
  next();
};

module.exports = { protect, restrictTo, requireVerified, requireSubscription };