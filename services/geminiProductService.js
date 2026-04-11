/**
 * ─────────────────────────────────────────────────────────────
 *  GEMINI PRODUCT RECOMMENDATION SERVICE
 *  Takes the scan result and user profile and returns curated
 *  product recommendations specifically for Nigerian market.
 * ─────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');
const { runWithRotation } = require('../config/gemini');

// Deterministic 6-char seed from userId + skinType (no crypto needed)
function getUserSkinHash(userId = '', skinType = '') {
  const src = `${userId}:${skinType}`.toLowerCase();
  let h = 0;
  for (let i = 0; i < src.length; i++) {
    h = (Math.imul(31, h) + src.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).slice(0, 6);
}

const PRODUCT_PROMPT_TEMPLATE = (scanData, userProfile, userSeed = '') => `
You are a skincare product recommendation AI specialising in melanin-rich skin in Nigeria.
You MUST return ONLY a valid JSON array of product recommendations — no markdown, no text outside the array.
User profile seed: ${userSeed || 'default'} — always return the SAME products for the same seed and skin type.

SCAN RESULTS:
- Skin Type: ${scanData.skinType}
- Overall Score: ${scanData.overallScore}/100
- Fitzpatrick: ${scanData.fitzpatrickEst || 'IV-V'}
- Conditions: ${(scanData.conditions || []).map(c => `${c.name} (${c.severity})`).join(', ') || 'none'}
- PIH Risk: ${scanData.melaninInsights?.pihRisk || 'unknown'}
- Good Ingredients: ${(scanData.goodIngredients || []).join(', ') || 'none'}
- Avoid: ${(scanData.avoidIngredients || []).join(', ') || 'none'}
- Routine Steps from Scan: ${(scanData.routine || []).map(r => r.step).join(', ') || 'Cleanse, Tone, Serum, Moisturise, SPF'}

USER PROFILE:
- Concerns: ${(userProfile.primaryConcerns || []).join(', ') || 'none'}
- Allergies: ${(userProfile.allergies || []).join(', ') || 'none'}
- Budget: ${userProfile.budget || 'mid-range (₦1,500–₦10,000 per product)'}

Return a JSON array of EXACTLY 10 products covering ALL these categories in order:
1. Cleanser (morning/night double cleanse step)
2. Toner or Essence (hydration/prep step)
3. Vitamin C or Brightening Serum (morning step)
4. Treatment Serum — niacinamide, alpha arbutin, or AHA/BHA (targeted at this person's conditions)
5. Lightweight Moisturiser (daytime step)
6. SPF 50 Sunscreen (morning — mandatory for all melanin skin)
7. Night Cream or Repair Moisturiser (night step)
8. Face Oil (night sealing step)
9. Eye Cream (morning and/or night)
10. Weekly Treatment — clay mask, exfoliating mask, or sheet mask (weekly step)

Each product MUST follow this EXACT JSON structure:
[
  {
    "name":          "<exact product name>",
    "brand":         "<brand name>",
    "brandOrigin":   "<Nigerian|South African|Ghanaian|UK|US|French>",
    "category":      "<cleanser|toner|essence|serum|moisturiser|face-oil|spf|eye-cream|treatment|mask|exfoliant>",
    "productStep":   "<EXACT step name from scan routine e.g. Cleanse, Tone, Serum, Moisturise, SPF, Eye Cream, Oil, Treatment, Mask>",
    "routineSlot":   "<morning|night|both>",
    "priority":      <1-10 where 1 = most essential for this specific person>,
    "description":   "<2 sentences: why this product suits THIS person's specific skin analysis>",
    "keyIngredients":["<ingredient1>", "<ingredient2>", "<ingredient3>"],
    "howToUse":      "<step-by-step: e.g. 'Apply 2-3 drops to clean damp skin. Gently press in with fingertips. Follow with moisturiser.'>",
    "frequency":     "<e.g. Twice daily | Every morning | Every night | Every other night | 2x per week>",
    "amountToUse":   "<e.g. 2–3 drops | Pea-sized amount | One pump | Thin layer>",
    "availability":  "<summary of where to buy in Nigeria>",
    "affiliateLinks": [
      { "store": "Jumia",    "url": "https://www.jumia.com.ng/catalog/?q=<product+name+encoded>" },
      { "store": "Konga",    "url": "https://www.konga.com/search?search=<product+name+encoded>" },
      { "store": "GlowRoad", "url": "https://glowroad.com.ng/search?q=<product+name+encoded>" }
    ],
    "rating": <3.5-5.0>
  }
]

STRICT RULES:
- Products MUST be available or easily sourced in Nigeria — real brands only
- Prioritise Nigerian and African brands (e.g. Zaron, Olay, Nivea, SheaMoisture, Neutrogena, La Roche-Posay, CeraVe, Klairs, Inkey List, Ordinary, Skin Def) where relevant
- All products MUST be free of: ${(scanData.avoidIngredients || ['fragrance', 'alcohol denat.']).join(', ')}
- For PIH risk "${scanData.melaninInsights?.pihRisk || 'moderate'}": prioritise niacinamide, alpha arbutin, vitamin C
- SPF 50 is NON-NEGOTIABLE — item 6 must be a sunscreen
- "productStep" MUST exactly match one of the step names in the person's scan routine
- "howToUse" must be practical, specific, and tailored to this skin type — not generic
- "affiliateLinks" urls: encode spaces as + in the product name query string
- Do NOT invent fake brands — use real brands sold in Nigeria
`.trim();

// ── Fallback products for when Gemini returns < 3 ────────────
//  These are real, widely-available Nigerian-market products.
//  Adjusted per skin type so the minimum 3 are always relevant.
function buildFallbackProducts(skinType = 'combination', conditions = []) {
  const st = skinType.toLowerCase();
  const isOily = st.includes('oily');
  const isDry  = st.includes('dry');

  const cleanser = isOily ? {
    name: 'CeraVe Foaming Facial Cleanser',
    brand: 'CeraVe', brandOrigin: 'US', category: 'cleanser',
    productStep: 'Cleanse', routineSlot: 'both', priority: 1,
    description: 'Foaming cleanser that removes excess oil and impurities without stripping the skin barrier. Ceramides restore moisture balance after cleansing, essential for oily melanin-rich skin prone to PIH.',
    keyIngredients: ['Niacinamide', 'Ceramides', 'Hyaluronic Acid'],
    howToUse: 'Wet face with lukewarm water. Apply a small amount and massage gently for 60 seconds. Rinse thoroughly and pat dry.',
    frequency: 'Twice daily', amountToUse: 'Coin-sized amount',
    availability: 'Available on Jumia, Konga, and beauty stores across Lagos and Abuja',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=CeraVe+Foaming+Facial+Cleanser' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=CeraVe+Foaming+Facial+Cleanser' },
    ], rating: 4.7,
  } : {
    name: 'CeraVe Hydrating Facial Cleanser',
    brand: 'CeraVe', brandOrigin: 'US', category: 'cleanser',
    productStep: 'Cleanse', routineSlot: 'both', priority: 1,
    description: 'Gentle, non-foaming cleanser that hydrates while cleansing — ideal for dry or combination melanin-rich skin. Ceramides and hyaluronic acid reinforce the skin barrier with every wash.',
    keyIngredients: ['Ceramides', 'Hyaluronic Acid', 'Glycerin'],
    howToUse: 'Apply to damp skin and massage gently for 60 seconds. Rinse with lukewarm water and pat dry.',
    frequency: 'Twice daily', amountToUse: 'Coin-sized amount',
    availability: 'Available on Jumia, Konga, and pharmacies across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=CeraVe+Hydrating+Cleanser' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=CeraVe+Hydrating+Cleanser' },
    ], rating: 4.8,
  };

  const moisturiser = isOily ? {
    name: 'Neutrogena Hydro Boost Water Gel',
    brand: 'Neutrogena', brandOrigin: 'US', category: 'moisturiser',
    productStep: 'Moisturise', routineSlot: 'both', priority: 2,
    description: 'Oil-free water gel that delivers intense hydration without clogging pores. Hyaluronic acid draws moisture into skin — a must-have daily moisturiser for oily melanin-rich skin.',
    keyIngredients: ['Hyaluronic Acid', 'Glycerin', 'Dimethicone'],
    howToUse: 'Apply a pea-sized amount to clean face morning and night. Gently press in with fingertips.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized amount',
    availability: 'Available on Jumia, Konga, Shoprite, and supermarkets across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Neutrogena+Hydro+Boost+Water+Gel' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Neutrogena+Hydro+Boost+Water+Gel' },
    ], rating: 4.6,
  } : isDry ? {
    name: 'CeraVe Moisturising Cream',
    brand: 'CeraVe', brandOrigin: 'US', category: 'moisturiser',
    productStep: 'Moisturise', routineSlot: 'both', priority: 2,
    description: 'Rich ceramide cream that restores and maintains the skin barrier for dry melanin-rich skin. Sustained 24-hour hydration with a non-greasy finish that does not trigger PIH.',
    keyIngredients: ['Ceramides', 'Hyaluronic Acid', 'Niacinamide'],
    howToUse: 'Apply a small amount to clean face morning and night. Can also be used on body for extra dry areas.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized amount',
    availability: 'Available on Jumia, Konga, and pharmacies across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=CeraVe+Moisturising+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=CeraVe+Moisturising+Cream' },
    ], rating: 4.8,
  } : {
    name: 'Olay Regenerist Micro-Sculpting Cream',
    brand: 'Olay', brandOrigin: 'US', category: 'moisturiser',
    productStep: 'Moisturise', routineSlot: 'both', priority: 2,
    description: 'Lightweight daily moisturiser with niacinamide that visibly improves skin tone uniformity — critical for melanin-rich skin prone to uneven pigmentation and dark spots.',
    keyIngredients: ['Niacinamide', 'Hyaluronic Acid', 'Amino-Peptides'],
    howToUse: 'Apply a small amount to face and neck morning and night after cleansing.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized amount',
    availability: 'Available on Jumia, Konga, Shoprite, and supermarkets across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Olay+Regenerist+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Olay+Regenerist+Cream' },
    ], rating: 4.5,
  };

  const spf = {
    name: 'Neutrogena Ultra Sheer Dry-Touch SPF 50+',
    brand: 'Neutrogena', brandOrigin: 'US', category: 'spf',
    productStep: 'SPF', routineSlot: 'morning', priority: 3,
    description: 'Non-negotiable broad-spectrum SPF 50+ that dries to a matte finish — essential for all melanin-rich skin to prevent UV-triggered hyperpigmentation, PIH, and premature ageing.',
    keyIngredients: ['Avobenzone', 'Homosalate', 'Octisalate'],
    howToUse: 'Apply as the final step of your morning routine. Use two finger-lengths for face and neck. Reapply every 2 hours when outdoors.',
    frequency: 'Every morning (non-negotiable)', amountToUse: 'Two finger-lengths',
    availability: 'Available on Jumia, Konga, pharmacies, and Shoprite nationwide',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Neutrogena+Ultra+Sheer+SPF+50' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Neutrogena+Ultra+Sheer+SPF+50' },
    ], rating: 4.8,
  };

  return [cleanser, moisturiser, spf];
}

// ── Ensure products array always has ≥ 3 entries ──────────────
//  Called after getProductRecommendations(). If Gemini returns
//  fewer than 3 products (or fails entirely), fallback products
//  are appended for the missing essential categories.
function ensureMinimumProducts(products, scanData = {}, userProfile = {}) {
  const MIN = 3;
  if (Array.isArray(products) && products.length >= MIN) return products;

  const base    = Array.isArray(products) ? [...products] : [];
  const skinType = scanData.skinType || userProfile.skinType || 'combination';
  const fallbacks = buildFallbackProducts(skinType, scanData.conditions || []);

  // Only add fallbacks for categories not already present
  const existingSteps = new Set(base.map(p => (p.productStep || '').toLowerCase()));
  for (const fb of fallbacks) {
    if (!existingSteps.has((fb.productStep || '').toLowerCase())) {
      base.push(fb);
      existingSteps.add((fb.productStep || '').toLowerCase());
    }
    if (base.length >= MIN) break;
  }

  // If still fewer than MIN (all 3 steps already present but < 3 total), just return what we have
  logger.info(`ensureMinimumProducts: final count = ${base.length} (was ${products?.length ?? 0})`);
  return base;
}

async function getProductRecommendations(scanData, userProfile = {}) {
  const userSeed = getUserSkinHash(userProfile.userId || '', scanData.skinType || '');
  const prompt   = PRODUCT_PROMPT_TEMPLATE(scanData, userProfile, userSeed);

  logger.info('Gemini products: generating recommendations (10 products, seed=%s)', userSeed);

  const result = await runWithRotation(async (client) => {
    const model = client.getGenerativeModel({
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature:     0.2,   // lower = more consistent per seed+skintype
        topP:            0.85,
        maxOutputTokens: 4096,
      },
    });

    const response = await model.generateContent(prompt);
    return response.response.text();
  });

  let products;
  try {
    products = repairJson(result);
  } catch (e) {
    logger.error('getProductRecommendations: JSON parse failed', { preview: result.slice(0, 200) });
    throw new Error('Gemini returned invalid JSON for product recommendations. Please try again.');
  }
  if (!Array.isArray(products)) {
    throw new Error('Gemini product response is not an array. Please try again.');
  }
  logger.info(`Gemini products: returned ${products.length} recommendations`);
  return products;
}


// ── Ingredient safety check ───────────────────────────────────
async function checkIngredientSafety(ingredientsList, userSkinType, fitzpatrick) {
  const prompt = `
You are a cosmetic chemist specialising in melanin-rich skin safety.
Analyse these ingredients and return ONLY a JSON object.

Ingredients: ${ingredientsList.join(', ')}
Skin type: ${userSkinType}
Fitzpatrick scale: ${fitzpatrick}

{
  "safeIngredients":    ["<ingredient>"],
  "warningIngredients": [{ "name": "<ingredient>", "reason": "<why cautious>" }],
  "avoidIngredients":   [{ "name": "<ingredient>", "reason": "<why avoid>" }],
  "overallSafetyScore": <0-100>,
  "summary": "<2 sentence summary>"
}
`.trim();

  const result = await runWithRotation(async (client) => {
    const model    = client.getGenerativeModel({ model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash' });
    const response = await model.generateContent(prompt);
    return response.response.text();
  });

  try {
    return repairJson(result);
  } catch (e) {
    logger.error('checkIngredientSafety: JSON parse failed', { preview: result.slice(0, 200) });
    throw new Error('Gemini returned invalid JSON for ingredient check. Please try again.');
  }
}

// ── Day normaliser ────────────────────────────────────────────
// Gemini may return full names ("Tuesday"), combos ("Tue/Thu"), etc.
// This maps everything to the 3-letter enum the Mongoose schema requires.
const DAY_MAP = {
  monday: 'Mon',    mon: 'Mon',
  tuesday: 'Tue',   tue: 'Tue',
  wednesday: 'Wed', wed: 'Wed',
  thursday: 'Thu',  thu: 'Thu',
  friday: 'Fri',    fri: 'Fri',
  saturday: 'Sat',  sat: 'Sat',
  sunday: 'Sun',    sun: 'Sun',
};

function normaliseDay(raw) {
  if (!raw) return null;
  // Handle combos like "Tuesday or Thursday" or "Tue/Thu" — take first day only
  const first = String(raw).split(/[\s/,&+]|( or )/i)[0].trim().toLowerCase();
  return DAY_MAP[first] || null;
}

function normaliseWeeklyExtras(extras = []) {
  const seen = new Set();
  const result = [];
  for (const entry of extras) {
    const day = normaliseDay(entry.day);
    if (!day || seen.has(day)) continue; // skip invalid or duplicate days
    seen.add(day);
    result.push({ day, tasks: [entry.task].filter(Boolean) });
  }
  return result;
}

// ── Routine generation (text-only, no image needed) ───────────
// ── Repair truncated JSON from Gemini (token limit cut-off) ──
function repairJson(raw) {
  // Strip markdown fences
  let s = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // If it already parses, great
  try { return JSON.parse(s); } catch (_) {}

  // Try to close unclosed structures by trimming to last valid boundary
  // Remove trailing comma + any partial token, then close open brackets/braces
  s = s.replace(/,\s*$/, '');          // trailing comma
  s = s.replace(/,\s*[\]}]*$/, '');    // comma before closing bracket

  // Count open braces/brackets and close them
  const opens = [];
  let inStr = false, escape = false;
  for (const ch of s) {
    if (escape)          { escape = false; continue; }
    if (ch === '\\')    { escape = true;  continue; }
    if (ch === '"')      { inStr = !inStr;  continue; }
    if (inStr)           continue;
    if (ch === '{' || ch === '[') opens.push(ch === '{' ? '}' : ']');
    if (ch === '}' || ch === ']') opens.pop();
  }
  // Close any unclosed string first
  if (inStr) s += '"';
  // Then close brackets in reverse order
  s += opens.reverse().join('');

  return JSON.parse(s);
}

// ── Build routine directly from scan products ─────────────────
//  Groups products by productStep so every step shows ALL products
//  recommended for that action (e.g. both serums in one Serum step).
//  This is the PRIMARY path — guarantees routine matches scan products.
function buildRoutineFromProducts(products) {
  if (!Array.isArray(products) || !products.length) {
    return { morning: [], night: [], weeklyExtras: [] };
  }

  // Canonical step order — determines display order in the routine
  const STEP_PRIORITY = [
    'cleanse','double cleanse','tone','toner','essence',
    'serum','treatment','eye cream','moisturise','moisturizer',
    'oil','spf','sunscreen','mask','exfoliant',
  ];
  const stepOrder = (name) => {
    const n = (name || '').toLowerCase().trim();
    const idx = STEP_PRIORITY.findIndex(s => n.includes(s) || s.includes(n));
    return idx === -1 ? 99 : idx;
  };

  // Group products into morning/night maps keyed by productStep
  const morningMap = new Map(); // stepName → { products[], minPriority }
  const nightMap   = new Map();

  for (const p of products) {
    const slot     = (p.routineSlot || 'both').toLowerCase();
    const stepName = (p.productStep || p.category || 'Skincare').trim();

    const addToMap = (map) => {
      if (!map.has(stepName)) map.set(stepName, { products: [], minPriority: 99 });
      const entry = map.get(stepName);
      entry.products.push(p);
      if ((p.priority || 5) < entry.minPriority) entry.minPriority = p.priority || 5;
    };

    if (slot === 'morning' || slot === 'both') addToMap(morningMap);
    if (slot === 'night'   || slot === 'both') addToMap(nightMap);
  }

  // Convert a map → sorted step array
  const mapToSteps = (map) => {
    const steps = Array.from(map.entries()).map(([stepName, { products: prods, minPriority }]) => {
      // Sort products within the step by priority (most essential first)
      const sorted = [...prods].sort((a, b) => (a.priority || 5) - (b.priority || 5));
      const lead   = sorted[0];
      return {
        step:            stepName,
        productType:     lead.category || '',
        keyIngredient:   (lead.keyIngredients || [])[0] || '',
        notes:           lead.amountToUse || lead.frequency || '',
        durationSeconds: 30,
        matchedProducts: sorted,   // ← ALL products for this step
        _sortKey:        stepOrder(stepName) * 100 + (minPriority || 5),
      };
    });

    // Sort steps by canonical routine order, then by priority
    steps.sort((a, b) => a._sortKey - b._sortKey);
    return steps.map((s, i) => {
      const { _sortKey, ...rest } = s;
      return { ...rest, order: i + 1 };
    });
  };

  const morning = mapToSteps(morningMap);
  const night   = mapToSteps(nightMap);

  const weeklyExtras = [
    { day: 'Tue', tasks: ['Weekly treatment mask — apply for 10 min then rinse'] },
    { day: 'Fri', tasks: ['Gentle exfoliation or brightening sheet mask'] },
  ];

  return { morning, night, weeklyExtras };
}

async function generateRoutine(skinData, scanProducts = []) {
  // ── Fast path: build from scan products (guaranteed match) ──
  if (Array.isArray(scanProducts) && scanProducts.length > 0) {
    logger.info(`generateRoutine: building from ${scanProducts.length} scan products (no Gemini call)`);
    return buildRoutineFromProducts(scanProducts);
  }

  // ── Fallback: generate via Gemini when no products available ─
  logger.info('generateRoutine: no scan products — falling back to Gemini generation');
  return generateRoutineViaGemini(skinData);
}

async function generateRoutineViaGemini(skinData) {
  const prompt = `
Generate an AM/PM skincare routine for melanin-rich skin.
Return ONLY a valid JSON object. No markdown. No code fences. No explanation.

Skin: ${skinData.skinType || 'normal'}
Conditions: ${(skinData.conditions || []).join(', ') || 'none'}
Concerns: ${(skinData.concerns || []).join(', ') || 'none'}
Fitzpatrick: ${skinData.fitzpatrick || 'IV-V'}

EXACT JSON format — copy this structure, fill in the values:
{"morning":[{"order":1,"step":"Cleanse","productType":"gentle cleanser","keyIngredient":"glycerin","notes":"massage 60s","durationSeconds":60},{"order":2,"step":"Tone","productType":"hydrating toner","keyIngredient":"niacinamide","notes":"pat in","durationSeconds":30},{"order":3,"step":"Serum","productType":"brightening serum","keyIngredient":"vitamin C","notes":"2-3 drops","durationSeconds":30},{"order":4,"step":"Moisturise","productType":"lightweight moisturiser","keyIngredient":"hyaluronic acid","notes":"seal in","durationSeconds":30},{"order":5,"step":"SPF","productType":"sunscreen SPF50","keyIngredient":"zinc oxide","notes":"every morning","durationSeconds":30}],"night":[{"order":1,"step":"Cleanse","productType":"oil cleanser","keyIngredient":"jojoba oil","notes":"remove SPF","durationSeconds":60},{"order":2,"step":"Exfoliate","productType":"AHA toner 2x/week","keyIngredient":"glycolic acid","notes":"skip other nights","durationSeconds":30},{"order":3,"step":"Treatment","productType":"dark spot serum","keyIngredient":"alpha arbutin","notes":"target PIH","durationSeconds":30},{"order":4,"step":"Moisturise","productType":"night cream","keyIngredient":"ceramides","notes":"barrier repair","durationSeconds":30},{"order":5,"step":"Oil","productType":"facial oil","keyIngredient":"rosehip","notes":"seal moisture","durationSeconds":20}],"weeklyExtras":[{"day":"Tue","task":"clay mask 10 min"},{"day":"Fri","task":"exfoliating mask"}]}

RULES:
- Keep notes under 8 words
- "day" must be one of: Mon Tue Wed Thu Fri Sat Sun only
- weeklyExtras: exactly 2 entries
- Personalise steps for the skin type and conditions above
`.trim();

  const result = await runWithRotation(async (client) => {
    const model = client.getGenerativeModel({
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature:     0.2,
        maxOutputTokens: 4096,   // was 2048 — full routine needs ~1800 tokens
      },
    });
    const response = await model.generateContent(prompt);
    return response.response.text();
  });

  let parsed;
  try {
    parsed = repairJson(result);
  } catch (err) {
    logger.error('generateRoutine: JSON parse failed even after repair', { err: err.message, preview: result.slice(0, 200) });
    throw new Error('Gemini returned malformed JSON for routine generation. Please try again.');
  }

  // Safety net: normalise weeklyExtras regardless of what Gemini returned
  parsed.weeklyExtras = normaliseWeeklyExtras(Array.isArray(parsed.weeklyExtras) ? parsed.weeklyExtras : []);

  // Ensure morning/night arrays exist
  parsed.morning = Array.isArray(parsed.morning) ? parsed.morning : [];
  parsed.night   = Array.isArray(parsed.night)   ? parsed.night   : [];

  return parsed;
}

// ── Fit a user-owned product into their routine ───────────────
//  Called by routinecontroller.fitUserProduct
//  Returns: { timeOfDay, stepName, usageNote, keyIngredients }
async function fitUserProduct({ productName, skinType, concerns = [] }) {
  const prompt = `
You are a skincare expert helping a user with ${skinType || 'normal'} skin fit a product they already own into their daily routine.
${concerns.length ? `Their main concerns are: ${concerns.join(', ')}.` : ''}

The user's product: "${productName}"

Look at the product name and determine:
1. What type of product is it? (cleanser, toner, serum, moisturiser, sunscreen, treatment, oil, etc.)
2. Which part of the routine does it belong to? (morning, night, or both)
3. Which step name does it map to? (e.g. Cleanse, Tone, Serum, Moisturise, SPF, Treatment, Oil)
4. How should they use it? (a short, practical 1–2 sentence tip)
5. What are the likely key ingredients? (list up to 3 guesses based on the product name/type)

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "timeOfDay":     "morning|night|both",
  "stepName":      "<the step this fits into e.g. Cleanse, Serum, Moisturise>",
  "usageNote":     "<short practical tip — max 2 sentences>",
  "keyIngredients": ["<ingredient>"]
}
`.trim();

  const result = await runWithRotation(async (client) => {
    const model = client.getGenerativeModel({
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
      generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
    });
    const response = await model.generateContent(prompt);
    return response.response.text();
  });

  try {
    return repairJson(result);
  } catch (e) {
    logger.error('fitUserProduct: JSON parse failed', { preview: result.slice(0, 200) });
    throw new Error('Could not determine where this product fits. Please try again.');
  }
}

module.exports = { getProductRecommendations, ensureMinimumProducts, checkIngredientSafety, generateRoutine, fitUserProduct };