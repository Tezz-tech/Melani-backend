// src/config/gemini.js
//
//  AI text/vision engine — automatic model + API-key rotation.
//  ──────────────────────────────────────────────────────────────
//  - Multiple API keys are loaded from GEMINI_API_KEY_1, _2, _3, ...
//  - Multiple model names are tried per call kind ('text' | 'vision'),
//    configurable via GEMINI_TEXT_MODELS / GEMINI_VISION_MODELS
//    (comma-separated, priority order — first is preferred).
//  - On a rate-limit / quota / overload response, the engine silently
//    rotates to the next model on the SAME key. Once every model has
//    been tried on that key, it rotates to the next key and starts
//    again from the first model. This repeats until a call succeeds
//    or every (key, model) combination has been tried.
//  - Every failure is classified and converted into a brand-neutral
//    AppError before it can reach a controller. Vendor/model names
//    are stripped from anything that gets logged at warn/error level
//    or attached to a thrown error — callers and log output never
//    reveal which AI provider or model is behind a request.
//
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger   = require('../utils/logger');
const AppError = require('../utils/apperror');

const ENGINE_LABEL = process.env.AI_ENGINE_LABEL || 'AI engine';

// ── Brand redaction ────────────────────────────────────────────
//  Strips vendor-identifying tokens from any string before it is
//  logged or attached to an error that might bubble up further.
const BRAND_PATTERN = /google\s*generative\s*ai|generativelanguage\.googleapis\.com|gemini(?:[\s-][\w.]+)?|\bgoogle\b/gi;
function redact(str = '') {
  return String(str).replace(BRAND_PATTERN, ENGINE_LABEL);
}

// ── 1. Load all API keys ────────────────────────────────────────
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
    throw new AppError('AI service is not configured. Please try again later.', 503);
  }
  logger.info(`${ENGINE_LABEL}: loaded ${keys.length} credential(s)`);
  return keys;
}

// ── 2. Model lists (priority order) ─────────────────────────────
//  Resolution order per kind: <KIND>_MODELS (comma list) →
//  <KIND>_MODEL (single, back-compat) → built-in default list.
const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
];

function loadModelList(pluralEnv, singularEnv) {
  const plural = process.env[pluralEnv];
  if (plural && plural.trim()) {
    return plural.split(',').map(s => s.trim()).filter(Boolean);
  }
  const single = process.env[singularEnv];
  if (single && single.trim()) return [single.trim()];
  return DEFAULT_MODELS;
}

function getModelList(kind) {
  return kind === 'vision'
    ? loadModelList('GEMINI_VISION_MODELS', 'GEMINI_VISION_MODEL')
    : loadModelList('GEMINI_TEXT_MODELS', 'GEMINI_TEXT_MODEL');
}

// ── 3. Key clients (lazy-init) ───────────────────────────────────
let _keyClients = null;
function getKeyClients() {
  if (_keyClients) return _keyClients;
  const keys = loadKeys();
  _keyClients = keys.map((key, index) => ({ index, key, client: new GoogleGenerativeAI(key) }));
  return _keyClients;
}

// ── 4. Combo matrix (key × model) — built lazily, once, per kind ─
//  Ordered key-major: every model for key 0, then every model for
//  key 1, ... so a quota hit rotates through the full model list on
//  the CURRENT key before ever moving to the next key.
const _combosCache = {};   // kind -> combo[]
const _pointers    = {};   // kind -> rotation pointer
const _health      = {};   // "keyIndex:model" -> { errors, lastError }

function getCombos(kind) {
  if (_combosCache[kind]) return _combosCache[kind];
  const keyClients = getKeyClients();
  const models     = getModelList(kind);
  const combos = [];
  for (const kc of keyClients) {
    for (const modelName of models) {
      combos.push({ keyIndex: kc.index, client: kc.client, modelName, id: `${kc.index}:${modelName}` });
    }
  }
  _combosCache[kind] = combos;
  _pointers[kind]    = 0;
  return combos;
}

function healthOf(id) {
  return _health[id] || (_health[id] = { errors: 0, lastError: null });
}

function isHealthy(id) {
  const h = healthOf(id);
  const cooled = !h.lastError || (Date.now() - h.lastError > 60_000);
  if (cooled && h.errors > 0) h.errors = 0;
  return h.errors < 2 || cooled;
}

function nextHealthyIndex(kind) {
  const combos = getCombos(kind);
  const start  = _pointers[kind] || 0;
  for (let offset = 0; offset < combos.length; offset++) {
    const idx = (start + offset) % combos.length;
    if (isHealthy(combos[idx].id)) return idx;
  }
  logger.warn(`${ENGINE_LABEL}: every backup is currently throttled — retrying from the top`);
  return start % combos.length;
}

// ── 5. STRICT quota / overload error detection ───────────────────
//  Only genuine capacity signals trigger rotation. Everything else
//  (bad request, safety block, invalid argument, ...) surfaces
//  immediately instead of burning through every backup pointlessly.
function isQuotaError(err) {
  const msg    = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode || err.httpStatus || 0;

  if (status === 429 || status === 503)      return true;
  if (msg.includes('resource_exhausted'))    return true;
  if (msg.includes('quota exceeded'))        return true;
  if (msg.includes('rate limit exceeded'))   return true;
  if (msg.includes('ratelimitexceeded'))     return true;
  if (msg.includes('too many requests'))     return true;
  if (msg.includes('userratelimitexceeded')) return true;
  if (msg.includes('overloaded'))            return true;

  return false;
}

function describeError(err) {
  const status  = err.status || err.statusCode || err.httpStatus || '?';
  const message = err.message || String(err);
  const details = err.errorDetails || err.details;
  return redact(`HTTP ${status} — ${message}${details ? ` | ${JSON.stringify(details)}` : ''}`);
}

// ── 6. Auto-rotating runner ────────────────────────────────────────
//  kind:             'text' | 'vision'
//  generationConfig: passed straight to getGenerativeModel()
//  fn(model):        performs the actual call, returns its result
//
//  Resolves to { result, engine: { model, keyIndex } } on success.
//  Rejects with a brand-neutral AppError on failure — quota errors
//  are retried across the combo matrix; anything else (or an AppError
//  thrown deliberately by fn, e.g. a content-safety block) surfaces
//  immediately without burning through backups.
const MAX_RETRIES_ENV = parseInt(process.env.GEMINI_MAX_RETRIES || '0', 10);

async function runWithRotation(kind, generationConfig, fn, attempt = 0) {
  const combos      = getCombos(kind);
  const maxAttempts = MAX_RETRIES_ENV > 0
    ? Math.min(MAX_RETRIES_ENV, combos.length)
    : Math.min(combos.length, 8);

  if (attempt >= maxAttempts) {
    logger.error(`${ENGINE_LABEL}: exhausted all ${maxAttempts} available backup(s) for this request`);
    throw new AppError('Our AI assistant is a little busy right now. Please try again shortly.', 503);
  }

  const idx   = nextHealthyIndex(kind);
  _pointers[kind] = (idx + 1) % combos.length;
  const combo = combos[idx];

  try {
    const model  = combo.client.getGenerativeModel({ model: combo.modelName, generationConfig });
    const result = await fn(model);
    healthOf(combo.id).errors = 0;
    return { result, engine: { model: combo.modelName, keyIndex: combo.keyIndex } };
  } catch (err) {
    // A deliberately-thrown, already-classified error (e.g. a content
    // safety block) — don't retry, don't re-wrap, just let it through.
    if (err instanceof AppError) throw err;

    if (isQuotaError(err)) {
      const h = healthOf(combo.id);
      h.errors++;
      h.lastError = Date.now();
      logger.warn(
        `${ENGINE_LABEL}: backup ${idx + 1}/${combos.length} is rate-limited ` +
        `(attempt ${attempt + 1}/${maxAttempts}) — switching over. ${describeError(err)}`
      );
      return runWithRotation(kind, generationConfig, fn, attempt + 1);
    }

    logger.error(`${ENGINE_LABEL}: request failed on backup ${idx + 1}/${combos.length} — ${describeError(err)}`);
    throw new AppError('The AI assistant could not process this request. Please try again.', 502);
  }
}

// ── 7. Admin-only status report ───────────────────────────────────
function maskKey(key) {
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function getEngineStatus() {
  const keyClients = _keyClients || [];
  const status = {};
  for (const kind of Object.keys(_combosCache)) {
    status[kind] = _combosCache[kind].map((c, i) => {
      const h = _health[c.id] || { errors: 0, lastError: null };
      const cooled  = !h.lastError || (Date.now() - h.lastError > 60_000);
      const healthy = h.errors < 2 || cooled;
      return {
        slot:       i + 1,
        model:      c.modelName,
        keyIndex:   c.keyIndex + 1,
        keyPreview: keyClients[c.keyIndex] ? maskKey(keyClients[c.keyIndex].key) : undefined,
        healthy,
        errors:     h.errors,
        lastError:  h.lastError,
      };
    });
  }
  return status;
}

module.exports = { runWithRotation, getEngineStatus };
