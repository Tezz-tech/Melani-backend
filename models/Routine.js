const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  order:         { type: Number },
  timeOfDay:     { type: String, enum: ['morning','night','both'] },
  step:          { type: String },
  productType:   { type: String },
  keyIngredient: { type: String },
  product:       { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  notes:         { type: String },
  completed:     { type: Boolean, default: false },
  completedAt:   { type: Date },
  // Embedded product recommendations matched to this step
  matchedProducts: [{
    name:          { type: String },
    brand:         { type: String },
    priceNGN:      { type: Number },
    category:      { type: String },
    description:   { type: String },
    keyIngredients:[{ type: String }],
    availability:  { type: String },
    rating:        { type: Number },
    routineSlot:   { type: String },
    isUserOwned:   { type: Boolean, default: false }, // true = user typed this in
    userNotes:     { type: String },                  // AI-fitted usage note
  }],
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

    weeklySchedule: [{
      day:    { type: String, enum: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] },
      tasks:  [{ type: String }],
    }],

    streakDays:  { type: Number, default: 0 },
    lastCheckedAt:{ type: Date },
    isActive:    { type: Boolean, default: true },
  },
  { timestamps: true }
);

routineSchema.index({ user: 1, isActive: 1 });

module.exports = mongoose.model('Routine', routineSchema);