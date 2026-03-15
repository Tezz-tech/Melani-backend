// src/services/geminiScanService.js
//
//  1. Logs the FULL Gemini error (including raw response text) before
//     re-throwing, so you can see exactly what went wrong.
//
//  2. Handles Gemini SAFETY blocks explicitly — these return a response
//     object with no text() but finishReason: 'SAFETY'. Without this
//     check the SDK throws a confusing error that the old isQuotaError
//     misidentified as a quota issue.
//
//  3. Handles prompt feedback blocks (promptFeedback.blockReason).
//
//  4. Better JSON parse error recovery — tries to extract JSON from
//     anywhere in the response even if Gemini added preamble text.
//
//  ✅ FIX 2: SCAN_PROMPT previously used "spfNote" as the melaninInsights
//     key but the Scan model schema defines the field as "spfGuidance".
//     Gemini was returning spfNote, the controller was saving the whole
//     melaninInsights object as-is, and spfGuidance was always undefined
//     in every saved scan — silent data loss on every single request.
//     Fixed by renaming the key in the prompt to match the schema.
//
const logger = require('../utils/logger');
const { runWithRotation } = require('../config/gemini');

// ── Melanin-first system prompt ───────────────────────────────
const SCAN_PROMPT = `
You are an expert dermatology AI specialising exclusively in melanin-rich skin (Fitzpatrick types III–VI).
Your analysis is cosmetic and observational only — NOT a medical diagnosis.

You MUST return a single valid JSON object with exactly this structure.
Do NOT include markdown fences, explanations, or any text outside the JSON:

{
  "skinType":        "oily|dry|combination|normal",
  "confidence":      <0-100 integer>,
  "overallScore":    <0-100 integer>,
  "fitzpatrickEst":  "III|IV|V|VI",
  "scoreBreakdown": {
    "hydration": <0-100>,
    "clarity":   <0-100>,
    "evenness":  <0-100>,
    "texture":   <0-100>,
    "glow":      <0-100>
  },
  "conditions": [
    {
      "name":          "<condition name>",
      "severity":      "mild|moderate|severe",
      "confidence":    <0-100>,
      "melaninNote":   "<why this matters specifically for melanin skin>",
      "affectedAreas": ["<area>"]
    }
  ],
  "melaninInsights": {
    "pihRisk":          "low|moderate|high",
    "spfGuidance":      "<specific SPF recommendation>",
    "sensitivityFlags": ["<ingredient or trigger to watch>"],
    "melanocyteNotes":  "<note on melanin activity observed>"
  },
  "goodIngredients":  ["<ingredient>"],
  "avoidIngredients": ["<ingredient>"],
  "routine": [
    {
      "order":         <1-10>,
      "timeOfDay":     "morning|night|both",
      "step":          "<step name e.g. Cleanse>",
      "productType":   "<product description>",
      "keyIngredient": "<active ingredient>",
      "notes":         "<usage note>"
    }
  ],
  "progressMilestones": [
    { "week": 2,  "label": "<milestone>", "description": "<what to expect>" },
    { "week": 6,  "label": "<milestone>", "description": "<what to expect>" },
    { "week": 12, "label": "<milestone>", "description": "<what to expect>" },
    { "week": 24, "label": "<milestone>", "description": "<what to expect>" }
  ],
  "disclaimer": "This is a cosmetic, observational skin analysis only. Not a medical diagnosis. Consult a dermatologist for clinical concerns."
}

MELANIN-SPECIFIC RULES — strictly follow these:
- PIH (post-inflammatory hyperpigmentation) is EXTREMELY common — always assess it
- Dark spots from acne should always be noted, even if mild
- Niacinamide (5–10%), alpha arbutin (2%), azelaic acid are first-line for PIH
- NEVER recommend retinoids >0.3% as a first recommendation
- SPF 50 is mandatory for all melanin skin types regardless of weather
- Flag hyperpigmentation risk whenever suggesting chemical exfoliants
- Fragrance and alcohol denat. are high-risk irritants — list in avoidIngredients
- Product recommendations should use ingredients available in Nigeria
- Be realistic — avoid over-diagnosis
`.trim();

// ── Build Gemini inlineData part ──────────────────────────────
function buildInlinePart(imageBase64, mimeType = 'image/jpeg') {
  const clean = imageBase64.replace(/^data:image\/[a-z]+;base64,/i, '').trim();
  if (!clean || clean.length < 200) {
    throw new Error('imageBase64 is empty or too short to be a valid image.');
  }
  return { inlineData: { data: clean, mimeType } };
}

// ── Robust JSON extractor ─────────────────────────────────────
//  Tries 3 strategies in order:
//  1. Strip markdown fences and parse directly
//  2. Find the first { and last } and parse the substring
//  3. Throw with the first 300 chars of raw text for debugging
function extractJSON(text) {
  // Strategy 1: strip fences
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(s); } catch (_) {}

  // Strategy 2: find JSON boundaries
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }

  // Strategy 3: give up with context
  throw new Error(
    `Could not parse Gemini response as JSON. First 300 chars: ${text.substring(0, 300)}`
  );
}

// ── Main exported function ────────────────────────────────────
async function analyseSkinImageBase64(imageBase64, mimeType = 'image/jpeg') {
  const t0        = Date.now();
  const imagePart = buildInlinePart(imageBase64, mimeType);

  logger.info(`Gemini scan: starting (mimeType=${mimeType}, base64Len=${imageBase64.length})`);

  const rawText = await runWithRotation(async (client) => {
    const model = client.getGenerativeModel({
      model: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
      generationConfig: {
        temperature:     0.2,
        topP:            0.8,
        maxOutputTokens: 4096,
      },
    });

    const prompt = `${SCAN_PROMPT}\n\nAnalyse the skin visible in this image and return only the JSON object described above.`;
    const resp   = await model.generateContent([prompt, imagePart]);
    const result = resp.response;

    // ── Check for SAFETY block ─────────────────────────────
    //  Gemini blocks some images for safety reasons.
    //  Without this check, result.text() throws an unhelpful error
    //  that the old isQuotaError() was falsely matching.
    const finishReason = result.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') {
      const ratings = result.candidates?.[0]?.safetyRatings || [];
      logger.warn(`Gemini SAFETY block. Ratings: ${JSON.stringify(ratings)}`);
      throw new Error(
        'Gemini refused to analyse this image due to safety filters. ' +
        'Please ensure the image shows only your face clearly in good lighting.'
      );
    }

    // ── Check for prompt feedback block ───────────────────
    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      logger.warn(`Gemini prompt blocked: ${blockReason}`);
      throw new Error(
        `Gemini blocked the request (${blockReason}). Please try a different image.`
      );
    }

    // ── Check response is non-empty ────────────────────────
    if (!result.candidates?.length) {
      throw new Error('Gemini returned no candidates. The image may be unclear or unsupported.');
    }

    return result.text();
  });

  const processingTimeMs = Date.now() - t0;
  logger.info(`Gemini scan: completed in ${processingTimeMs}ms`);

  // ── Parse the JSON response ────────────────────────────────
  let parsed;
  try {
    parsed = extractJSON(rawText);
  } catch (e) {
    logger.error(`Gemini JSON parse failed: ${e.message}`);
    throw new Error(e.message);
  }

  // ── Validate required fields ───────────────────────────────
  if (!parsed.skinType || parsed.overallScore === undefined) {
    logger.error(`Gemini incomplete result. Raw: ${rawText.substring(0, 400)}`);
    throw new Error('Gemini analysis was incomplete. Please try again.');
  }

  return {
    ...parsed,
    processingTimeMs,
    rawGeminiOutput: rawText,
  };
}

module.exports = { analyseSkinImageBase64 };