const mongoose = require('mongoose');

const conditionSchema = new mongoose.Schema({
  name:            { type: String, required: true },
  severity:        { type: String, enum: ['mild','moderate','severe'] },
  confidence:      { type: Number, min: 0, max: 100 },
  melaninNote:     { type: String },
  affectedAreas:   [{ type: String }],
}, { _id: false });

const scoreBreakdownSchema = new mongoose.Schema({
  hydration: { type: Number, min: 0, max: 100 },
  clarity:   { type: Number, min: 0, max: 100 },
  evenness:  { type: Number, min: 0, max: 100 },
  texture:   { type: Number, min: 0, max: 100 },
  glow:      { type: Number, min: 0, max: 100 },
}, { _id: false });

const routineStepSchema = new mongoose.Schema({
  order:         { type: Number },
  step:          { type: String },   // e.g. 'Cleanse'
  productType:   { type: String },   // e.g. 'Gentle foaming cleanser'
  keyIngredient: { type: String },
  notes:         { type: String },
  timeOfDay:     { type: String, enum: ['morning','night','both'] },
}, { _id: false });

const productRecommendationSchema = new mongoose.Schema({
  name:          { type: String },
  brand:         { type: String },
  priceNGN:      { type: Number },
  category:      { type: String },
  keyIngredients:[{ type: String }],
  availability:  { type: String },
  rating:        { type: Number },
  affiliateUrl:  { type: String },
}, { _id: false });

const scanSchema = new mongoose.Schema(
  {
    // ── Owner ─────────────────────────────────────────────────
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scanId:   { type: String, unique: true }, // human-readable: MS-YYYYMMDD-XXX

    // ── Image ─────────────────────────────────────────────────
    imageUrl:  { type: String },   // stored path (or S3 URL)
    imageKey:  { type: String },   // S3 key if applicable
    imageHash: { type: String },   // SHA-256 for dedup

    // ── AI Analysis ───────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['pending','processing','completed','failed'],
      default: 'pending',
    },

    skinType:   { type: String, enum: ['oily','dry','combination','normal','unknown'] },
    confidence: { type: Number, min: 0, max: 100 },

    overallScore:    { type: Number, min: 0, max: 100 },
    scoreBreakdown:  scoreBreakdownSchema,

    fitzpatrickEst:  { type: String, enum: ['I','II','III','IV','V','VI','unknown'] },

    conditions: [conditionSchema],

    melaninInsights: {
      pihRisk:         { type: String, enum: ['low','moderate','high'] },
      spfGuidance:     { type: String },
      sensitivityFlags:[{ type: String }],
      melanocyteNotes: { type: String },
    },

    goodIngredients:  [{ type: String }],
    avoidIngredients: [{ type: String }],

    routine:  [routineStepSchema],
    products: [productRecommendationSchema],

    // ── Gemini metadata ───────────────────────────────────────
    geminiModel:     { type: String },
    geminiKeyIndex:  { type: Number },  // which key slot was used
    processingTimeMs:{ type: Number },
    rawGeminiOutput: { type: String, select: false }, // full JSON for debugging

    // ── Progress context ──────────────────────────────────────
    progressMilestones: [{
      week:  { type: Number },
      label: { type: String },
      description: { type: String },
    }],

    isDeleted: { type: Boolean, default: false, select: false },
    errorLog:  { type: String, select: false },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────
scanSchema.index({ user: 1, createdAt: -1 });
scanSchema.index({ scanId: 1 });
scanSchema.index({ status: 1 });

// ── Pre-save: generate scanId ─────────────────────────────────
scanSchema.pre('save', async function (next) {
  if (this.isNew && !this.scanId) {
    const date    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random  = Math.floor(Math.random() * 9000 + 1000);
    this.scanId   = `MS-${date}-${random}`;
  }
  next();
});

// ── Soft delete helper ────────────────────────────────────────
scanSchema.methods.softDelete = function () {
  this.isDeleted = true;
  return this.save();
};

module.exports = mongoose.model('Scan', scanSchema);