const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    brand:         { type: String, required: true, trim: true },
    category:      { type: String, enum: ['cleanser','toner','serum','moisturiser','spf','treatment','mask','oil','other'] },
    priceNGN:      { type: Number },
    priceUSD:      { type: Number },
    description:   { type: String },
    keyIngredients:[{ type: String }],
    avoidIngredients:[{ type: String }],
    suitableFor:   [{ type: String, enum: ['oily','dry','combination','normal','all'] }],
    conditions:    [{ type: String }], // e.g. ['PIH','acne','hyperpigmentation']
    fitzpatrickMin:{ type: Number, min: 1, max: 6, default: 1 },
    fitzpatrickMax:{ type: Number, min: 1, max: 6, default: 6 },
    availability:  { type: String },  // 'Jumia, Konga, ShopRite'
    affiliateUrl:  { type: String },
    imageUrl:      { type: String },
    rating:        { type: Number, min: 0, max: 5 },
    reviewCount:   { type: Number, default: 0 },
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

module.exports = mongoose.model('Product', productSchema);