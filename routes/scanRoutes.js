// src/routes/scanRoutes.js
//
//  Accepts plain JSON body { imageBase64, mimeType } — no multipart/multer.
//
const router = require('express').Router();

// ✅ FIX 1: was '../controllers/scancontroller' (lowercase c) — Linux is
//           case-sensitive so this crashed the process on startup with
//           MODULE_NOT_FOUND. Must match the actual filename exactly.
const scan = require('../controllers/scanController');

const { protect }     = require('../middlewares/auth');
const { scanLimiter } = require('../middlewares/ratelimiter');

// All scan routes require authentication
router.use(protect);

// Stats must come before /:id so Express doesn't treat 'stats' as an id param
router.get('/stats', scan.getScanStats);

// Paginated history
router.get('/', scan.getMyScanHistory);

// Single scan by _id or scanId
router.get('/:id', scan.getScan);

// ── Create scan ───────────────────────────────────────────────
//  Expects JSON body: { imageBase64: string, mimeType?: string }
//  No multer — just rate limiting + auth
router.post('/', scanLimiter, scan.createScan);

// Soft delete
router.delete('/:id', scan.deleteScan);

module.exports = router;