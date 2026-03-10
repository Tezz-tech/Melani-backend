// src/routes/scanRoutes.js
//
//  CHANGED: upload.single('image') and processScanImage middleware
//  are removed from the POST / route.  The route now accepts a plain
//  JSON body { imageBase64, mimeType } — no multipart form data.
//
const router = require('express').Router();
const scan   = require('../controllers/scancontroller');
const { protect }     = require('../middlewares/auth');
const { scanLimiter } = require('../middlewares/ratelimiter');

// All scan routes require authentication
router.use(protect);

// Stats must come before /:id so Express doesn't match 'stats' as an id
router.get('/stats', scan.getScanStats);

// History
router.get('/', scan.getMyScanHistory);

// Single scan
router.get('/:id', scan.getScan);

// ── Create scan ───────────────────────────────────────────────
//  Expects JSON body: { imageBase64: string, mimeType: string }
//  No multer, no upload middleware — just rate limiting + auth
router.post('/', scanLimiter, scan.createScan);

// Soft delete
router.delete('/:id', scan.deleteScan);

module.exports = router;