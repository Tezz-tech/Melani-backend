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

const PRODUCT_PROMPT_TEMPLATE = (scanData, userProfile, userSeed = '', previousContext = '') => `
You are a skincare product recommendation AI specialising in melanin-rich skin in Nigeria.
You MUST return ONLY a valid JSON array of product recommendations — no markdown, no text outside the array.
User profile seed: ${userSeed || 'default'} — always return the SAME products for the same seed and skin type.

CURRENT SCAN RESULTS:
- Skin Type: ${scanData.skinType}
- Overall Score: ${scanData.overallScore}/100
- Fitzpatrick: ${scanData.fitzpatrickEst || 'IV-V'}
- Conditions: ${(scanData.conditions || []).map(c => `${c.name} (${c.severity})`).join(', ') || 'none'}
- PIH Risk: ${scanData.melaninInsights?.pihRisk || 'unknown'}
- Melanin Notes: ${scanData.melaninInsights?.melanocyteNotes || 'none'}
- Good Ingredients: ${(scanData.goodIngredients || []).join(', ') || 'none'}
- Avoid: ${(scanData.avoidIngredients || []).join(', ') || 'none'}
- Routine Steps from Scan: ${(scanData.routine || []).map(r => r.step).join(', ') || 'Cleanse, Tone, Serum, Moisturise, SPF'}

USER PROFILE:
- Concerns: ${(userProfile.primaryConcerns || []).join(', ') || 'none'}
- Allergies: ${(userProfile.allergies || []).join(', ') || 'none'}
- Budget: ${userProfile.budget || 'mid-range (₦1,500–₦10,000 per product)'}
${previousContext ? `\nPREVIOUS SCAN CONTEXT (use this for continuity and progression):\n${previousContext}\n` : ''}
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
    "description":   "<2 sentences: why this product suits THIS person's specific skin analysis — reference their exact conditions>",
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
${previousContext ? `
CONTINUITY RULES (previous scan detected — apply these):
- Keep the SPF and cleanser consistent — these are the cornerstones of any routine
- If score IMPROVED: build on what worked, introduce one stronger treatment (e.g. upgrade from niacinamide 5% to 10%, or add a retinol)
- If score DECLINED or stayed the same: simplify — swap actives for gentler barrier-repair alternatives
- Introduce at least 2 new products that target the conditions visible in the CURRENT scan
- Never repeat the exact same treatment serum if conditions have changed significantly
- Frame the progression in the product descriptions ("Building on your previous routine, this upgrade…")
` : ''}`.trim();

// ── Complete 10-product fallback set ─────────────────────────
//  Used when Gemini fails. All 10 categories are covered so the
//  user always sees a full routine even on API failure.
//  Products are real, available in Nigeria, tuned per skin type.
function buildFallbackProducts(skinType = 'combination', conditions = []) {
  const st     = skinType.toLowerCase();
  const isOily = st.includes('oily');
  const isDry  = st.includes('dry');
  const hasPIH = conditions.some(c =>
    ((typeof c === 'string' ? c : c.name) || '').toLowerCase().includes('hyperpig') ||
    ((typeof c === 'string' ? c : c.name) || '').toLowerCase().includes('pih') ||
    ((typeof c === 'string' ? c : c.name) || '').toLowerCase().includes('dark spot'),
  );

  // 1. Cleanser
  const cleanser = isOily ? {
    name: 'CeraVe Foaming Facial Cleanser', brand: 'CeraVe', brandOrigin: 'US', category: 'cleanser',
    productStep: 'Cleanse', routineSlot: 'both', priority: 1,
    description: 'Foaming cleanser that removes excess oil without stripping the barrier. Ceramides restore moisture after cleansing — essential for oily melanin-rich skin prone to PIH.',
    keyIngredients: ['Niacinamide', 'Ceramides', 'Hyaluronic Acid'],
    howToUse: 'Wet face with lukewarm water. Massage gently for 60 seconds. Rinse and pat dry.',
    frequency: 'Twice daily', amountToUse: 'Coin-sized amount',
    availability: 'Jumia, Konga, beauty stores in Lagos and Abuja',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=CeraVe+Foaming+Facial+Cleanser' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=CeraVe+Foaming+Facial+Cleanser' },
    ], rating: 4.7,
  } : {
    name: 'CeraVe Hydrating Facial Cleanser', brand: 'CeraVe', brandOrigin: 'US', category: 'cleanser',
    productStep: 'Cleanse', routineSlot: 'both', priority: 1,
    description: 'Gentle non-foaming cleanser that hydrates while cleansing — ideal for dry and combination melanin-rich skin. Ceramides reinforce the barrier with every wash.',
    keyIngredients: ['Ceramides', 'Hyaluronic Acid', 'Glycerin'],
    howToUse: 'Apply to damp skin, massage for 60 seconds, rinse with lukewarm water and pat dry.',
    frequency: 'Twice daily', amountToUse: 'Coin-sized amount',
    availability: 'Jumia, Konga, pharmacies across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=CeraVe+Hydrating+Cleanser' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=CeraVe+Hydrating+Cleanser' },
    ], rating: 4.8,
  };

  // 2. Toner / Essence
  const toner = {
    name: isOily ? 'COSRX AHA/BHA Clarifying Treatment Toner' : 'Klairs Supple Preparation Unscented Toner',
    brand: isOily ? 'COSRX' : 'Klairs', brandOrigin: 'South African', category: 'toner',
    productStep: 'Tone', routineSlot: 'both', priority: 2,
    description: isOily
      ? 'Exfoliating toner with AHA/BHA that gently unclogs pores and brightens post-acne marks on melanin-rich skin. Keeps excess sebum in check without drying.'
      : 'Deeply hydrating alcohol-free toner that preps melanin-rich skin for serums. Betaine and hyaluronic acid restore moisture without irritation.',
    keyIngredients: isOily ? ['AHA', 'BHA', 'Niacinamide'] : ['Hyaluronic Acid', 'Betaine', 'Glycerin'],
    howToUse: 'Apply to a cotton pad or press 2–3 drops directly onto clean skin. Pat gently into face and neck.',
    frequency: isOily ? 'Every night, AM on non-exfoliant days' : 'Twice daily',
    amountToUse: '2–3 drops or one cotton pad',
    availability: 'Jumia, Konga, skincare stores across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: isOily ? 'https://www.jumia.com.ng/catalog/?q=COSRX+AHA+BHA+Toner' : 'https://www.jumia.com.ng/catalog/?q=Klairs+Supple+Toner' },
      { store: 'Konga', url: isOily ? 'https://www.konga.com/search?search=COSRX+AHA+BHA+Toner' : 'https://www.konga.com/search?search=Klairs+Supple+Toner' },
    ], rating: 4.6,
  };

  // 3. Vitamin C / Brightening serum (morning)
  const vitaminC = {
    name: hasPIH ? 'The Inkey List Vitamin C Serum' : 'L\'Oréal Revitalift 12% Pure Vitamin C Serum',
    brand: hasPIH ? 'The Inkey List' : 'L\'Oréal', brandOrigin: 'UK', category: 'serum',
    productStep: 'Serum', routineSlot: 'morning', priority: 3,
    description: 'Vitamin C serum that brightens dark spots and PIH — the top concern for melanin-rich skin. Antioxidant protection against UV-triggered hyperpigmentation every morning.',
    keyIngredients: ['Vitamin C (Ascorbic Acid)', 'Vitamin E', 'Ferulic Acid'],
    howToUse: 'Apply 2–3 drops to clean dry skin after toner. Press in gently with fingertips. Follow immediately with moisturiser. Always use SPF after.',
    frequency: 'Every morning', amountToUse: '2–3 drops',
    availability: 'Jumia, Konga, Shoprite, pharmacies across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Vitamin+C+Serum+face' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Vitamin+C+Face+Serum' },
    ], rating: 4.5,
  };

  // 4. Treatment serum (niacinamide / alpha arbutin)
  const treatment = {
    name: 'The Ordinary Niacinamide 10% + Zinc 1%', brand: 'The Ordinary', brandOrigin: 'UK', category: 'serum',
    productStep: 'Treatment', routineSlot: 'both', priority: 4,
    description: hasPIH
      ? 'High-dose niacinamide that fades hyperpigmentation and regulates melanin transfer — the most evidence-backed ingredient for PIH on dark skin. Zinc keeps oil in check.'
      : 'Niacinamide strengthens the barrier, minimises pores, and evens skin tone — essential for all melanin-rich skin types.',
    keyIngredients: ['Niacinamide 10%', 'Zinc PCA', 'Glycerin'],
    howToUse: 'Apply 2–3 drops after toner. Press into skin. Can layer under moisturiser. Avoid mixing with direct Vitamin C — apply at separate times.',
    frequency: 'Twice daily (AM + PM)', amountToUse: '2–3 drops',
    availability: 'Jumia, Konga, and skincare specialty stores nationwide',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=The+Ordinary+Niacinamide+10' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=The+Ordinary+Niacinamide' },
    ], rating: 4.8,
  };

  // 5. Day moisturiser
  const moisturiser = isOily ? {
    name: 'Neutrogena Hydro Boost Water Gel', brand: 'Neutrogena', brandOrigin: 'US', category: 'moisturiser',
    productStep: 'Moisturise', routineSlot: 'both', priority: 5,
    description: 'Oil-free water gel that delivers 24-hour hydration without clogging pores — perfect for oily melanin-rich skin. Hyaluronic acid locks in moisture with a matte finish.',
    keyIngredients: ['Hyaluronic Acid', 'Glycerin', 'Dimethicone'],
    howToUse: 'Apply a pea-sized amount to clean face morning and night. Press in gently.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized amount',
    availability: 'Jumia, Konga, Shoprite, supermarkets across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Neutrogena+Hydro+Boost+Water+Gel' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Neutrogena+Hydro+Boost+Water+Gel' },
    ], rating: 4.6,
  } : isDry ? {
    name: 'CeraVe Moisturising Cream', brand: 'CeraVe', brandOrigin: 'US', category: 'moisturiser',
    productStep: 'Moisturise', routineSlot: 'both', priority: 5,
    description: 'Rich ceramide cream that restores the skin barrier for dry melanin-rich skin. 24-hour hydration with a non-greasy finish that never triggers PIH.',
    keyIngredients: ['Ceramides', 'Hyaluronic Acid', 'Niacinamide'],
    howToUse: 'Apply a small amount to face and neck morning and night after serums.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized amount',
    availability: 'Jumia, Konga, pharmacies across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=CeraVe+Moisturising+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=CeraVe+Moisturising+Cream' },
    ], rating: 4.8,
  } : {
    name: 'Olay Regenerist Micro-Sculpting Cream', brand: 'Olay', brandOrigin: 'US', category: 'moisturiser',
    productStep: 'Moisturise', routineSlot: 'both', priority: 5,
    description: 'Lightweight daily moisturiser with niacinamide that visibly improves skin tone uniformity — critical for melanin-rich skin prone to dark spots.',
    keyIngredients: ['Niacinamide', 'Hyaluronic Acid', 'Amino-Peptides'],
    howToUse: 'Apply a small amount to face and neck morning and night after cleansing.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized amount',
    availability: 'Jumia, Konga, Shoprite, supermarkets across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Olay+Regenerist+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Olay+Regenerist+Cream' },
    ], rating: 4.5,
  };

  // 6. SPF (non-negotiable for all melanin skin)
  const spf = {
    name: 'Neutrogena Ultra Sheer Dry-Touch SPF 50+', brand: 'Neutrogena', brandOrigin: 'US', category: 'spf',
    productStep: 'SPF', routineSlot: 'morning', priority: 6,
    description: 'Broad-spectrum SPF 50+ that dries matte — the single most important product for melanin-rich skin to prevent UV-triggered hyperpigmentation and PIH.',
    keyIngredients: ['Avobenzone', 'Homosalate', 'Octisalate'],
    howToUse: 'Apply as the LAST step in your morning routine. Use two finger-lengths for face and neck. Reapply every 2 hours outdoors.',
    frequency: 'Every morning (non-negotiable)', amountToUse: 'Two finger-lengths',
    availability: 'Jumia, Konga, pharmacies, Shoprite nationwide',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Neutrogena+Ultra+Sheer+SPF+50' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Neutrogena+Ultra+Sheer+SPF+50' },
    ], rating: 4.8,
  };

  // 7. Night cream
  const nightCream = {
    name: isDry ? 'SheaMoisture 100% Raw Shea Butter Night Cream' : 'Olay Regenerist Night Recovery Cream',
    brand: isDry ? 'SheaMoisture' : 'Olay', brandOrigin: isDry ? 'Nigerian' : 'US', category: 'moisturiser',
    productStep: 'Night Cream', routineSlot: 'night', priority: 7,
    description: isDry
      ? 'Rich shea butter night cream that deeply repairs the barrier and reduces transepidermal water loss overnight — ideal for dry melanin-rich skin prone to ashiness.'
      : 'Niacinamide-rich night cream that works overnight to fade dark spots and rebuild the skin barrier — visible glow improvement in 2–4 weeks on melanin skin.',
    keyIngredients: isDry ? ['Shea Butter', 'Vitamin E', 'Argan Oil'] : ['Niacinamide', 'Peptides', 'Glycerin'],
    howToUse: 'Apply as the final step of your PM routine to clean skin. Massage in upward motions. Leave overnight.',
    frequency: 'Every night', amountToUse: 'Pea-sized to dime-sized amount',
    availability: isDry ? 'Jumia, beauty supply stores across Nigeria' : 'Jumia, Konga, Shoprite nationwide',
    affiliateLinks: isDry ? [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=SheaMoisture+Night+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=SheaMoisture+Night+Cream' },
    ] : [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Olay+Regenerist+Night+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Olay+Night+Recovery+Cream' },
    ], rating: 4.5,
  };

  // 8. Face oil (PM sealing step)
  const faceOil = {
    name: 'Argan Oil Pure 100% Cold-Pressed', brand: 'Josie Maran', brandOrigin: 'US', category: 'face-oil',
    productStep: 'Oil', routineSlot: 'night', priority: 8,
    description: 'Pure cold-pressed argan oil that seals in all PM actives and adds a radiant glow. Rich in vitamin E and oleic acid — excellent for sealing moisture on melanin skin overnight.',
    keyIngredients: ['Argan Oil', 'Vitamin E', 'Oleic Acid'],
    howToUse: 'Apply 2–3 drops as the LAST step of your PM routine. Press lightly over night cream to seal in moisture.',
    frequency: 'Every night', amountToUse: '2–3 drops',
    availability: 'Jumia, Konga, natural beauty stores across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Argan+Oil+face+pure' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Pure+Argan+Oil+Face' },
    ], rating: 4.6,
  };

  // 9. Eye cream
  const eyeCream = {
    name: 'Olay Eyes Brightening Eye Cream', brand: 'Olay', brandOrigin: 'US', category: 'eye-cream',
    productStep: 'Eye Cream', routineSlot: 'both', priority: 9,
    description: 'Brightening eye cream with niacinamide that reduces periorbital hyperpigmentation — the most common under-eye concern for melanin-rich skin types.',
    keyIngredients: ['Niacinamide', 'Peptides', 'Hyaluronic Acid'],
    howToUse: 'Use ring finger to pat a pea-sized amount around the orbital bone (bony edge of eye socket). Apply AM + PM after serum and before moisturiser.',
    frequency: 'Twice daily', amountToUse: 'Pea-sized (two dots per eye)',
    availability: 'Jumia, Konga, Shoprite, pharmacies across Nigeria',
    affiliateLinks: [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Olay+Eyes+Brightening+Eye+Cream' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Olay+Brightening+Eye+Cream' },
    ], rating: 4.4,
  };

  // 10. Weekly treatment mask
  const mask = {
    name: isOily ? 'Aztec Secret Indian Healing Clay Mask' : 'Neutrogena Hydro Boost Hydrating Face Mask',
    brand: isOily ? 'Aztec Secret' : 'Neutrogena', brandOrigin: 'US', category: 'mask',
    productStep: 'Mask', routineSlot: 'both', priority: 10,
    description: isOily
      ? 'Deep-cleansing clay mask that draws out impurities and excess sebum from congested pores — effective weekly reset for oily melanin-rich skin without causing PIH.'
      : 'Intensive hydrating mask with hyaluronic acid that replenishes moisture and plumps dull or dehydrated melanin-rich skin in 15 minutes.',
    keyIngredients: isOily ? ['Bentonite Clay', 'Apple Cider Vinegar', 'Silica'] : ['Hyaluronic Acid', 'Glycerin', 'Water'],
    howToUse: isOily
      ? 'Mix with equal parts apple cider vinegar. Apply thin layer, leave 10–15 min, rinse well. Follow with moisturiser immediately.'
      : 'Apply a generous layer to clean dry skin. Leave 15 min. Rinse and follow with moisturiser.',
    frequency: '1–2 times per week', amountToUse: 'Thin even layer across face',
    availability: 'Jumia, Konga, beauty stores across Nigeria',
    affiliateLinks: isOily ? [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Aztec+Indian+Healing+Clay+Mask' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Aztec+Indian+Healing+Clay' },
    ] : [
      { store: 'Jumia', url: 'https://www.jumia.com.ng/catalog/?q=Neutrogena+Hydro+Boost+Mask' },
      { store: 'Konga', url: 'https://www.konga.com/search?search=Neutrogena+Hydro+Boost+Mask' },
    ], rating: 4.5,
  };

  return [cleanser, toner, vitaminC, treatment, moisturiser, spf, nightCream, faceOil, eyeCream, mask];
}

// ── Ensure products array always has ≥ 10 entries ─────────────
//  Called after getProductRecommendations(). If Gemini returns
//  fewer than 10 products (or fails entirely), fallback products
//  are appended for the missing categories so the user always
//  sees a complete routine — never just 3 skeleton steps.
function ensureMinimumProducts(products, scanData = {}, userProfile = {}) {
  const MIN      = 10;
  if (Array.isArray(products) && products.length >= MIN) return products;

  const base     = Array.isArray(products) ? [...products] : [];
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

  logger.info(`ensureMinimumProducts: final count = ${base.length} (was ${products?.length ?? 0})`);
  return base;
}

async function getProductRecommendations(scanData, userProfile = {}, previousScan = null) {
  const userSeed = getUserSkinHash(userProfile.userId || '', scanData.skinType || '');

  // Build continuity context from the previous scan if available
  let previousContext = '';
  if (previousScan && Array.isArray(previousScan.products) && previousScan.products.length) {
    const prevProducts = previousScan.products
      .slice(0, 6)
      .map(p => `${p.name} by ${p.brand} (${p.productStep || p.category})`)
      .join('; ');
    const scorePrev    = previousScan.overallScore ?? null;
    const scoreCurrent = scanData.overallScore ?? null;
    const scoreLine = (scorePrev !== null && scoreCurrent !== null)
      ? `Skin score changed: ${scorePrev}/100 → ${scoreCurrent}/100 (${scoreCurrent >= scorePrev ? '↑ improved' : '↓ declined'} by ${Math.abs(scoreCurrent - scorePrev)} points)`
      : '';
    const prevConditions = (previousScan.conditions || []).map(c => c.name).join(', ') || 'none';
    previousContext = [
      scoreLine,
      `Previous skin type: ${previousScan.skinType || 'unknown'}`,
      `Previous conditions: ${prevConditions}`,
      `Previously recommended: ${prevProducts}`,
    ].filter(Boolean).join('\n');
    logger.info('Gemini products: including previous scan context (score: %s→%s)', scorePrev, scoreCurrent);
  }

  const prompt = PRODUCT_PROMPT_TEMPLATE(scanData, userProfile, userSeed, previousContext);

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