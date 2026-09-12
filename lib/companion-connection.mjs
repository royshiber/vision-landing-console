import { getConfig, setConfig } from './db.mjs';
import { CompanionApiError } from './companion-api-client.mjs';
import { maskConnectionKey } from './coding-agent-connection.mjs';
import { summarizeCompanionLink } from './companion-link.mjs';
import { applyMavlinkRelayHint } from './companion-mavlink-relay.mjs';
import { normalizeCompanionSecret, readCompanionTokenFromEnv } from './companion-secret.mjs';

export { normalizeCompanionSecret, readCompanionTokenFromEnv } from './companion-secret.mjs';

export const COMPANION_CONNECTION_KEY = 'companionConnection';
export const MIN_COMPANION_TOKEN_HINT = 4;

/**
 * Product default for Roy's one Jetson (Tailscale).
 * Used only for one-click connect when stored/env URL is empty.
 * Does not enable real by itself — BOTH gate still requires mode=real after connect.
 */
export const DEFAULT_COMPANION_BASE_URL = 'http://100.82.59.45:8081';
export const DEFAULT_COMPANION_CONNECT_URL = DEFAULT_COMPANION_BASE_URL;

export function stripWrappedQuotes(value) {
  return normalizeCompanionSecret(value);
}

export const COMPANION_HE = Object.freeze({
  urlEmpty: 'חסרה כתובת',
  urlInvalid: 'הכתובת אינה תקינה',
  tokenEmpty: 'חסר אסימון',
  tokenMissingHint: 'חסר אסימון. הזינו אותו במתקדם.',
  disconnected: 'Jetson מנותק',
  connected: 'Jetson מחובר',
  mock: 'Jetson במצב מדומה',
  connecting: 'מחברים Jetson',
  unreachable: 'Jetson לא מגיב',
  connectFailed: 'חיבור מחשב משימה נכשל',
  timeout: 'חיבור מחשב משימה ארך יותר מדי',
  unauthorized: 'האסימון נדחה. בדקו את האסימון ונסו שוב.',
  bothGate: 'כתובת לבד לא מספיקה. צריך גם אסימון.',
  httpError: 'שגיאת שרת במחשב משימה',
  parse: 'תשובת מחשב משימה אינה תקינה',
  hint: 'צריך כתובת ואסימון. כתובת לבד לא מספיקה.',
});

function trim(value) {
  return normalizeCompanionSecret(value);
}

export function maskCompanionToken(token) {
  return maskConnectionKey(token);
}

export function validateCompanionBaseUrl(raw) {
  const url = trim(raw).replace(/\/+$/, '');
  if (!url) {
    return { ok: false, error: 'url_empty', status_he: COMPANION_HE.urlEmpty };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'url_invalid', status_he: COMPANION_HE.urlInvalid };
    }
  } catch {
    return { ok: false, error: 'url_invalid', status_he: COMPANION_HE.urlInvalid };
  }
  return { ok: true, url };
}

export function validateCompanionToken(raw) {
  const token = trim(raw);
  if (!token) {
    return { ok: false, error: 'token_empty', status_he: COMPANION_HE.tokenEmpty };
  }
  return { ok: true, token };
}

export function hebrewCompanionError(err) {
  if (!err) return COMPANION_HE.connectFailed;
  if (err instanceof CompanionApiError || err?.kind) {
    if (err.kind === 'timeout') return COMPANION_HE.timeout;
    if (err.kind === 'connection') return COMPANION_HE.connectFailed;
    if (err.kind === 'config') return COMPANION_HE.urlEmpty;
    if (err.kind === 'parse') return COMPANION_HE.parse;
    if (err.kind === 'http' && Number(err.status) === 401) return COMPANION_HE.unauthorized;
    if (err.kind === 'http') return COMPANION_HE.httpError;
  }
  return COMPANION_HE.connectFailed;
}

export function emptyCompanionConnection() {
  return {
    connected: false,
    mode: 'off',
    baseUrl: null,
    token: null,
  };
}

export function readStoredCompanionConnection(db) {
  if (!db) return emptyCompanionConnection();
  try {
    const raw = getConfig(db, COMPANION_CONNECTION_KEY, null);
    if (!raw || typeof raw !== 'object') return emptyCompanionConnection();
    const baseUrl = trim(raw.baseUrl) || null;
    const token = trim(raw.token) || null;
    return {
      connected: raw.connected === true && Boolean(baseUrl),
      mode: raw.connected === true && baseUrl ? 'real' : 'off',
      baseUrl,
      token,
    };
  } catch {
    return emptyCompanionConnection();
  }
}

export function writeStoredCompanionConnection(db, conn) {
  if (!db) return { persisted: false };
  const baseUrl = trim(conn?.baseUrl) || null;
  const token = trim(conn?.token) || null;
  const connected = conn?.connected === true && Boolean(baseUrl);
  setConfig(db, COMPANION_CONNECTION_KEY, {
    connected,
    mode: connected ? 'real' : 'off',
    baseUrl,
    token: connected ? token : null,
  });
  return { persisted: true };
}

/**
 * Overlay a stored in-product connect onto env.
 * Real is applied only when the store is explicitly connected AND has a URL.
 * A stored URL alone never enables real.
 */
export function mergeCompanionEnv(baseEnv = {}, stored = null) {
  const env = { ...baseEnv };
  if (!stored?.connected) return env;
  const baseUrl = trim(stored.baseUrl);
  if (!baseUrl) return env;
  const token = trim(stored.token);
  return {
    ...env,
    COMPANION_MODE: 'real',
    JETSON_COMPANION_BASE_URL: baseUrl,
    ...(token
      ? {
          JETSON_COMPANION_TOKEN: token,
          COMPANION_SHARED_SECRET: token,
        }
      : {}),
  };
}

export function snapshotCompanionEnv(env = process.env) {
  const token = readCompanionTokenFromEnv(env);
  return {
    COMPANION_MODE: env.COMPANION_MODE,
    JETSON_COMPANION_BASE_URL: normalizeCompanionSecret(env.JETSON_COMPANION_BASE_URL),
    JETSON_COMPANION_TOKEN: token,
    COMPANION_SHARED_SECRET: token,
    VLC_COMPANION_TOKEN: token,
    COMPANION_TIMEOUT_MS: env.COMPANION_TIMEOUT_MS,
    COMPANION_MOCK_SCENARIO: env.COMPANION_MOCK_SCENARIO,
  };
}

export function companionEnvForService(ctx, stored) {
  const base = { ...(ctx.companionEnv || snapshotCompanionEnv(process.env)) };
  if (ctx.ignoreEnvCompanionReal) {
    const mode = trim(base.COMPANION_MODE).toLowerCase();
    return mergeCompanionEnv({
      ...base,
      COMPANION_MODE: mode === 'mock' ? 'mock' : 'off',
      JETSON_COMPANION_BASE_URL: mode === 'mock' ? base.JETSON_COMPANION_BASE_URL : '',
    }, stored);
  }
  return mergeCompanionEnv(base, stored);
}

export function secretsFromCompanionConnection({ stored = null, env = {}, token = '' } = {}) {
  return [
    trim(stored?.token),
    readCompanionTokenFromEnv(env),
    trim(env.VLC_COMPANION_TOKEN),
    trim(env.JETSON_COMPANION_TOKEN),
    trim(env.COMPANION_SHARED_SECRET),
    trim(token),
  ].filter((s) => s.length > 0);
}

export function statusHeForMode(mode, { reachable } = {}) {
  if (mode === 'mock') return COMPANION_HE.mock;
  if (mode === 'real' && reachable === false) return COMPANION_HE.unreachable;
  if (mode === 'real') return COMPANION_HE.connected;
  return COMPANION_HE.disconnected;
}

/**
 * One-Jetson defaults: stored URL, else env URL, else the baked Tailscale product URL.
 * Token comes from stored DB, else VLC_COMPANION_TOKEN / JETSON_COMPANION_TOKEN /
 * COMPANION_SHARED_SECRET (quotes stripped).
 * Never returns the raw token to callers that serialize JSON — token stays local.
 * A URL (including the baked default) never enables real by itself.
 */
export function resolveCompanionConnectDefaults({ stored = null, env = {} } = {}) {
  const storedUrl = trim(stored?.baseUrl);
  const storedToken = trim(stored?.token);
  const envUrl = trim(env.JETSON_COMPANION_BASE_URL);
  const envToken = readCompanionTokenFromEnv(env);
  const url = storedUrl || envUrl || DEFAULT_COMPANION_BASE_URL;
  const token = storedToken || envToken || null;
  return {
    url,
    token,
    source: storedUrl ? 'stored' : envUrl ? 'env' : 'builtin',
    configured: Boolean(url && token),
    urlConfigured: Boolean(url),
    tokenConfigured: Boolean(token),
  };
}

export function buildPublicCompanionConnectionStatus({
  service,
  db = null,
  env = {},
  mavlinkRelay = null,
} = {}) {
  const stored = readStoredCompanionConnection(db);
  const desc = service?.describe?.() || { mode: 'off', baseUrlConfigured: false, baseUrl: null };
  const mode = desc.mode || 'off';
  const overlay = service?.getSseOverlay?.()?.companion || null;
  const defaults = resolveCompanionConnectDefaults({ stored, env });
  const configuredReal = mode === 'real';
  const reachable = mode === 'mock' ? true : overlay?.reachable === true;
  const connected = configuredReal && reachable;
  const link = summarizeCompanionLink({
    mode,
    reachable,
    health: overlay?.health || null,
    overlay,
    defaultConfigured: defaults.configured,
    urlConfigured: defaults.urlConfigured,
    tokenConfigured: defaults.tokenConfigured,
  });
  const envToken = readCompanionTokenFromEnv(env);
  const hintSource = stored.token || (configuredReal ? envToken : '');
  const baseUrl = configuredReal
    ? (desc.baseUrl && desc.baseUrl !== 'mock://companion' ? desc.baseUrl : stored.baseUrl)
    : (stored.baseUrl || defaults.url);
  const payload = {
    ok: true,
    mode,
    connected,
    reachable,
    configuredReal,
    hasData: link.hasData,
    jetson: link.jetson,
    jetsonStatusHe: link.jetsonStatusHe,
    fc: link.fc,
    fcStatusHe: link.fcStatusHe,
    pillLabelHe: link.pillLabelHe,
    pillDot: link.pillDot,
    status_he: statusHeForMode(mode, { reachable }),
    reason_he: link.jetson === 'unreachable' ? link.hint_he : null,
    token_hint: configuredReal && hintSource ? maskCompanionToken(hintSource) : null,
    base_url: baseUrl || null,
    connect_available: !configuredReal,
    disconnect_available: configuredReal,
    live_applied: true,
    path_hint: '/api/v1/* or legacy /api/health',
    hint_he: (link.jetson === 'unreachable' || (link.connected && !link.hasData))
      ? (link.hint_he || COMPANION_HE.hint)
      : COMPANION_HE.hint,
    link,
  };
  return applyMavlinkRelayHint(payload, mavlinkRelay);
}

export function snapshotCompanionLinkFromCtx(ctx = {}) {
  const env = ctx.companionEnv || snapshotCompanionEnv(process.env);
  const stored = readStoredCompanionConnection(ctx.db || null);
  const defaults = resolveCompanionConnectDefaults({ stored, env });
  const overlay = ctx.companionService?.getSseOverlay?.()?.companion || null;
  const mode = ctx.companionService?.mode || overlay?.mode || 'off';
  const reachable = overlay?.reachable === true || mode === 'mock';
  const health = overlay?.health || null;
  const link = summarizeCompanionLink({
    mode,
    reachable,
    health,
    overlay,
    defaultConfigured: defaults.configured,
    urlConfigured: defaults.urlConfigured,
    tokenConfigured: defaults.tokenConfigured,
  });
  return applyMavlinkRelayHint({
    ...link,
    defaultUrlConfigured: defaults.urlConfigured,
    defaultSource: defaults.source,
    base_url: defaults.url || null,
  }, ctx.lastCompanionMavlinkRelay || null);
}
