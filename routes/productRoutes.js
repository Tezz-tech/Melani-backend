const router  = require('express').Router();
const product = require('../controllers/productcontroller');
const { protect } = require('../middlewares/auth');

router.get('/',    product.getProducts);
router.get('/:id', product.getProduct);

// Auth required for AI features
router.use(protect);
router.post('/recommendations',    product.getAIRecommendations);
router.post('/ingredient-check',   product.checkIngredients);

module.exports = router;