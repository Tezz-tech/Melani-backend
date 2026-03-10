const router  = require('express').Router();
const routine = require('../controllers/routinecontroller');
const { protect } = require('../middlewares/auth');

router.use(protect);
router.get('/',                    routine.getMyRoutine);
router.post('/generate',           routine.generateRoutine);
router.put('/',                    routine.updateRoutine);
router.post('/:id/complete-step',  routine.completeStep);

module.exports = router;