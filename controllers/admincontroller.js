const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Scan    = require('../models/Scan');
const Product = require('../models/Product');
const asyncHandler = require('../utils/asynchandler');
const AppError     = require('../utils/apperror');
const { success, paginated } = require('../utils/apiresponse');
const { getKeyStatus } = require('../config/gemini');

// ── POST /api/admin/auth/login ────────────────────────────────
exports.adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError('Email and password are required.', 400);
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
  if (!user) throw new AppError('Invalid credentials.', 401);

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw new AppError('Invalid credentials.', 401);

  if (user.role !== 'admin') {
    throw new AppError('Access denied. Admin privileges required.', 403);
  }

  if (!user.isActive) {
    throw new AppError('Account has been deactivated.', 401);
  }

  const token = jwt.sign(
    { id: user._id, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  success(res, {
    accessToken: token,
    admin: {
      id:        user._id,
      firstName: user.firstName,
      lastName:  user.lastName,
      email:     user.email,
      role:      user.role,
    },
  }, 'Admin login successful');
});

// ── GET /api/admin/stats ──────────────────────────────────────
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const now    = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart  = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  const [
    totalUsers,
    totalActiveUsers,
    totalScans,
    completedScans,
    failedScans,
    totalPaidUsers,
    proUsers,
    eliteUsers,
    freeUsers,
    scansToday,
    scansThisWeek,
    newUsersToday,
    newUsersThisWeek,
    activeRoutines,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ isActive: true }),
    Scan.countDocuments({}),
    Scan.countDocuments({ status: 'completed' }),
    Scan.countDocuments({ status: 'failed' }),
    User.countDocuments({ 'subscription.plan': { $ne: 'free' } }),
    User.countDocuments({ 'subscription.plan': 'pro' }),
    User.countDocuments({ 'subscription.plan': 'elite' }),
    User.countDocuments({ 'subscription.plan': 'free' }),
    Scan.countDocuments({ createdAt: { $gte: todayStart } }),
    Scan.countDocuments({ createdAt: { $gte: weekStart } }),
    User.countDocuments({ createdAt: { $gte: todayStart } }),
    User.countDocuments({ createdAt: { $gte: weekStart } }),
    Scan.countDocuments({ status: 'completed', 'routine.0': { $exists: true } }),
  ]);

  const totalRevenue = (proUsers * 2500) + (eliteUsers * 5000);

  const recentUsers = await User.find({})
    .sort({ createdAt: -1 })
    .limit(10)
    .select('firstName lastName email subscription.plan createdAt isActive');

  const recentScans = await Scan.find({})
    .sort({ createdAt: -1 })
    .limit(10)
    .populate('user', 'firstName lastName email')
    .select('scanId user overallScore status skinType createdAt conditions');

  success(res, {
    totalUsers,
    totalActiveUsers,
    totalScans,
    completedScans,
    failedScans,
    totalPaidUsers,
    proUsers,
    eliteUsers,
    freeUsers,
    totalRevenue,
    scansToday,
    scansThisWeek,
    newUsersToday,
    newUsersThisWeek,
    activeRoutines,
    recentUsers,
    recentScans,
  });
});

// ── GET /api/admin/analytics ──────────────────────────────────
exports.getAnalytics = asyncHandler(async (req, res) => {
  const now   = new Date();
  const days  = 30;
  const start = new Date(now);
  start.setDate(start.getDate() - days);

  // User growth — last 30 days (daily buckets)
  const userGrowthRaw = await User.aggregate([
    { $match: { createdAt: { $gte: start } } },
    {
      $group: {
        _id: {
          year:  { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day:   { $dayOfMonth: '$createdAt' },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
  ]);

  // Scan volume — last 30 days
  const scanVolumeRaw = await Scan.aggregate([
    { $match: { createdAt: { $gte: start } } },
    {
      $group: {
        _id: {
          year:  { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day:   { $dayOfMonth: '$createdAt' },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
  ]);

  // Build full 30-day arrays
  function buildDayArray(rawData) {
    const map = {};
    for (const item of rawData) {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
      map[key] = item.count;
    }
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, count: map[key] || 0 });
    }
    return result;
  }

  const userGrowth  = buildDayArray(userGrowthRaw);
  const scanVolume  = buildDayArray(scanVolumeRaw);

  // Plan distribution
  const [freePlan, proPlan, elitePlan] = await Promise.all([
    User.countDocuments({ 'subscription.plan': 'free' }),
    User.countDocuments({ 'subscription.plan': 'pro' }),
    User.countDocuments({ 'subscription.plan': 'elite' }),
  ]);

  const planDistribution = { free: freePlan, pro: proPlan, elite: elitePlan };

  // Skin type distribution
  const skinTypeRaw = await Scan.aggregate([
    { $match: { status: 'completed', skinType: { $exists: true } } },
    { $group: { _id: '$skinType', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const skinTypeDistribution = skinTypeRaw.map(s => ({ type: s._id, count: s.count }));

  // Fitzpatrick distribution
  const fitzRaw = await Scan.aggregate([
    { $match: { status: 'completed', fitzpatrickEst: { $exists: true } } },
    { $group: { _id: '$fitzpatrickEst', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const fitzpatrickDistribution = fitzRaw.map(f => ({ scale: f._id, count: f.count }));

  // Top conditions
  const conditionsRaw = await Scan.aggregate([
    { $match: { status: 'completed' } },
    { $unwind: '$conditions' },
    { $group: { _id: '$conditions.name', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
  const topConditions = conditionsRaw.map(c => ({ condition: c._id, count: c.count }));

  success(res, {
    userGrowth,
    scanVolume,
    planDistribution,
    skinTypeDistribution,
    fitzpatrickDistribution,
    topConditions,
  });
});

// ── GET /api/admin/users ──────────────────────────────────────
exports.getUsers = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page  || '1', 10);
  const limit = parseInt(req.query.limit || '20', 10);
  const skip  = (page - 1) * limit;

  const filter = {};
  if (req.query.plan)     filter['subscription.plan'] = req.query.plan;
  if (req.query.isActive) filter.isActive = req.query.isActive === 'true';
  if (req.query.search) {
    const re = { $regex: req.query.search, $options: 'i' };
    filter.$or = [{ email: re }, { firstName: re }, { lastName: re }];
  }

  const sortField = req.query.sort || 'createdAt';
  const sortDir   = req.query.order === 'asc' ? 1 : -1;
  const sort      = { [sortField]: sortDir };

  const [users, total] = await Promise.all([
    User.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  // Attach scan count per user
  const userIds  = users.map(u => u._id);
  const scanCounts = await Scan.aggregate([
    { $match: { user: { $in: userIds } } },
    { $group: { _id: '$user', count: { $sum: 1 } } },
  ]);
  const scanCountMap = {};
  for (const sc of scanCounts) scanCountMap[String(sc._id)] = sc.count;

  const usersWithCount = users.map(u => ({
    ...u,
    scanCount: scanCountMap[String(u._id)] || 0,
  }));

  paginated(res, usersWithCount, total, page, limit);
});

// ── GET /api/admin/users/:id ──────────────────────────────────
exports.getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).lean();
  if (!user) throw new AppError('User not found.', 404);

  const [scanCount, lastScan] = await Promise.all([
    Scan.countDocuments({ user: user._id }),
    Scan.findOne({ user: user._id }).sort({ createdAt: -1 }).select('createdAt overallScore skinType status'),
  ]);

  // Count routines (scans that have at least one routine step)
  const routineCount = await Scan.countDocuments({
    user:       user._id,
    status:     'completed',
    'routine.0': { $exists: true },
  });

  success(res, {
    user: {
      ...user,
      scanCount,
      routineCount,
      lastScan,
    },
  });
});

// ── PATCH /api/admin/users/:id ────────────────────────────────
exports.updateUser = asyncHandler(async (req, res) => {
  const { plan, isActive, role } = req.body;

  const updates = {};
  if (typeof isActive === 'boolean') updates.isActive = isActive;
  if (role && ['user', 'admin'].includes(role)) updates.role = role;

  if (plan && ['free', 'pro', 'elite'].includes(plan)) {
    updates['subscription.plan']      = plan;
    updates['subscription.status']    = 'active';
    updates['subscription.startedAt'] = new Date();
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: updates },
    { new: true, runValidators: true }
  );
  if (!user) throw new AppError('User not found.', 404);

  success(res, { user }, 'User updated successfully.');
});

// ── DELETE /api/admin/users/:id ───────────────────────────────
exports.deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { isActive: false } },
    { new: true }
  );
  if (!user) throw new AppError('User not found.', 404);
  success(res, null, 'User deactivated successfully.');
});

// ── GET /api/admin/scans ──────────────────────────────────────
exports.getScans = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page  || '1', 10);
  const limit = parseInt(req.query.limit || '20', 10);
  const skip  = (page - 1) * limit;

  const filter = {};
  if (req.query.status)   filter.status = req.query.status;
  if (req.query.userId)   filter.user   = req.query.userId;
  if (req.query.dateFrom || req.query.dateTo) {
    filter.createdAt = {};
    if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
    if (req.query.dateTo)   filter.createdAt.$lte = new Date(req.query.dateTo);
  }
  if (req.query.minScore || req.query.maxScore) {
    filter.overallScore = {};
    if (req.query.minScore) filter.overallScore.$gte = Number(req.query.minScore);
    if (req.query.maxScore) filter.overallScore.$lte = Number(req.query.maxScore);
  }

  const [scans, total] = await Promise.all([
    Scan.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'firstName lastName email'),
    Scan.countDocuments(filter),
  ]);

  paginated(res, scans, total, page, limit);
});

// ── GET /api/admin/scans/:id ──────────────────────────────────
exports.getScanById = asyncHandler(async (req, res) => {
  const scan = await Scan.findById(req.params.id)
    .populate('user', 'firstName lastName email phone subscription');
  if (!scan) throw new AppError('Scan not found.', 404);
  success(res, { scan });
});

// ── DELETE /api/admin/scans/:id ───────────────────────────────
exports.deleteScan = asyncHandler(async (req, res) => {
  const scan = await Scan.findByIdAndDelete(req.params.id);
  if (!scan) throw new AppError('Scan not found.', 404);
  success(res, null, 'Scan deleted successfully.');
});

// ── GET /api/admin/subscriptions ─────────────────────────────
exports.getSubscriptions = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page  || '1', 10);
  const limit = parseInt(req.query.limit || '20', 10);
  const skip  = (page - 1) * limit;

  const filter = { 'subscription.plan': { $ne: 'free' } };
  if (req.query.plan)   filter['subscription.plan']   = req.query.plan;
  if (req.query.status) filter['subscription.status'] = req.query.status;

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ 'subscription.startedAt': -1 })
      .skip(skip)
      .limit(limit)
      .select('firstName lastName email subscription createdAt'),
    User.countDocuments(filter),
  ]);

  paginated(res, users, total, page, limit);
});

// ── GET /api/admin/products ───────────────────────────────────
exports.getProducts = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page  || '1', 10);
  const limit = parseInt(req.query.limit || '20', 10);
  const skip  = (page - 1) * limit;

  const filter = {};
  if (req.query.category)    filter.category    = req.query.category;
  if (req.query.routineSlot) filter.routineSlot = req.query.routineSlot;
  if (req.query.search) {
    const re = { $regex: req.query.search, $options: 'i' };
    filter.$or = [{ name: re }, { brand: re }];
  }

  const [products, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  paginated(res, products, total, page, limit);
});

// ── POST /api/admin/products ──────────────────────────────────
exports.createProduct = asyncHandler(async (req, res) => {
  const product = await Product.create(req.body);
  success(res, { product }, 'Product created', 201);
});

// ── PUT /api/admin/products/:id ───────────────────────────────
exports.updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true, runValidators: true }
  );
  if (!product) throw new AppError('Product not found.', 404);
  success(res, { product }, 'Product updated');
});

// ── DELETE /api/admin/products/:id ───────────────────────────
exports.deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) throw new AppError('Product not found.', 404);
  success(res, null, 'Product deleted successfully.');
});

// ── GET /api/admin/gemini-status ──────────────────────────────
exports.getGeminiStatus = asyncHandler(async (req, res) => {
  const keyStatus = getKeyStatus();
  success(res, { keys: keyStatus, totalKeys: keyStatus.length });
});

// ── GET /api/admin/health ─────────────────────────────────────
exports.getSystemHealth = asyncHandler(async (req, res) => {
  const mem = process.memoryUsage();

  const totalUsers = await User.countDocuments({});

  success(res, {
    uptime:        process.uptime(),
    memoryUsage:   {
      heapUsed:   mem.heapUsed,
      heapTotal:  mem.heapTotal,
      rss:        mem.rss,
      external:   mem.external,
    },
    nodeVersion:   process.version,
    platform:      process.platform,
    totalUsers,
    dbStatus:      'connected',
    timestamp:     new Date().toISOString(),
  });
});
