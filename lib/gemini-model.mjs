/** Why: gemini-2.5-flash is the current stable model; older 1.x/2.0 names are deprecated or unavailable. What: default used when env empty or unknown. */
const FALLBACK = 'gemini-2.5-flash';

const LEGACY_MODEL_IDS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro',
  'gemini-1.5-pro-latest',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-latest',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-exp',
]);

/** Why: keep a single place for env parsing and legacy aliases. What: returns the model id string for @google/generative-ai. */
export function resolveGeminiModelName() {
  const raw = String(process.env.GEMINI_MODEL || '').trim();
  if (!raw) return FALLBACK;
  if (LEGACY_MODEL_IDS.has(raw.toLowerCase())) return FALLBACK;
  return raw;
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
