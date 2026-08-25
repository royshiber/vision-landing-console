import { getConfig, setConfig } from './db.mjs';
import { ASSIST_HE, hebrewUnavailableReason } from './assist/assist-hebrew.mjs';

export const CODING_AGENT_CONNECTION_KEY = 'codingAgentConnection';
export const PRODUCT_AGENT_PROVIDER = 'cursor-sdk';
export const MIN_CONNECTION_KEY_LENGTH = 8;

function trimKey(value) {
  return String(value || '').trim();
}

export function maskConnectionKey(key) {
  const s = trimKey(key);
  if (!s) return null;
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

export function validateConnectionKey(raw) {
  const key = trimKey(raw);
  if (!key) {
    return { ok: false, error: 'key_empty', status_he: ASSIST_HE.agentKeyEmpty };
  }
  if (key.length < MIN_CONNECTION_KEY_LENGTH) {
    return { ok: false, error: 'key_invalid', status_he: ASSIST_HE.agentKeyInvalid };
  }
  return { ok: true, key };
}

export function readStoredConnection(db) {
  if (!db) return { connected: false, provider: PRODUCT_AGENT_PROVIDER, apiKey: null };
  try {
    const raw = getConfig(db, CODING_AGENT_CONNECTION_KEY, null);
    if (!raw || typeof raw !== 'object') {
      return { connected: false, provider: PRODUCT_AGENT_PROVIDER, apiKey: null };
    }
    const apiKey = trimKey(raw.apiKey);
    return {
      connected: apiKey.length > 0 && raw.connected !== false,
      provider: PRODUCT_AGENT_PROVIDER,
      apiKey: apiKey || null,
    };
  } catch {
    return { connected: false, provider: PRODUCT_AGENT_PROVIDER, apiKey: null };
  }
}

export function writeStoredConnection(db, apiKey) {
  if (!db) return { persisted: false };
  const key = trimKey(apiKey);
  setConfig(db, CODING_AGENT_CONNECTION_KEY, {
    connected: Boolean(key),
    provider: PRODUCT_AGENT_PROVIDER,
    apiKey: key || null,
  });
  return { persisted: true };
}

export function mergeAgentEnv(baseEnv = {}, stored = null) {
  const env = { ...baseEnv };
  const storedKey = trimKey(stored?.apiKey);
  if (storedKey && stored?.connected !== false) {
    return {
      ...env,
      DEVELOPMENT_AGENT_PROVIDER: PRODUCT_AGENT_PROVIDER,
      CURSOR_API_KEY: storedKey,
    };
  }
  return env;
}

export function secretsFromConnection({ stored = null, env = {}, key = '' } = {}) {
  return [trimKey(stored?.apiKey), trimKey(env.CURSOR_API_KEY), trimKey(key)].filter((s) => s.length > 0);
}

export function payloadContainsSecret(payload, secrets) {
  const dump = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return secrets.some((s) => s && dump.includes(s));
}

export function assertNoSecretPayload(payload, secrets, label = 'payload') {
  if (payloadContainsSecret(payload, secrets)) {
    throw new Error(`${label} leaked a connection key`);
  }
  return payload;
}

function namedReady(provider) {
  const name = String(provider?.providerName || '');
  return name !== 'unavailable' && !name.startsWith('unavailable');
}

export async function buildPublicAgentConnectionStatus({
  provider,
  db = null,
  env = {},
} = {}) {
  const stored = readStoredConnection(db);
  const envKey = trimKey(env.CURSOR_API_KEY);
  let runtime = { ok: false, reason: provider?.unavailableReason || 'agent-connection-missing' };
  try {
    if (provider && typeof provider.getRuntimeStatus === 'function') {
      const probed = await provider.getRuntimeStatus();
      if (probed && typeof probed === 'object') runtime = probed;
    } else {
      runtime = { ok: namedReady(provider), reason: provider?.unavailableReason || 'agent-connection-missing' };
    }
  } catch (err) {
    runtime = { ok: false, reason: String(err?.message || 'agent-connection-missing') };
  }

  const ready = runtime?.ok === true;
  const hintSource = stored.apiKey || envKey || '';
  const payload = {
    ok: true,
    runtime: ready ? 'READY' : 'UNAVAILABLE',
    connected: ready,
    status_he: ready ? ASSIST_HE.agentConnected : ASSIST_HE.agentDisconnected,
    reason_he: ready ? null : hebrewUnavailableReason(runtime?.reason || provider?.unavailableReason),
    key_hint: ready ? maskConnectionKey(hintSource) : null,
    connect_available: !ready,
    disconnect_available: ready,
    live_applied: true,
  };
  const secrets = secretsFromConnection({ stored, env });
  if (payloadContainsSecret(payload, secrets)) {
    payload.key_hint = ready ? '••••' : null;
  }
  return assertNoSecretPayload(payload, secrets, 'agent status');
}
