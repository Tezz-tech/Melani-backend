const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const AppError     = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');
const { success, error } = require('../utils/apiresponse');
const logger = require('../utils/logger');

// ── Token generators ──────────────────────────────────────────
const signAccessToken  = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

const signRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '90d' });

const sendTokens = async (user, res, statusCode = 200) => {
  const accessToken  = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);

  // ── FIX: use findByIdAndUpdate to avoid triggering pre-save hook ──
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

  // ── FIX: use findByIdAndUpdate instead of user.save() to avoid
  //         triggering the pre-save password hook on a non-password update ──
  await User.findByIdAndUpdate(user._id, { lastLoginAt: Date.now() });

  logger.info(`User logged in: ${email}`);
  await sendTokens(user, res);
});

// ── Refresh token ─────────────────────────────────────────────
exports.refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError('Refresh token required.', 400);

  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user    = await User.findById(decoded.id).select('+refreshToken');

  if (!user || user.refreshToken !== refreshToken) {
    throw new AppError('Invalid refresh token. Please log in again.', 401);
  }

  const newAccessToken = signAccessToken(user._id);
  success(res, { accessToken: newAccessToken }, 'Token refreshed');
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
  const { firstName, lastName, phone, skinProfile, settings } = req.body;
  const updates = {};
  if (firstName)    updates.firstName   = firstName;
  if (lastName)     updates.lastName    = lastName;
  if (phone)        updates.phone       = phone;
  if (skinProfile)  updates.skinProfile = { ...req.user.skinProfile.toObject(), ...skinProfile };
  if (settings)     updates.settings    = { ...req.user.settings.toObject(), ...settings };

  const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true, runValidators: true });
  success(res, { user }, 'Profile updated');
});

// ── Change password ───────────────────────────────────────────
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user.id).select('+password');

  if (!(await user.comparePassword(currentPassword))) {
    throw new AppError('Current password is incorrect.', 401);
  }

  // user.save() is correct here — we genuinely want to hash the new password
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
  const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex');

  const user = await User.findOne({
    passwordResetToken:   hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) throw new AppError('Reset token is invalid or has expired.', 400);

  // user.save() is correct here — we genuinely want to hash the new password
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
    email:     `deleted_${Date.now()}_${user.email}`, // free up email
    deletedAt: new Date(),
  });

  // TODO: schedule actual data purge job for 30 days

  logger.info(`Account deleted: ${user.email}`);
  success(res, {}, 'Account deleted. Your data will be purged within 30 days.');
});