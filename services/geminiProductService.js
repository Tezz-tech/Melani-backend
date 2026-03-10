/**
 * ─────────────────────────────────────────────────────────────
 *  GEMINI PRODUCT RECOMMENDATION SERVICE
 *  Takes the scan result and user profile and returns curated
 *  product recommendations specifically for Nigerian market.
 * ─────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');
const { runWithRotation } = require('../config/gemini');

const PRODUCT_PROMPT_TEMPLATE = (scanData, userProfile) => `
You are a skincare product recommendation AI specialising in melanin-rich skin in Nigeria.
You MUST return ONLY a valid JSON array of product recommendations.

SCAN RESULTS:
- Skin Type: ${scanData.skinType}
- Overall Score: ${scanData.overallScore}/100
- Conditions: ${(scanData.conditions || []).map(c => `${c.name} (${c.severity})`).join(', ')}
- PIH Risk: ${scanData.melaninInsights?.pihRisk || 'unknown'}
- Good Ingredients: ${(scanData.goodIngredients || []).join(', ')}
- Avoid: ${(scanData.avoidIngredients || []).join(', ')}

USER PROFILE:
- Concerns: ${(userProfile.primaryConcerns || []).join(', ')}
- Allergies: ${(userProfile.allergies || []).join(', ')}
- Budget: ${userProfile.budget || 'mid-range (₦1,500–₦8,000 per product)'}

Return a JSON array of exactly 6 products in this format:
[
  {
    "name":          "<product name>",
    "brand":         "<brand name>",
    "category":      "cleanser|toner|serum|moisturiser|spf|treatment",
    "priceNGN":      <price in naira as integer>,
    "description":   "<1 sentence why this suits this person's skin>",
    "keyIngredients":["<ingredient>"],
    "availability":  "<where to buy in Nigeria e.g. Jumia, Konga, Skincare stores>",
    "rating":        <3.5-5.0>,
    "routineSlot":   "morning|night|both",
    "priority":      <1-6 where 1 is most important>
  }
]

RULES:
- Products MUST be available or easily sourced in Nigeria
- Prioritise local/African brands where possible
- All products must be free of: ${(scanData.avoidIngredients || ['fragrance','alcohol denat.']).join(', ')}
- For PIH: include niacinamide or alpha arbutin serum as priority 1 or 2
- SPF 50 is MANDATORY — include one sunscreen
- Price range: ₦1,000–₦12,000 per product
- Do NOT invent fake brand names — use real or plausibly real brands common in Nigeria
`.trim();

async function getProductRecommendations(scanData, userProfile = {}) {
  const prompt = PRODUCT_PROMPT_TEMPLATE(scanData, userProfile);

  logger.info('Gemini products: generating recommendations');

  const result = await runWithRotation(async (client) => {
    const model = client.getGenerativeModel({
      model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature:     0.4,
        topP:            0.9,
        maxOutputTokens: 2048,
      },
    });

    const response = await model.generateContent(prompt);
    return response.response.text();
  });

  // Strip markdown fences
  let clean = result.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const products = JSON.parse(clean);
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

  let clean = result.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim();
  return JSON.parse(clean);
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

async function generateRoutine(skinData) {
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

module.exports = { getProductRecommendations, checkIngredientSafety, generateRoutine };