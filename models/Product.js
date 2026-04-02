const mongoose = require('mongoose');

// ── Per-store affiliate link ──────────────────────────────────
const affiliateLinkSchema = new mongoose.Schema({
  store:  { type: String }, // e.g. 'Jumia', 'Konga', 'Skincare by Arewa', 'BeautyHub NG'
  url:    { type: String },
  priceNGN: { type: Number }, // price may differ per store
}, { _id: false });

const productSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    brand:         { type: String, required: true, trim: true },
    brandOrigin:   { type: String },  // e.g. 'Nigerian', 'South African', 'US'
    category: {
      type: String,
      enum: [
        'cleanser', 'micellar-water', 'toner', 'essence', 'serum',
        'moisturiser', 'face-oil', 'spf', 'eye-cream', 'lip-care',
        'treatment', 'spot-treatment', 'mask', 'exfoliant',
        'mist', 'body-lotion', 'body-oil', 'other'
      ]
    },
    // ── Pricing ─────────────────────────────────────────────
    priceNGN:      { type: Number },
    priceUSD:      { type: Number },
    // ── Ingredients ───────────────────────────────────────────
    keyIngredients:  [{ type: String }],
    avoidIngredients:[{ type: String }],
    // ── Skin fit ──────────────────────────────────────────────
    suitableFor:   [{ type: String, enum: ['oily', 'dry', 'combination', 'normal', 'sensitive', 'all'] }],
    conditions:    [{ type: String }], // e.g. ['PIH','acne','hyperpigmentation','dark-spots']
    fitzpatrickMin:{ type: Number, min: 1, max: 6, default: 1 },
    fitzpatrickMax:{ type: Number, min: 1, max: 6, default: 6 },
    // ── Routine fit ───────────────────────────────────────────
    productStep:   { type: String }, // e.g. 'Cleanse', 'Serum', 'SPF', 'Eye Cream'
    routineSlot:   { type: String, enum: ['morning', 'night', 'both'] },
    // ── Usage ─────────────────────────────────────────────────
    description:   { type: String },
    howToUse:      { type: String }, // step-by-step usage instructions
    frequency:     { type: String }, // e.g. 'Twice daily', 'Every other night', '2x per week'
    amountToUse:   { type: String }, // e.g. 'Pea-sized amount', '2-3 drops', 'Pump'
    // ── Sourcing ──────────────────────────────────────────────
    availability:  { type: String },  // free-text summary: 'Jumia, Konga, ShopRite'
    affiliateLinks:[affiliateLinkSchema], // per-store links with prices
    affiliateUrl:  { type: String }, // legacy single URL
    imageUrl:      { type: String },
    // ── Ratings ───────────────────────────────────────────────
    rating:        { type: Number, min: 0, max: 5 },
    reviewCount:   { type: Number, default: 0 },
    // ── Flags ─────────────────────────────────────────────────
    isActive:      { type: Boolean, default: true },
    isFeatured:    { type: Boolean, default: false },
    country:       { type: String, default: 'NG' },
    tags:          [{ type: String }],
  },
  { timestamps: true }
);

productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ conditions: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ rating: -1 });
productSchema.index({ productStep: 1 });

module.exports = mongoose.model('Product', productSchema);