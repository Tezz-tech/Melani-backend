// src/services/geminiScanService.js
//
//  Skin-scan vision analysis, routed through the AI engine's automatic
//  model + API-key rotation (see ../config/gemini). Content-safety and
//  malformed-response cases are thrown as AppError so the rotation
//  engine treats them as final (no point retrying a different backup
//  for a blocked image or a genuinely incomplete result).
//
const logger   = require('../utils/logger');
const AppError = require('../utils/apperror');
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

═══════════════════════════════════════════════════════
STEP 1 — LOOK CAREFULLY AT THE IMAGE BEFORE FILLING ANY FIELD
═══════════════════════════════════════════════════════
Examine the image in this specific order and note each observation:

A. SKIN TONE & EVENNESS
   - Is the complexion uniform or are there zones of uneven pigmentation?
   - Look for post-inflammatory hyperpigmentation (PIH) — dark flat spots left behind by healed breakouts
   - Identify the Fitzpatrick scale (III = medium brown, IV = olive-brown, V = deep brown, VI = very deep brown/black)
   - Check for perioral hyperpigmentation (darkening around mouth), periorbital darkness (under-eye), and forehead/cheek patches

B. ACTIVE CONDITIONS & BREAKOUTS
   - Are there active raised bumps (papules, pustules, cysts) vs flat dark marks (PIH)?
   - Comedones: open (blackheads — visible dark dots, usually nose/chin) or closed (whiteheads — small flesh bumps)?
   - Is acne inflammatory (red raised) or non-inflammatory (comedonal/flat)?
   - Any visible fungal acne (uniform small bumps, usually forehead/chest) vs hormonal acne (jawline, chin clusters)?

C. TEXTURE & PORE ANALYSIS
   - Are pores visibly enlarged (usually T-zone for combination skin)?
   - Is the surface smooth, bumpy, or rough-textured?
   - Milia (small hard white cysts under eyes or on cheeks)?
   - Keratosis pilaris clues (rough bumpy texture)?

D. HYDRATION & BARRIER STATE
   - Does the skin look plump and bouncy (well-hydrated) or flat and dull (dehydrated)?
   - Are there fine lines from dehydration (these disappear with hydration — different from deep wrinkles)?
   - Any visible tightness or flaking (dry/compromised barrier)?
   - Any ashiness or greyish undertone (common in very dry or poorly hydrated melanin-rich skin)?

E. OIL BALANCE
   - T-zone (forehead, nose, chin): is it visibly shiny or oily?
   - Cheeks: dry, normal, or also oily?
   - If T-zone oily + cheeks dry/normal = combination; all oily = oily; all matte/tight = dry

F. MELANIN-SPECIFIC CONCERNS
   - Hyperpigmentation severity: mild (a few spots), moderate (multiple areas), severe (widespread uneven tone)
   - Post-acne marks (flat dark discolouration — PIH severity directly linked to Fitzpatrick scale)
   - Melasma risk (symmetrical patches on cheeks/forehead often from UV or hormones)
   - Ashy undertone or uneven glow distribution

═══════════════════════════════════════════════════════
STEP 2 — RETURN EXACTLY THIS JSON STRUCTURE
═══════════════════════════════════════════════════════
Do NOT include markdown fences, explanations, or any text outside the JSON:

{
  "skinType":        "oily|dry|combination|normal",
  "confidence":      <0-100 integer — how sure you are based on visible evidence>,
  "overallScore":    <0-100 integer — honest score of visible skin health in THIS image>,
  "fitzpatrickEst":  "III|IV|V|VI",
  "scoreBreakdown": {
    "hydration": <0-100 — plumpness and glow vs dullness and dehydration lines>,
    "clarity":   <0-100 — absence of spots, marks, PIH, and active breakouts>,
    "evenness":  <0-100 — uniformity of skin tone — dock points for PIH, patches, uneven zones>,
    "texture":   <0-100 — smoothness vs enlarged pores, bumps, rough surface>,
    "glow":      <0-100 — radiance and luminosity vs ashiness and flat dull appearance>
  },
  "conditions": [
    {
      "name":          "<condition name — use ONLY these: Acne (Inflammatory) | Acne (Comedonal) | Acne (Cystic) | Post-Inflammatory Hyperpigmentation (PIH) | Hyperpigmentation | Oiliness | Dehydration | Dry Skin | Enlarged Pores | Uneven Skin Tone | Dark Spots | Melasma | Periorbital Hyperpigmentation | Keratosis Pilaris | Milia | Sensitivity | Fungal Acne>",
      "severity":      "mild|moderate|severe",
      "confidence":    <0-100 — how certain you are this is visible>,
      "melaninNote":   "<specific plain-English note: why this condition is heightened or different for dark/melanin-rich skin — e.g. PIH risk, ashy appearance, difficulty detecting redness>",
      "affectedAreas": ["<exact area e.g. forehead | cheeks | nose | chin | under-eyes | jawline | temples | neck>"]
    }
  ],
  "melaninInsights": {
    "pihRisk":          "low|moderate|high",
    "spfGuidance":      "<specific SPF tip for this skin — mention Fitzpatrick scale and UV-triggered PIH risk>",
    "sensitivityFlags": ["<ingredient or environmental trigger specific to this person's observed skin state>"],
    "melanocyteNotes":  "<plain-English observation about melanin activity — e.g. 'Active melanocytes visible in cheek and forehead zones, indicating high PIH risk post-breakout'>"
  },
  "goodIngredients":  ["<ingredient specifically suited to the conditions and Fitzpatrick scale observed>"],
  "avoidIngredients": ["<ingredient to avoid — always include fragrance, alcohol denat., plus anything risky for their specific conditions>"],
  "routine": [
    {
      "order":         <1-10>,
      "timeOfDay":     "morning|night|both",
      "step":          "<step name — use ONLY: Cleanse | Double Cleanse | Tone | Serum | Treatment | Eye Cream | Moisturise | SPF | Oil | Mask | Exfoliate>",
      "productType":   "<precise product type e.g. 'low-pH gentle foaming cleanser' rather than just 'cleanser'>",
      "keyIngredient": "<the single most important active this person needs — must target their top visible condition>",
      "notes":         "<practical tip in max 10 words — specific to their skin>"
    }
  ],
  "progressMilestones": [
    { "week": 2,  "label": "<early win milestone>",    "description": "<realistic change this exact person will see — reference their specific conditions>" },
    { "week": 6,  "label": "<visible improvement>",    "description": "<realistic change this exact person will see>" },
    { "week": 12, "label": "<meaningful skin change>",  "description": "<realistic change this exact person will see>" },
    { "week": 24, "label": "<long-term transformation>","description": "<realistic long-term outcome for their skin>" }
  ],
  "disclaimer": "This is a cosmetic, observational skin analysis only. Not a medical diagnosis. Consult a dermatologist for clinical concerns."
}

═══════════════════════════════════════════════════════
STEP 3 — SCORING CALIBRATION (read before scoring)
═══════════════════════════════════════════════════════
- HEALTHY CLEAR SKIN: overallScore 78–92, minimal conditions, clarity 80+, evenness 75+
- MILD BREAKOUTS + SOME PIH: overallScore 58–72, clarity 45–65, evenness 50–70
- MODERATE ACNE + CLEAR PIH PATCHES: overallScore 42–58, clarity 30–50, evenness 35–55
- SEVERE ACNE + WIDESPREAD HYPERPIGMENTATION: overallScore 25–42
- Never default to 75. Every image is different.

ABSOLUTE RULES:
- Every score must reflect what is actually visible in this specific image. Do NOT copy defaults.
- Only list conditions you can see visible evidence of — no guessing, no over-diagnosis
- PIH risk must be assessed every time — Fitzpatrick IV–VI always has elevated PIH risk
- Post-acne dark marks count as PIH even if mild — include them
- Distinguish PIH (flat dark spots from past breakouts) from active acne (raised, pus-filled)
- Do NOT recommend retinoids above 0.3% as a first recommendation
- SPF 50 is mandatory for all melanin skin — list it in the routine every time
- Flag chemical exfoliants (AHA/BHA) with a PIH risk note in melaninInsights.sensitivityFlags
- Always include fragrance and alcohol denat. in avoidIngredients for melanin skin
- Products and ingredients must suit the Nigerian market
- Be honest and specific — the more accurate you are, the better the product matching
`.trim();

// ── Build Gemini inlineData part ──────────────────────────────
function buildInlinePart(imageBase64, mimeType = 'image/jpeg') {
  const clean = imageBase64.replace(/^data:image\/[a-z]+;base64,/i, '').trim();
  if (!clean || clean.length < 200) {
    throw new AppError('The submitted image is empty or too small to analyse.', 400);
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
    `Could not parse AI response as JSON. First 300 chars: ${text.substring(0, 300)}`
  );
}

// ── Main exported function ────────────────────────────────────
async function analyseSkinImageBase64(imageBase64, mimeType = 'image/jpeg') {
  const t0        = Date.now();
  const imagePart = buildInlinePart(imageBase64, mimeType);

  logger.info(`AI scan: starting (mimeType=${mimeType}, base64Len=${imageBase64.length})`);

  const { result: rawText, engine } = await runWithRotation('vision', {
    temperature:     0.35,    // Higher → more natural language variation per face
    topP:            0.85,
    maxOutputTokens: 4096,
  }, async (model) => {
    const prompt = `${SCAN_PROMPT}\n\nAnalyse the skin visible in this image and return only the JSON object described above.`;
    const resp   = await model.generateContent([prompt, imagePart]);
    const result = resp.response;

    // ── Check for SAFETY block ─────────────────────────────
    //  The model blocks some images for safety reasons. Thrown as an
    //  AppError so the rotation engine treats it as final — trying a
    //  different backup won't change a content-safety verdict.
    const finishReason = result.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') {
      const ratings = result.candidates?.[0]?.safetyRatings || [];
      logger.warn(`AI scan: content safety block triggered. Ratings: ${JSON.stringify(ratings)}`);
      throw new AppError(
        'This image could not be analysed due to content safety filters. ' +
        'Please ensure the image shows only your face clearly in good lighting.',
        422,
      );
    }

    // ── Check for prompt feedback block ───────────────────
    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      logger.warn(`AI scan: request blocked (${blockReason})`);
      throw new AppError('This request was blocked by content safety filters. Please try a different image.', 422);
    }

    // ── Check response is non-empty ────────────────────────
    if (!result.candidates?.length) {
      throw new AppError('The image could not be analysed. It may be unclear or unsupported. Please try again.', 422);
    }

    return result.text();
  });

  const processingTimeMs = Date.now() - t0;
  logger.info(`AI scan: completed in ${processingTimeMs}ms`);

  // ── Parse the JSON response ────────────────────────────────
  let parsed;
  try {
    parsed = extractJSON(rawText);
  } catch (e) {
    logger.error(`AI scan: JSON parse failed — ${e.message}`);
    throw new AppError('The AI analysis could not be understood. Please try again.', 502);
  }

  // ── Validate required fields ───────────────────────────────
  if (!parsed.skinType || parsed.overallScore === undefined) {
    logger.error(`AI scan: incomplete result. Raw preview: ${rawText.substring(0, 400)}`);
    throw new AppError('The AI analysis was incomplete. Please try again.', 502);
  }

  return {
    ...parsed,
    processingTimeMs,
    rawAIOutput:    rawText,
    engineModel:    engine.model,
    engineKeyIndex: engine.keyIndex,
  };
}

module.exports = { analyseSkinImageBase64 };
