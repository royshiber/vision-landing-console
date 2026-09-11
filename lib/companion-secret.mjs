/**
 * Normalize Companion secrets copied from shell `export` lines or .env.
 * Surrounding single/double quotes must be stripped or auth 401s
 * (token_len 50 vs 48). No imports — safe for api-client and connection.
 */

export function normalizeCompanionSecret(raw) {
  let value = String(raw ?? '').trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}

/**
 * Token sources, first match wins after quote-strip.
 * VLC_COMPANION_TOKEN is the Jetson/shell export name in docs/JETSON_AGENT.md.
 */
export function readCompanionTokenFromEnv(env = {}) {
  return (
    normalizeCompanionSecret(env.VLC_COMPANION_TOKEN)
    || normalizeCompanionSecret(env.JETSON_COMPANION_TOKEN)
    || normalizeCompanionSecret(env.COMPANION_SHARED_SECRET)
    || ''
  );
}
