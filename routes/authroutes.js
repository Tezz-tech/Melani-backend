const router = require('express').Router();
const auth = require('../controllers/authcontroller');
const { protect } = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/ratelimiter');

router.post('/register',              authLimiter, auth.register);
router.post('/login',                 authLimiter, auth.login);
router.post('/refresh-token',         auth.refreshToken);
router.post('/forgot-password',       authLimiter, auth.forgotPassword);
router.post('/reset-password-otp',    authLimiter, auth.resetPasswordWithOTP);

// Email OTP verification (signup)
router.post('/send-verification-otp', authLimiter, auth.sendVerificationOTP);
router.post('/verify-email-otp',      authLimiter, auth.verifyEmailOTP);

// Legacy link-based reset (kept for compatibility)
router.post('/reset-password/:token', auth.resetPassword);

// Protected
router.use(protect);
router.post('/logout',            auth.logout);
router.get('/me',                 auth.getMe);
router.patch('/update-me',        auth.updateMe);
router.patch('/change-password',  auth.changePassword);
router.patch('/push-token',       auth.registerPushToken);
router.delete('/delete-account',  auth.deleteAccount);

module.exports = router;