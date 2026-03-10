const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const userSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    firstName: { type: String, required: true, trim: true, maxlength: 50 },
    lastName: { type: String, required: true, trim: true, maxlength: 50 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },

    // ── Skin profile ──────────────────────────────────────────
    skinProfile: {
      skinType: {
        type: String,
        enum: ["oily", "dry", "combination", "normal", "unknown"],
        default: "unknown",
      },
      fitzpatrickScale: {
        type: String,
        enum: ["I", "II", "III", "IV", "V", "VI", "unknown"],
        default: "unknown",
      },
      primaryConcerns: [{ type: String }],
      allergies: [{ type: String }],
      currentProducts: [{ type: String }],
    },

    // ── Subscription ──────────────────────────────────────────
    subscription: {
      plan: { type: String, enum: ["free", "pro", "elite"], default: "free" },
      status: {
        type: String,
        enum: ["active", "cancelled", "expired", "trialing"],
        default: "active",
      },
      startedAt: { type: Date },
      expiresAt: { type: Date },
      paystackRef: { type: String },
      cancelledAt: { type: Date },
    },

    // ── Scan usage ────────────────────────────────────────────
    scanUsage: {
      monthlyCount: { type: Number, default: 0 },
      lastResetAt: { type: Date, default: Date.now },
    },

    // ── Auth / security ───────────────────────────────────────
    isEmailVerified: { type: Boolean, default: false },
    emailVerifyToken: { type: String, select: false },
    emailVerifyExpires: { type: Date, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    refreshToken: { type: String, select: false },
    lastLoginAt: { type: Date },
    isActive: { type: Boolean, default: true },

    // ── Settings ──────────────────────────────────────────────
    settings: {
      notifications: {
        routine: { type: Boolean, default: true },
        scanReminder: { type: Boolean, default: true },
        progressReport: { type: Boolean, default: true },
        promotional: { type: Boolean, default: false },
      },
      privacy: {
        storeScans: { type: Boolean, default: true },
        analytics: { type: Boolean, default: true },
        aiTraining: { type: Boolean, default: false },
      },
    },
  },
  { timestamps: true },
);

// ── Indexes ───────────────────────────────────────────────────
userSchema.index({ email: 1 });
userSchema.index({ "subscription.expiresAt": 1 });

// ── Pre-save: hash password ───────────────────────────────────
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  if (!this.password || typeof this.password !== "string" || !this.password.trim()) {
    return next(new Error("Password must be provided and non-empty."));
  }
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Instance: compare password ────────────────────────────────
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── Instance: create password reset token ─────────────────────
userSchema.methods.createPasswordResetToken = function () {
  const raw = crypto.randomBytes(32).toString("hex");
  this.passwordResetToken = crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex");
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 min
  return raw;
};

// ── Instance: check if can scan this month ─────────────────────
userSchema.methods.canScan = function () {
  const plan = this.subscription.plan;
  if (plan === "pro" || plan === "elite") return true;

  // Reset monthly count if new month
  const now = new Date();
  const lastReset = new Date(this.scanUsage.lastResetAt);
  if (
    now.getMonth() !== lastReset.getMonth() ||
    now.getFullYear() !== lastReset.getFullYear()
  ) {
    this.scanUsage.monthlyCount = 0;
    this.scanUsage.lastResetAt = now;
  }

  return this.scanUsage.monthlyCount < 3; // free = 3 scans/month
};

// ── Virtual: full name ────────────────────────────────────────
userSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

module.exports = mongoose.model("User", userSchema);
