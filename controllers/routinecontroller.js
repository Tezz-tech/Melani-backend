const Routine  = require('../models/Routine');
const Scan     = require('../models/Scan');
const AppError = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');
const { success } = require('../utils/apiresponse');
const { generateRoutine, fitUserProduct } = require('../services/geminiProductService');
const logger = require('../utils/logger');

// Valid day enum — matches Mongoose schema
const VALID_DAYS = new Set(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);

// ── Day normaliser ────────────────────────────────────────────
const DAY_MAP = {
  monday:'Mon', mon:'Mon',
  tuesday:'Tue', tue:'Tue',
  wednesday:'Wed', wed:'Wed',
  thursday:'Thu', thu:'Thu',
  friday:'Fri', fri:'Fri',
  saturday:'Sat', sat:'Sat',
  sunday:'Sun', sun:'Sun',
};

function normaliseDay(raw) {
  if (!raw) return null;
  if (VALID_DAYS.has(raw)) return raw;
  const first = String(raw).split(/[\s/,&+]|( or )/i)[0].trim().toLowerCase();
  return DAY_MAP[first] || null;
}

// ── Match scan products to routine steps ─────────────────────
//  Primary match: product.productStep matches step.step (case-insensitive)
//  Secondary: product.routineSlot matches the timeOfDay ('morning'|'night'|'both')
//  This ensures e.g. a Vitamin C Serum only shows on the Serum step.
function matchProductsToSteps(steps = [], products = [], timeOfDay) {
  if (!products.length) return steps;

  // Filter products that belong to this time slot
  const slotProducts = products.filter((p) => {
    const slot = (p.routineSlot || '').toLowerCase();
    return slot === timeOfDay || slot === 'both';
  });

  return steps.map((step) => {
    const stepName = (step.step || '').toLowerCase();

    // Primary: match by productStep name
    const byStep = slotProducts.filter((p) => {
      const ps = (p.productStep || '').toLowerCase();
      return ps === stepName || ps.includes(stepName) || stepName.includes(ps);
    });

    // Secondary fallback: if no step-name match, attach slot products
    const matched = byStep.length ? byStep : [];

    // Preserve all rich fields when mapping into the routine step
    const enriched = matched.slice(0, 2).map((p) => ({
      name:          p.name,
      brand:         p.brand,
      brandOrigin:   p.brandOrigin || '',
      priceNGN:      p.priceNGN,
      category:      p.category,
      description:   p.description,
      keyIngredients:p.keyIngredients || [],
      productStep:   p.productStep,
      routineSlot:   p.routineSlot,
      priority:      p.priority,
      howToUse:      p.howToUse || '',
      frequency:     p.frequency || '',
      amountToUse:   p.amountToUse || '',
      availability:  p.availability || '',
      affiliateLinks:p.affiliateLinks || [],
      affiliateUrl:  p.affiliateUrl || '',
      rating:        p.rating,
    }));

    return { ...step, matchedProducts: enriched };
  });
}


// ── GET /api/routine ─────────────────────────────────────────
exports.getMyRoutine = asyncHandler(async (req, res) => {
  const routine = await Routine.findOne({ user: req.user._id, isActive: true })
    .populate('morning.product', 'name brand priceNGN affiliateUrl')
    .populate('night.product',   'name brand priceNGN affiliateUrl')
    .sort({ updatedAt: -1 });

  if (!routine) throw new AppError('No routine found. Complete a scan first.', 404);
  success(res, { routine });
});

// ── POST /api/routine/generate ───────────────────────────────
exports.generateRoutine = asyncHandler(async (req, res) => {
  const { skinType, conditions, concerns, fitzpatrick, scanId } = req.body;

  const routineData = await generateRoutine({ skinType, conditions, concerns, fitzpatrick });

  // ── Fetch the scan's product recommendations ───────────────
  let scanProducts = [];
  if (scanId) {
    try {
      const scan = await Scan.findOne({
        $or: [{ _id: scanId }, { scanId }],
        user: req.user._id,
      }).select('products');
      if (scan?.products?.length) {
        scanProducts = scan.products;
        logger.info(`routinecontroller: found ${scanProducts.length} scan products to match`);
      }
    } catch (err) {
      logger.warn(`routinecontroller: could not fetch scan products — ${err.message}`);
    }
  }

  // ── Inject matched products into each step ─────────────────
  const morningSteps = matchProductsToSteps(routineData.morning, scanProducts, 'morning');
  const nightSteps   = matchProductsToSteps(routineData.night,   scanProducts, 'night');

  // Deactivate old routine
  await Routine.updateMany({ user: req.user._id, isActive: true }, { isActive: false });

  // Build weeklySchedule
  const weeklySchedule = [];
  const seenDays = new Set();

  for (const entry of (routineData.weeklyExtras || [])) {
    const day = normaliseDay(entry.day);
    if (!day || seenDays.has(day)) continue;
    seenDays.add(day);
    const tasks = Array.isArray(entry.tasks)
      ? entry.tasks.filter(Boolean)
      : [entry.task].filter(Boolean);
    weeklySchedule.push({ day, tasks });
  }

  const routine = await Routine.create({
    user:    req.user._id,
    scan:    scanId || undefined,
    morning: morningSteps,
    night:   nightSteps,
    weeklySchedule,
    skinType,
    concerns,
  });

  logger.info(`routinecontroller: routine created for user ${req.user._id} with ${morningSteps.length} AM + ${nightSteps.length} PM steps`);
  success(res, { routine }, 'Routine generated', 201);
});

// ── POST /api/routine/:id/complete-step ──────────────────────
exports.completeStep = asyncHandler(async (req, res) => {
  const { timeOfDay, order } = req.body;
  if (!['morning','night'].includes(timeOfDay)) throw new AppError('timeOfDay must be morning or night.', 400);

  const routine = await Routine.findOne({ user: req.user._id, isActive: true });
  if (!routine) throw new AppError('No active routine.', 404);

  const steps = routine[timeOfDay];
  const step  = steps.find(s => s.order === parseInt(order));
  if (!step)  throw new AppError('Step not found.', 404);

  step.completed   = !step.completed;
  step.completedAt = step.completed ? new Date() : null;

  // Update streak
  const now       = new Date();
  const lastCheck = routine.lastCheckedAt;
  if (!lastCheck || now.toDateString() !== lastCheck.toDateString()) {
    routine.streakDays++;
    routine.lastCheckedAt = now;
  }

  await routine.save();
  success(res, { routine });
});

// ── PUT /api/routine — full update ────────────────────────────
exports.updateRoutine = asyncHandler(async (req, res) => {
  const routine = await Routine.findOneAndUpdate(
    { user: req.user._id, isActive: true },
    req.body,
    { new: true, runValidators: true }
  );
  if (!routine) throw new AppError('No active routine.', 404);
  success(res, { routine }, 'Routine updated');
});

// ── POST /api/routine/fit-product ────────────────────────────
//  New endpoint: user types a product name → AI determines which
//  routine step it fits and how to use it → saved to that step.
exports.fitUserProduct = asyncHandler(async (req, res) => {
  const { productName } = req.body;
  if (!productName || !productName.trim()) {
    throw new AppError('productName is required.', 400);
  }

  const routine = await Routine.findOne({ user: req.user._id, isActive: true });
  if (!routine) throw new AppError('No active routine found. Please generate a routine first.', 404);

  // ── Ask Gemini where this product fits ────────────────────
  let fitResult;
  try {
    fitResult = await fitUserProduct({
      productName: productName.trim(),
      skinType:    routine.skinType,
      concerns:    routine.concerns || [],
    });
  } catch (err) {
    logger.error(`fitUserProduct: Gemini failed — ${err.message}`);
    throw new AppError('Could not analyse this product. Please try again.', 500);
  }

  // fitResult: { timeOfDay, stepName, usageNote, keyIngredients }
  const { timeOfDay, stepName, usageNote, keyIngredients = [] } = fitResult;

  if (!['morning', 'night', 'both'].includes(timeOfDay)) {
    throw new AppError('AI could not determine where this product fits in your routine.', 422);
  }

  // ── Find the matching step and push the product ───────────
  const slots = timeOfDay === 'both' ? ['morning', 'night'] : [timeOfDay];
  let updated = false;

  for (const slot of slots) {
    const steps = routine[slot];
    const step  = steps.find(s =>
      s.step && s.step.toLowerCase().includes((stepName || '').toLowerCase().split(' ')[0])
    ) || steps[0]; // fallback to first step

    if (step) {
      if (!Array.isArray(step.matchedProducts)) step.matchedProducts = [];
      // Remove any existing entry with the same product name (idempotent)
      step.matchedProducts = step.matchedProducts.filter(
        p => (p.name || '').toLowerCase() !== productName.trim().toLowerCase()
      );
      step.matchedProducts.unshift({
        name:          productName.trim(),
        brand:         '',
        description:   usageNote || `Fits into your ${step.step} step.`,
        keyIngredients,
        routineSlot:   slot,
        isUserOwned:   true,
        userNotes:     usageNote,
      });
      updated = true;
    }
  }

  if (!updated) throw new AppError('Could not match product to any routine step.', 422);

  routine.markModified('morning');
  routine.markModified('night');
  await routine.save();

  logger.info(`fitUserProduct: "${productName}" added to routine for user ${req.user._id}`);
  success(res, { routine, fitResult }, `"${productName.trim()}" added to your routine!`);
});