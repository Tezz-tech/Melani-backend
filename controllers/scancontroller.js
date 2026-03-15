// src/controllers/scanController.js
//
//  Receives JSON body: { imageBase64, mimeType }
//  No multer, no req.file, nothing written to disk.
//  imageBase64 is forwarded to Gemini via analyseSkinImageBase64().
//
const Scan         = require('../models/Scan');
const AppError     = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');
const { success, paginated } = require('../utils/apiresponse');
const { analyseSkinImageBase64 }    = require('../services/geminiScanService');
const { getProductRecommendations } = require('../services/geminiProductService');
const logger = require('../utils/logger');

// ── POST /api/scans ───────────────────────────────────────────
exports.createScan = asyncHandler(async (req, res) => {
  const { imageBase64, mimeType = 'image/jpeg' } = req.body;

  // 1. Validate payload
  if (!imageBase64) {
    throw new AppError(
      'imageBase64 is required. Send the image as a base64 string in the JSON body.',
      400,
    );
  }

  // Quick sanity check — valid base64 chars only
  const b64 = imageBase64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64) || b64.length < 500) {
    throw new AppError('imageBase64 is not a valid base64-encoded image.', 400);
  }

  // 2. Quota check (free users get 3 scans/month)
  const user = req.user;
  if (!user.canScan()) {
    throw new AppError(
      'You have used all 3 free scans this month. Upgrade to Pro for unlimited scans.',
      403,
    );
  }

  // 3. Create pending scan record — no imageUrl, nothing on disk
  const scan = await Scan.create({
    user:   user._id,
    status: 'processing',
  });

  // 4. Send base64 directly to Gemini Vision
  let analysisData;
  try {
    analysisData = await analyseSkinImageBase64(b64, mimeType);
  } catch (err) {
    scan.status   = 'failed';
    scan.errorLog = err.message;
    await scan.save();
    logger.error(`Scan ${scan.scanId} Gemini failed: ${err.message}`);
    throw new AppError('Skin analysis failed. Please try again.', 500);
  }

  // 5. Product recommendations (non-critical — silent fail)
  let products = [];
  try {
    products = await getProductRecommendations(analysisData, user.skinProfile || {});
  } catch (err) {
    logger.warn(`Products failed for scan ${scan.scanId}: ${err.message}`);
  }

  // 6. Persist full result
  //    ✅ FIX 4: populate geminiModel + geminiKeyIndex which were silently
  //              left empty even though the schema defines those fields.
  Object.assign(scan, {
    status:             'completed',
    skinType:           analysisData.skinType,
    confidence:         analysisData.confidence,
    overallScore:       analysisData.overallScore,
    fitzpatrickEst:     analysisData.fitzpatrickEst,
    scoreBreakdown:     analysisData.scoreBreakdown,
    conditions:         analysisData.conditions,
    melaninInsights:    analysisData.melaninInsights,
    goodIngredients:    analysisData.goodIngredients,
    avoidIngredients:   analysisData.avoidIngredients,
    routine:            analysisData.routine,
    progressMilestones: analysisData.progressMilestones,
    processingTimeMs:   analysisData.processingTimeMs,
    rawGeminiOutput:    analysisData.rawGeminiOutput,
    geminiModel:        process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
    geminiKeyIndex:     analysisData.geminiKeyIndex ?? null,
    products,
  });
  await scan.save();

  // ✅ FIX 3: Steps 7 + 8 previously each called user.save() independently.
  //           Two separate saves on the same in-memory document triggers
  //           the pre-save password hook twice and creates a race window.
  //           Both mutations are now applied together and flushed in ONE save.

  // 7. Increment free-user monthly count
  if (user.subscription?.plan === 'free') {
    user.scanUsage.monthlyCount = (user.scanUsage?.monthlyCount || 0) + 1;
  }

  // 8. Update stored skin profile
  const existingSkinProfile =
    user.skinProfile?.toObject?.() ||
    user.skinProfile ||
    {};

  user.skinProfile = {
    ...existingSkinProfile,
    skinType:         analysisData.skinType,
    fitzpatrickScale: analysisData.fitzpatrickEst,
  };

  // Single save covers both mutations above
  await user.save({ validateBeforeSave: false });

  logger.info(
    `Scan ${scan.scanId} completed for user ${user._id} in ${analysisData.processingTimeMs}ms`,
  );

  success(res, { scan }, 'Skin analysis complete', 201);
});

// ── GET /api/scans — paginated history ───────────────────────
exports.getMyScanHistory = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1'));
  const limit = Math.min(50, parseInt(req.query.limit || '10'));
  const skip  = (page - 1) * limit;

  const filter = { user: req.user._id, isDeleted: { $ne: true } };
  if (req.query.status) filter.status = req.query.status;

  const [scans, total] = await Promise.all([
    Scan.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-rawGeminiOutput -errorLog'),
    Scan.countDocuments(filter),
  ]);

  paginated(res, scans, total, page, limit, 'Scan history retrieved');
});

// ── GET /api/scans/stats ─────────────────────────────────────
exports.getScanStats = asyncHandler(async (req, res) => {
  const scans = await Scan.find({
    user:      req.user._id,
    status:    'completed',
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(12)
    .select('overallScore scoreBreakdown createdAt skinType');

  const stats = {
    totalScans:   scans.length,
    latestScore:  scans[0]?.overallScore ?? null,
    scoreHistory: scans.map(s => ({ date: s.createdAt, score: s.overallScore })).reverse(),
    averageScore: scans.length
      ? Math.round(scans.reduce((a, s) => a + (s.overallScore || 0), 0) / scans.length)
      : null,
    improvement: scans.length > 1
      ? (scans[0].overallScore || 0) - (scans[scans.length - 1].overallScore || 0)
      : null,
  };

  success(res, { stats });
});

// ── GET /api/scans/:id ───────────────────────────────────────
exports.getScan = asyncHandler(async (req, res) => {
  const scan = await Scan.findOne({
    $or: [{ _id: req.params.id }, { scanId: req.params.id }],
    user:      req.user._id,
    isDeleted: { $ne: true },
  }).select('-rawGeminiOutput');

  if (!scan) throw new AppError('Scan not found.', 404);
  success(res, { scan });
});

// ── DELETE /api/scans/:id — soft delete ──────────────────────
exports.deleteScan = asyncHandler(async (req, res) => {
  const scan = await Scan.findOne({ _id: req.params.id, user: req.user._id });
  if (!scan) throw new AppError('Scan not found.', 404);
  await scan.softDelete();
  success(res, {}, 'Scan deleted');
});