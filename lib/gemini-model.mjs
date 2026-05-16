/** Why: Google rotates model ids; new keys often get 404 on older names. What: default used when env empty or legacy. */
const FALLBACK = 'gemini-2.5-flash';

/** Ordered fallback chain tried when primary model is unavailable (503/404). */
const FALLBACK_CHAIN = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

const LEGACY_MODEL_IDS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro',
  'gemini-1.5-pro-latest',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-latest',
]);

/** Why: keep a single place for env parsing and legacy aliases. What: returns the model id string for @google/generative-ai. */
export function resolveGeminiModelName() {
  const raw = String(process.env.GEMINI_MODEL || '').trim();
  if (!raw) return FALLBACK;
  if (LEGACY_MODEL_IDS.has(raw.toLowerCase())) return FALLBACK;
  return raw;
}

/**
 * Returns an ordered list of model IDs to try: env-configured first, then fallbacks.
 * Callers should try each in sequence, stopping at the first success.
 */
export function getGeminiModelChain() {
  const primary = resolveGeminiModelName();
  const rest = FALLBACK_CHAIN.filter((m) => m !== primary);
  return [primary, ...rest];
}

/**
 * Flight Engineer may use a different primary model (e.g. Pro for reasoning) while Advisor keeps GEMINI_MODEL.
 * Env: FLIGHT_ENGINEER_GEMINI_MODEL — unset = same chain as `getGeminiModelChain()`.
 */
export function getFlightEngineerGeminiModelChain() {
  const raw = String(process.env.FLIGHT_ENGINEER_GEMINI_MODEL || '').trim();
  if (!raw) return getGeminiModelChain();
  const primary = LEGACY_MODEL_IDS.has(raw.toLowerCase()) ? FALLBACK : raw;
  const rest = FALLBACK_CHAIN.filter((m) => m !== primary);
  return [primary, ...rest];
}

/** Why: health endpoint diagnostics without secrets. What: raw env value, effective id, and whether legacy mapping applied. */
export function getGeminiModelInfo() {
  const envRaw = String(process.env.GEMINI_MODEL || '').trim() || null;
  const effective = resolveGeminiModelName();
  const remapped = Boolean(
    envRaw && effective === FALLBACK && LEGACY_MODEL_IDS.has(envRaw.toLowerCase()),
  );
  return { env: envRaw, effective, remapped };
}
