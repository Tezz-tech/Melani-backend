const router = require('express').Router();
const admin  = require('../controllers/admincontroller');
const { protect, restrictTo } = require('../middlewares/auth');

// ── Admin login (no auth required) ───────────────────────────
router.post('/auth/login', admin.adminLogin);

// ── All routes below require valid JWT + admin role ───────────
router.use(protect);
router.use(restrictTo('admin'));

router.get('/stats',          admin.getDashboardStats);
router.get('/analytics',      admin.getAnalytics);
router.get('/health',         admin.getSystemHealth);
router.get('/gemini-status',  admin.getGeminiStatus);

router.get('/users',          admin.getUsers);
router.get('/users/:id',      admin.getUserById);
router.patch('/users/:id',    admin.updateUser);
router.delete('/users/:id',   admin.deleteUser);

router.get('/scans',          admin.getScans);
router.get('/scans/:id',      admin.getScanById);
router.delete('/scans/:id',   admin.deleteScan);

router.get('/subscriptions',  admin.getSubscriptions);

router.get('/products',       admin.getProducts);
router.post('/products',      admin.createProduct);
router.put('/products/:id',   admin.updateProduct);
router.delete('/products/:id',admin.deleteProduct);

module.exports = router;
