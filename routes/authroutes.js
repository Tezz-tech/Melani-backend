const router  = require('express').Router();
const auth    = require('../controllers/authcontroller');
const { protect }   = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/ratelimiter');

router.post('/register',      authLimiter, auth.register);
router.post('/login',         authLimiter, auth.login);
router.post('/refresh-token', auth.refreshToken);
router.post('/forgot-password', authLimiter, auth.forgotPassword);
router.patch('/reset-password/:token', auth.resetPassword);

// Protected
router.use(protect);
router.post('/logout',           auth.logout);
router.get('/me',                auth.getMe);
router.patch('/update-me',       auth.updateMe);
router.patch('/change-password', auth.changePassword);
router.delete('/delete-account', auth.deleteAccount);

module.exports = router;