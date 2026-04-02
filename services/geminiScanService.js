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
//
//  CRITICAL: Every response MUST be based strictly on what is
//  ACTUALLY VISIBLE in this specific image. Do NOT copy a template.
//  Scores, conditions, and notes must differ meaningfully between
//  different photos. A clear healthy face should score differently
//  from a face with visible spots or uneven tone.
//
const SCAN_PROMPT = `
You are an expert dermatology AI specialising exclusively in melanin-rich skin (Fitzpatrick types III–VI).
Your analysis is cosmetic and observational only — NOT a medical diagnosis.

BEFORE filling any field, look carefully at the image and note:
- The visible skin tone: is it even or patchy? Are there darker zones (forehead, cheeks, chin, nose)?
- Texture: are pores visibly enlarged? Is the surface smooth or bumpy?
- Spots: are there active breakouts, dark marks, or post-spot discolouration?
- Shine zones: does the T-zone look oily? Are cheeks dull or radiant?
- Overall appearance: does the skin look well-hydrated and healthy, or tired and uneven?

Use ONLY what you can see. Do NOT assume conditions that are not visible. Scores MUST reflect the actual image.

You MUST return a single valid JSON object with exactly this structure.
Do NOT include markdown fences, explanations, or any text outside the JSON:

{
  "skinType":        "oily|dry|combination|normal",
  "confidence":      <0-100 integer — how sure you are based on visible evidence>,
  "overallScore":    <0-100 integer — honest score of visible skin health in THIS image>,
  "fitzpatrickEst":  "III|IV|V|VI",
  "scoreBreakdown": {
    "hydration": <0-100 — estimate from plumpness, dullness or tightness visible>,
    "clarity":   <0-100 — are there spots, marks or unevenness visible?>,
    "evenness":  <0-100 — is the tone uniform or patchy?>,
    "texture":   <0-100 — is the surface smooth or rough/bumpy?>,
    "glow":      <0-100 — does the skin look radiant or dull?>
  },
  "conditions": [
    {
      "name":          "<ONLY include conditions that are visibly present in the image>",
      "severity":      "mild|moderate|severe",
      "confidence":    <0-100>,
      "melaninNote":   "<a specific, plainly worded note about why this matters for dark skin>",
      "affectedAreas": ["<the specific area where this is visible e.g. forehead, cheeks, chin>"]
    }
  ],
  "melaninInsights": {
    "pihRisk":          "low|moderate|high",
    "spfGuidance":      "<a specific, practical SPF tip for this person's skin — not generic>",
    "sensitivityFlags": ["<ingredient or trigger to watch for this specific skin>"],
    "melanocyteNotes":  "<a plain-English observation about melanin activity visible in the image>"
  },
  "goodIngredients":  ["<ingredient suited to what was observed in THIS image>"],
  "avoidIngredients": ["<ingredient this person should avoid based on their visible skin state>"],
  "routine": [
    {
      "order":         <1-10>,
      "timeOfDay":     "morning|night|both",
      "step":          "<step name e.g. Cleanse>",
      "productType":   "<specific product type suited to what was observed>",
      "keyIngredient": "<the active ingredient this person needs most>",
      "notes":         "<a short, practical tip — max 10 words>"
    }
  ],
  "progressMilestones": [
    { "week": 2,  "label": "<a realistic early milestone>", "description": "<what this specific person can expect to see>" },
    { "week": 6,  "label": "<a visible improvement>",       "description": "<what this specific person can expect to see>" },
    { "week": 12, "label": "<a meaningful change>",         "description": "<what this specific person can expect to see>" },
    { "week": 24, "label": "<long-term goal>",              "description": "<what this specific person can expect to see>" }
  ],
  "disclaimer": "This is a cosmetic, observational skin analysis only. Not a medical diagnosis. Consult a dermatologist for clinical concerns."
}

RULES — strictly follow all of these:
- Every score must reflect what is actually visible in the image. Do NOT use default values.
- If the skin looks healthy and clear, overallScore should be 75–90. If there are many spots or marks, it should be lower.
- Only include conditions that you can see evidence of. Do not list conditions not visible in the image.
- PIH (post-inflammatory hyperpigmentation): assess it every time — dark skin is at higher risk
- Dark spots or marks from old breakouts must be noted even if mild
- Do NOT recommend retinoids above 0.3% as a first recommendation
- SPF 50 is mandatory for all melanin skin types
- Flag hyperpigmentation risk when suggesting chemical exfoliants
- Fragrance and alcohol denat. are high-risk — always list in avoidIngredients for melanin skin
- Ingredients and products should suit the Nigerian market
- Be honest and realistic — no over-diagnosis, no under-reporting of visible concerns
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
        temperature:     0.35,    // Higher → more natural language variation per face
        topP:            0.85,
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