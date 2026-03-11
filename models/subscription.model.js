// src/models/Subscription.model.js
'use strict';

const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan:     { type: String, enum: ['free', 'pro', 'elite'], required: true },
  billing:  { type: String, enum: ['monthly', 'yearly'] },
  status:   { type: String, enum: ['active', 'expired', 'cancelled', 'trialing', 'past_due', 'pending'], default: 'pending' },

  // Paystack
  paystackReference:      { type: String },
  paystackSubscriptionId: { type: String },
  paystackEmailToken:     { type: String },
  paystackCustomerId:     { type: String },
  paystackPlanCode:       { type: String },
  amountNGN:              { type: Number },

  startedAt:   { type: Date },
  expiresAt:   { type: Date },
  cancelledAt: { type: Date },
  renewedAt:   { type: Date },

  // Webhook event log
  webhookEvents: [{
    event:      { type: String },
    receivedAt: { type: Date, default: Date.now },
  }],

}, { timestamps: true });

SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ paystackReference: 1 });
SubscriptionSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('Subscription', SubscriptionSchema);