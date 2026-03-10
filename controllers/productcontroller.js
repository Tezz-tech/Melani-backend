const Product  = require('../models/Product');
const AppError = require('../utils/apperror');
const asyncHandler = require('../utils/asynchandler');
const { success, paginated } = require('../utils/apiresponse');
const { getProductRecommendations, checkIngredientSafety } = require('../services/geminiProductService');

// ── GET /api/products ─────────────────────────────────────────
exports.getProducts = asyncHandler(async (req, res) => {
  const page     = parseInt(req.query.page     || '1');
  const limit    = parseInt(req.query.limit    || '20');
  const skip     = (page - 1) * limit;
  const { category, condition, skinType, minPrice, maxPrice } = req.query;

  const filter = { isActive: true };
  if (category)  filter.category     = category;
  if (skinType)  filter.suitableFor  = { $in: [skinType, 'all'] };
  if (condition) filter.conditions   = { $in: [condition] };
  if (minPrice || maxPrice) {
    filter.priceNGN = {};
    if (minPrice) filter.priceNGN.$gte = parseInt(minPrice);
    if (maxPrice) filter.priceNGN.$lte = parseInt(maxPrice);
  }

  const [products, total] = await Promise.all([
    Product.find(filter).sort({ isFeatured: -1, rating: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  paginated(res, products, total, page, limit);
});

// ── GET /api/products/:id ─────────────────────────────────────
exports.getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError('Product not found.', 404);
  success(res, { product });
});

// ── POST /api/products/recommendations  — AI-powered ──────────
exports.getAIRecommendations = asyncHandler(async (req, res) => {
  const { scanData, budget, concerns } = req.body;
  if (!scanData) throw new AppError('Scan data is required for recommendations.', 400);

  const userProfile = {
    primaryConcerns: concerns || req.user.skinProfile?.primaryConcerns || [],
    allergies:       req.user.skinProfile?.allergies || [],
    budget,
  };

  const recommendations = await getProductRecommendations(scanData, userProfile);
  success(res, { recommendations });
});

// ── POST /api/products/ingredient-check ───────────────────────
exports.checkIngredients = asyncHandler(async (req, res) => {
  const { ingredients } = req.body;
  if (!ingredients?.length) throw new AppError('Provide a list of ingredients to check.', 400);

  const result = await checkIngredientSafety(
    ingredients,
    req.user.skinProfile?.skinType || 'unknown',
    req.user.skinProfile?.fitzpatrickScale || 'IV'
  );

  success(res, { result });
});