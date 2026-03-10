const router = require('express').Router();
const admin  = require('../controllers/admincontroller');
const { protect, restrictTo } = require('../middlewares/auth');

router.use(protect);
// router.use(restrictTo('admin'));  // uncomment when role field is added to User model

router.get('/stats',             admin.getDashboardStats);
router.get('/gemini-status',     admin.getGeminiStatus);
router.get('/users',             admin.getUsers);
router.post('/products',         admin.createProduct);
router.put('/products/:id',      admin.updateProduct);

module.exports = router;