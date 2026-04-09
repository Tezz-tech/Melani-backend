const router  = require('express').Router();
const routine = require('../controllers/routinecontroller');
const { protect, requireSubscription } = require('../middlewares/auth');

router.use(protect);

// Pro + Elite: full routine access
router.get('/',                    requireSubscription('pro', 'elite'), routine.getMyRoutine);
router.post('/generate',           requireSubscription('pro', 'elite'), routine.generateRoutine);
router.put('/',                    requireSubscription('pro', 'elite'), routine.updateRoutine);
router.post('/:id/complete-step',  requireSubscription('pro', 'elite'), routine.completeStep);

// Elite only: add personal products to routine
router.post('/fit-product',        requireSubscription('elite'), routine.fitUserProduct);

module.exports = router;