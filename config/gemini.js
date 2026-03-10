// src/config/gemini.js
//
//  FIXES vs previous version:
//  ──────────────────────────────────────────────────────────────
//  BUG: isQuotaError() used broad substring matches ('rate', 'quota')
//  which incorrectly flagged 400 Bad Request, SAFETY blocks, and
//  other non-quota Gemini errors as quota errors.  This caused
//  runWithRotation to retry across all keys and exhaust MAX_RETRIES,
//  even though the keys had plenty of tokens left.
//
//  FIX 1 — isQuotaError() is now STRICT:
//    Only retries on HTTP 429, HTTP 503, gRPC RESOURCE_EXHAUSTED,
//    or the exact phrases "quota exceeded" / "rate limit exceeded".
//    All other errors (400, SAFETY, INVALID_ARGUMENT, etc.) bubble
//    up immediately with the full error detail visible in logs.
//
//  FIX 2 — Always log the real Gemini error before any retry decision,
//    so you can see in your server logs exactly what Gemini returned.
//
//  FIX 3 — Non-quota errors are enriched with the Gemini detail
//    string so scanController can log the actual root cause.
//
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// ── 1. Load all keys ──────────────────────────────────────────
function loadKeys() {
  const keys = [];
  let i = 1;
  while (true) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (!k) break;
    keys.push(k.trim());
    i++;
  }
  if (keys.length === 0) {
    throw new Error(
      'No Gemini API keys found. Set GEMINI_API_KEY_1 (and optionally _2, _3…) in your .env',
    );
  }
  logger.info(`Gemini: loaded ${keys.length} API key(s)`);
  return keys;
}

// ── 2. Client pool ────────────────────────────────────────────
const _keys    = loadKeys();
const _clients = _keys.map((key, index) => ({
  index,
  key,
  client:    new GoogleGenerativeAI(key),
  errors:    0,
  lastError: null,
}));

let _pointer = 0;

// ── 3. Round-robin getter ─────────────────────────────────────
function getGeminiClient() {
  const entry = _clients[_pointer];
  _pointer    = (_pointer + 1) % _clients.length;
  return entry.client;
}

// ── 4. Health-aware index picker ─────────────────────────────
function _nextHealthyIndex(start) {
  for (let offset = 0; offset < _clients.length; offset++) {
    const idx   = (start + offset) % _clients.length;
    const entry = _clients[idx];
    const cooled = !entry.lastError || (Date.now() - entry.lastError > 60_000);
    if (entry.errors < 3 || cooled) {
      if (cooled) entry.errors = 0;
      return idx;
    }
  }
  logger.warn('Gemini: all keys appear throttled, falling back to key 0');
  return 0;
}

// ── 5. STRICT quota error detection ──────────────────────────
//
//  Previous: matched any message containing 'rate' or 'quota' —
//  too broad, false-positives on 400 errors and SAFETY blocks.
//
//  Now: only retries on genuine quota/overload signals.
//
const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '3', 10);

function isQuotaError(err) {
  const msg    = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode || err.httpStatus || 0;

  if (status === 429 || status === 503)        return true;
  if (msg.includes('resource_exhausted'))      return true;
  if (msg.includes('quota exceeded'))          return true;
  if (msg.includes('rate limit exceeded'))     return true;
  if (msg.includes('ratelimitexceeded'))       return true;
  if (msg.includes('too many requests'))       return true;
  if (msg.includes('userratelimitexceeded'))   return true;

  return false;
}

// ── 6. Error-to-string helper ─────────────────────────────────
function describeError(err) {
  const status  = err.status || err.statusCode || err.httpStatus || '?';
  const message = err.message || String(err);
  const details = err.errorDetails || err.details;
  return `HTTP ${status} — ${message}${details ? ` | ${JSON.stringify(details)}` : ''}`;
}

// ── 7. Auto-rotating runner ───────────────────────────────────
async function runWithRotation(fn, attempt = 0) {
  if (attempt >= MAX_RETRIES) {
    throw new Error(`Gemini: exhausted ${MAX_RETRIES} retries across all keys`);
  }

  const idx   = _nextHealthyIndex(_pointer);
  _pointer    = (idx + 1) % _clients.length;
  const entry = _clients[idx];

  try {
    const result = await fn(entry.client);
    entry.errors = 0;
    return result;
  } catch (err) {
    // Always log the actual Gemini error — critical for debugging
    logger.error(
      `[Gemini key ${idx + 1}] attempt ${attempt + 1}/${MAX_RETRIES}: ${describeError(err)}`
    );

    if (isQuotaError(err)) {
      // Genuine quota hit — mark key and rotate
      entry.errors++;
      entry.lastError = Date.now();
      logger.warn(`[Gemini key ${idx + 1}] quota-limited, rotating to next key…`);
      return runWithRotation(fn, attempt + 1);
    }

    // Any other error (400 bad request, SAFETY block, network, etc.)
    // → do NOT retry, surface immediately with the real error detail
    const enriched     = new Error(`Gemini API error: ${describeError(err)}`);
    enriched.cause     = err;
    enriched.keyIndex  = idx + 1;
    throw enriched;
  }
}

// ── 8. Convenience getters ────────────────────────────────────
function getVisionModel(clientOverride) {
  const c = clientOverride || getGeminiClient();
  return c.getGenerativeModel({ model: process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash' });
}

function getTextModel(clientOverride) {
  const c = clientOverride || getGeminiClient();
  return c.getGenerativeModel({ model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash' });
}

// ── 9. Admin status report ────────────────────────────────────
function getKeyStatus() {
  return _clients.map((e, i) => ({
    index:      i + 1,
    errors:     e.errors,
    lastError:  e.lastError,
    healthy:    e.errors < 3 || (Date.now() - (e.lastError || 0) > 60_000),
    keyPreview: `${e.key.slice(0, 8)}…${e.key.slice(-4)}`,
  }));
}

module.exports = { getGeminiClient, runWithRotation, getVisionModel, getTextModel, getKeyStatus };