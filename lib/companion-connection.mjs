import { getConfig, setConfig } from './db.mjs';
import { CompanionApiError } from './companion-api-client.mjs';
import { maskConnectionKey } from './coding-agent-connection.mjs';

export const COMPANION_CONNECTION_KEY = 'companionConnection';
export const MIN_COMPANION_TOKEN_HINT = 4;

export const COMPANION_HE = Object.freeze({
  urlEmpty: 'יש להזין כתובת בסיס',
  urlInvalid: 'כתובת הבסיס אינה תקינה',
  tokenEmpty: 'יש להזין אסימון',
  disconnected: 'המלווה מנותק',
  connected: 'המלווה מחובר',
  mock: 'המלווה במצב מדומה',
  connecting: 'מחברים את המלווה',
  connectFailed: 'החיבור למלווה נכשל',
  timeout: 'תם הזמן לחיבור למלווה',
  unauthorized: 'האסימון נדחה. בדקו את האסימון ונסו שוב.',
  bothGate: 'כתובת לבד לא מחברת. חיבור מפעיל מלווה חי רק עם כתובת ואסימון יחד.',
  httpError: 'שגיאת שרת במלווה',
  parse: 'תשובת המלווה אינה תקינה',
  hint: 'חיבור דורש כתובת ואסימון יחד. כתובת לבד לא מחברת.',
});

function trim(value) {
  return String(value || '').trim();
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
  return {
    COMPANION_MODE: env.COMPANION_MODE,
    JETSON_COMPANION_BASE_URL: env.JETSON_COMPANION_BASE_URL,
    JETSON_COMPANION_TOKEN: env.JETSON_COMPANION_TOKEN,
    COMPANION_SHARED_SECRET: env.COMPANION_SHARED_SECRET,
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
    trim(env.JETSON_COMPANION_TOKEN),
    trim(env.COMPANION_SHARED_SECRET),
    trim(token),
  ].filter((s) => s.length > 0);
}

export function statusHeForMode(mode) {
  if (mode === 'real') return COMPANION_HE.connected;
  if (mode === 'mock') return COMPANION_HE.mock;
  return COMPANION_HE.disconnected;
}

export function buildPublicCompanionConnectionStatus({
  service,
  db = null,
  env = {},
} = {}) {
  const stored = readStoredCompanionConnection(db);
  const desc = service?.describe?.() || { mode: 'off', baseUrlConfigured: false, baseUrl: null };
  const mode = desc.mode || 'off';
  const connected = mode === 'real';
  const overlay = service?.getSseOverlay?.()?.companion || null;
  const envToken = trim(env.JETSON_COMPANION_TOKEN) || trim(env.COMPANION_SHARED_SECRET);
  const hintSource = stored.token || (connected ? envToken : '');
  const baseUrl = connected
    ? (desc.baseUrl && desc.baseUrl !== 'mock://companion' ? desc.baseUrl : stored.baseUrl)
    : stored.baseUrl;
  return {
    ok: true,
    mode,
    connected,
    reachable: overlay?.reachable === true,
    status_he: statusHeForMode(mode),
    reason_he: null,
    token_hint: connected && hintSource ? maskCompanionToken(hintSource) : null,
    base_url: baseUrl || null,
    connect_available: !connected,
    disconnect_available: connected,
    live_applied: true,
    path_hint: '/api/v1/*',
    hint_he: COMPANION_HE.hint,
  };
}
