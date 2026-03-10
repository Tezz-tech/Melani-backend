const User    = require('../models/User');
const Scan    = require('../models/Scan');
const Product = require('../models/Product');
const asyncHandler = require('../utils/asynchandler');
const { success, paginated } = require('../utils/apiresponse');
const { getKeyStatus } = require('../config/gemini');

// ── GET /api/admin/stats ──────────────────────────────────────
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const [totalUsers, activeSubscriptions, totalScans, completedScans] = await Promise.all([
    User.countDocuments({ isActive: true }),
    User.countDocuments({ 'subscription.plan': { $ne: 'free' }, 'subscription.status': 'active' }),
    Scan.countDocuments(),
    Scan.countDocuments({ status: 'completed' }),
  ]);

  const recentUsers = await User.find({ isActive: true })
    .sort({ createdAt: -1 }).limit(5).select('firstName lastName email subscription.plan createdAt');

  success(res, { totalUsers, activeSubscriptions, totalScans, completedScans, recentUsers });
});

// ── GET /api/admin/gemini-status  — key health ────────────────
exports.getGeminiStatus = asyncHandler(async (req, res) => {
  const keyStatus = getKeyStatus();
  success(res, { keys: keyStatus, totalKeys: keyStatus.length });
});

// ── GET /api/admin/users ──────────────────────────────────────
exports.getUsers = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '20');
  const skip  = (page - 1) * limit;

  const filter = {};
  if (req.query.plan)  filter['subscription.plan'] = req.query.plan;
  if (req.query.email) filter.email = { $regex: req.query.email, $options: 'i' };

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  paginated(res, users, total, page, limit);
});

// ── POST /api/admin/products ──────────────────────────────────
exports.createProduct = asyncHandler(async (req, res) => {
  const product = await Product.create(req.body);
  success(res, { product }, 'Product created', 201);
});

// ── PUT /api/admin/products/:id ───────────────────────────────
exports.updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!product) throw new Error('Product not found');
  success(res, { product }, 'Product updated');
});