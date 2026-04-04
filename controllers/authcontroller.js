const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const AppError     = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');
const { success, error } = require('../utils/apiresponse');
const logger = require('../utils/logger');

// ── Token generators ──────────────────────────────────────────
const signAccessToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '90d',
  });

const sendTokens = async (user, res, statusCode = 200) => {
  const accessToken  = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);

  // Use findByIdAndUpdate to avoid triggering pre-save password hash hook
  await User.findByIdAndUpdate(user._id, { refreshToken });

  user.password     = undefined;
  user.refreshToken = undefined;

  return success(res, { user, accessToken, refreshToken }, 'Authenticated', statusCode);
};

// ── Register ──────────────────────────────────────────────────
exports.register = asyncHandler(async (req, res) => {
  const { firstName, lastName, email, password, phone } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw new AppError('An account with that email already exists.', 400);

  const user = await User.create({ firstName, lastName, email, password, phone });

  // TODO: send verification email
  // await emailService.sendVerificationEmail(user);

  logger.info(`New user registered: ${email}`);
  await sendTokens(user, res, 201);
});

// ── Login ─────────────────────────────────────────────────────
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new AppError('Email and password are required.', 400);

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Incorrect email or password.', 401);
  }
  if (!user.isActive) throw new AppError('Your account has been deactivated. Contact support.', 401);

  // Use findByIdAndUpdate to avoid triggering the pre-save password hook
  await User.findByIdAndUpdate(user._id, { lastLoginAt: Date.now() });

  logger.info(`User logged in: ${email}`);
  await sendTokens(user, res);
});

// ── Refresh token ────────────────────────────────────────
//
//  Implements REFRESH TOKEN ROTATION
//  ───────────────────────────────────────────
//  On every successful use:
//    • A brand-new refresh token is issued
//    • The old refresh token is immediately invalidated in the DB
//    • Both new access + new refresh tokens are returned to the client
//
//  If a stolen refresh token is presented after the real user has
//  already rotated it, the DB lookup fails (token mismatch) and
//  a 401 is returned — without exposing whether the user exists.
//
exports.refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError('Refresh token required.', 400);

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new AppError('Refresh token is invalid or expired. Please log in again.', 401);
  }

  const user = await User.findById(decoded.id).select('+refreshToken');

  // Token mismatch — either already rotated (replay attack) or logged out
  if (!user || user.refreshToken !== refreshToken) {
    // Invalidate any stored token to force full re-login
    if (user) await User.findByIdAndUpdate(user._id, { refreshToken: null });
    throw new AppError('Refresh token is invalid or has already been used. Please log in again.', 401);
  }

  // Issue both tokens — rotation: new refresh replaces old one immediately
  const newAccessToken  = signAccessToken(user._id);
  const newRefreshToken = signRefreshToken(user._id);

  await User.findByIdAndUpdate(user._id, { refreshToken: newRefreshToken });

  await success(res, {
    accessToken:  newAccessToken,
    refreshToken: newRefreshToken,
  }, 'Token refreshed');
});

// ── Logout ────────────────────────────────────────────────────
exports.logout = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user.id, { refreshToken: null });
  success(res, {}, 'Logged out successfully');
});

// ── Get current user ──────────────────────────────────────────
exports.getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  success(res, { user });
});

// ── Update profile ────────────────────────────────────────────
exports.updateMe = asyncHandler(async (req, res) => {
  const { firstName, lastName, phone, skinProfile, settings, region } = req.body;
  const updates = {};

  if (firstName) updates.firstName = firstName;
  if (lastName)  updates.lastName  = lastName;
  if (phone)     updates.phone     = phone;
  if (region)    updates.region    = region;

  // ✅ FIX: guard toObject() — subdoc may be undefined on legacy documents
  if (skinProfile) {
    const existing = req.user.skinProfile
      ? req.user.skinProfile.toObject()
      : {};
    updates.skinProfile = { ...existing, ...skinProfile };
  }

  if (settings) {
    const existing = req.user.settings
      ? req.user.settings.toObject()
      : {};
    updates.settings = { ...existing, ...settings };
  }

  const user = await User.findByIdAndUpdate(req.user.id, updates, {
    new: true,
    runValidators: true,
  });
  success(res, { user }, 'Profile updated');
});

// ── Register push token ───────────────────────────────────────
//  PATCH /api/auth/push-token
//  Body: { pushToken: 'ExponentPushToken[xxxxxx]' }
//  Called by the app when the user grants notification permission.
exports.registerPushToken = asyncHandler(async (req, res) => {
  const { pushToken } = req.body;

  if (!pushToken || typeof pushToken !== 'string') {
    throw new AppError('pushToken is required and must be a string.', 400);
  }

  // Validate Expo token format
  if (!pushToken.startsWith('ExponentPushToken[') && !pushToken.startsWith('ExpoPushToken[')) {
    throw new AppError('pushToken must be a valid Expo push token.', 400);
  }

  await User.findByIdAndUpdate(req.user.id, { pushToken: pushToken.trim() });

  logger.info(`Push token registered for user ${req.user.id}`);
  success(res, {}, 'Push token registered');
});

// ── Change password ───────────────────────────────────────────
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user.id).select('+password');

  if (!(await user.comparePassword(currentPassword))) {
    throw new AppError('Current password is incorrect.', 401);
  }

  // user.save() is intentional here — we want the pre-save hook to hash the new password
  user.password = newPassword;
  await user.save();
  await sendTokens(user, res);
});

// ── Forgot password ───────────────────────────────────────────
exports.forgotPassword = asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) throw new AppError('No account found with that email.', 404);

  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // TODO: await emailService.sendPasswordReset(user, resetToken);
  logger.info(`Password reset token generated for ${user.email}`);
  success(res, { resetToken }, 'Password reset instructions sent to your email');
});

// ── Reset password ────────────────────────────────────────────
exports.resetPassword = asyncHandler(async (req, res) => {
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken:   hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) throw new AppError('Reset token is invalid or has expired.', 400);

  // user.save() is intentional here — we want the pre-save hook to hash the new password
  user.password             = req.body.password;
  user.passwordResetToken   = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  await sendTokens(user, res);
});

// ── Delete account ────────────────────────────────────────────
exports.deleteAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('+password');
  if (!(await user.comparePassword(req.body.password))) {
    throw new AppError('Password is incorrect.', 401);
  }

  // Soft-delete — keep data for 30 days before permanent purge
  await User.findByIdAndUpdate(req.user.id, {
    isActive:  false,
    email:     `deleted_${Date.now()}_${user.email}`, // free up the email address
    deletedAt: new Date(),
  });

  // TODO: schedule actual data purge job for 30 days

  logger.info(`Account deleted: ${user.email}`);
  success(res, {}, 'Account deleted. Your data will be purged within 30 days.');
});