const Routine  = require('../models/Routine');
const AppError = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');
const { success } = require('../utils/apiresponse');
const { generateRoutine } = require('../services/geminiProductService');

// Valid day enum — matches Mongoose schema
const VALID_DAYS = new Set(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);

// ── Day normaliser (safety net in case service doesn't catch everything) ──
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
  if (VALID_DAYS.has(raw)) return raw;                          // already correct
  const first = String(raw).split(/[\s/,&+]|( or )/i)[0].trim().toLowerCase();
  return DAY_MAP[first] || null;
}

// ── GET /api/routine  — get active routine ────────────────────
exports.getMyRoutine = asyncHandler(async (req, res) => {
  const routine = await Routine.findOne({ user: req.user._id, isActive: true })
    .populate('morning.product', 'name brand priceNGN affiliateUrl')
    .populate('night.product',   'name brand priceNGN affiliateUrl')
    .sort({ updatedAt: -1 });

  if (!routine) throw new AppError('No routine found. Complete a scan first.', 404);
  success(res, { routine });
});

// ── POST /api/routine/generate  — AI generate from scan ───────
exports.generateRoutine = asyncHandler(async (req, res) => {
  const { skinType, conditions, concerns, fitzpatrick } = req.body;

  const routineData = await generateRoutine({ skinType, conditions, concerns, fitzpatrick });

  // Deactivate old routine
  await Routine.updateMany({ user: req.user._id, isActive: true }, { isActive: false });

  // Build weeklySchedule — normalise day at controller level too so validation
  // never fails regardless of what shape weeklyExtras comes back in
  const weeklySchedule = [];
  const seenDays = new Set();

  for (const entry of (routineData.weeklyExtras || [])) {
    const day = normaliseDay(entry.day);
    if (!day || seenDays.has(day)) continue;   // skip invalid or duplicate days
    seenDays.add(day);

    // Support both shapes:
    //   { day, tasks: [...] }  — already normalised by service
    //   { day, task: '...' }   — raw Gemini output
    const tasks = Array.isArray(entry.tasks)
      ? entry.tasks.filter(Boolean)
      : [entry.task].filter(Boolean);

    weeklySchedule.push({ day, tasks });
  }

  const routine = await Routine.create({
    user:    req.user._id,
    morning: routineData.morning,
    night:   routineData.night,
    weeklySchedule,
    skinType,
    concerns,
  });

  success(res, { routine }, 'Routine generated', 201);
});

// ── POST /api/routine/:id/complete-step ───────────────────────
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

// ── PUT /api/routine  — full update ───────────────────────────
exports.updateRoutine = asyncHandler(async (req, res) => {
  const routine = await Routine.findOneAndUpdate(
    { user: req.user._id, isActive: true },
    req.body,
    { new: true, runValidators: true }
  );
  if (!routine) throw new AppError('No active routine.', 404);
  success(res, { routine }, 'Routine updated');
});