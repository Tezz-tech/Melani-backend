const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  order:         { type: Number },
  timeOfDay:     { type: String, enum: ['morning', 'night', 'both'] },
  step:          { type: String },
  productType:   { type: String },
  keyIngredient: { type: String },
  product:       { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  notes:         { type: String },
  durationSeconds: { type: Number },
  completed:     { type: Boolean, default: false },
  completedAt:   { type: Date },

  // ── Embedded product recommendations matched to this step ────
  matchedProducts: [
    {
      name:          { type: String },
      brand:         { type: String },
      brandOrigin:   { type: String },        // e.g. 'Nigerian', 'South African', 'US'
      priceNGN:      { type: Number },
      category:      { type: String },
      description:   { type: String },        // why this suits their skin specifically
      keyIngredients:[{ type: String }],
      // ── Routine linking ──────────────────────────────────────
      productStep:   { type: String },        // e.g. 'Cleanse', 'Serum', 'SPF', 'Eye Cream'
      routineSlot:   { type: String },        // 'morning' | 'night' | 'both'
      priority:      { type: Number },        // 1 = most essential
      // ── Usage details ────────────────────────────────────────
      howToUse:      { type: String },        // step-by-step usage instructions
      frequency:     { type: String },        // e.g. 'Twice daily', 'Every other night'
      amountToUse:   { type: String },        // e.g. '2–3 drops', 'Pea-sized amount'
      // ── Sourcing ─────────────────────────────────────────────
      availability:  { type: String },        // summary: 'Jumia, Konga, Skincare stores'
      affiliateLinks: [
        {
          store:    { type: String },         // e.g. 'Jumia', 'Konga', 'BeautyHub NG'
          url:      { type: String },
          priceNGN: { type: Number },
        },
      ],
      affiliateUrl:  { type: String },        // legacy single URL
      rating:        { type: Number },
      // ── User product flags ───────────────────────────────────
      isUserOwned:   { type: Boolean, default: false }, // true = user typed this in
      userNotes:     { type: String },                  // AI-fitted usage note
    },
  ],
}, { _id: false });

const routineSchema = new mongoose.Schema(
  {
    user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scan:       { type: mongoose.Schema.Types.ObjectId, ref: 'Scan' },
    name:       { type: String, default: 'My Routine' },

    morning:    [stepSchema],
    night:      [stepSchema],

    skinType:    { type: String },
    concerns:    [{ type: String }],

    weeklySchedule: [
      {
        day:   { type: String, enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
        tasks: [{ type: String }],
      },
    ],

    streakDays:    { type: Number, default: 0 },
    lastCheckedAt: { type: Date },
    isActive:      { type: Boolean, default: true },
  },
  { timestamps: true }
);

routineSchema.index({ user: 1, isActive: 1 });

module.exports = mongoose.model('Routine', routineSchema);