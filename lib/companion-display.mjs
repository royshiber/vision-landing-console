/**
 * Console display helpers for Companion API v1.
 * No aircraft logic. No invented wire fields. Missing numerics stay null.
 */

export const MAVLINK_DISPLAY_CATEGORIES = Object.freeze([
  'HEARTBEAT',
  'STATUS',
  'GPS',
  'ATTITUDE',
  'BATTERY',
  'PARAMETERS',
  'MISSIONS',
  'COMMANDS',
  'RC',
  'VISION',
  'LANDING_TARGET',
  'HIGH_RATE',
]);

export const CONFIG_TIER = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  RUNTIME: 'RUNTIME',
  FLIGHT_CRITICAL: 'FLIGHT_CRITICAL',
});

const FC_CATEGORY_FIELDS = Object.freeze({
  HEARTBEAT: 'heartbeat',
  STATUS: 'sys_status',
  GPS: 'global_position_int',
  ATTITUDE: 'attitude',
});

export function videoPipelineUiState(name, { degraded = false } = {}) {
  const s = String(name || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'unavailable') return 'unavailable';
  if (s === 'stopped' || s === 'off' || s === 'idle') return 'stopped';
  if (s === 'starting') return 'starting';
  if (degraded) return 'degraded';
  return 'available';
}

export function policyTokenState(channel, token) {
  if (!channel || typeof channel !== 'object') return 'unspecified';
  const deny = [...(channel.deny || []), ...(channel.deny_in || []), ...(channel.deny_out || [])].map((x) =>
    String(x).toUpperCase(),
  );
  const allow = (channel.allow || []).map((x) => String(x).toUpperCase());
  const t = String(token || '').toUpperCase();
  if (!t) return 'unspecified';
  if (deny.includes(t)) return 'denied';
  if (allow.length) return allow.includes(t) ? 'allowed' : 'denied';
  return 'unspecified';
}

export function mapPolicyPreview(policy) {
  const channels = policy && typeof policy === 'object' ? policy.channels || {} : {};
  const mapChannel = (ch) => {
    const tokens = {};
    for (const cat of MAVLINK_DISPLAY_CATEGORIES) {
      tokens[cat] = policyTokenState(ch, cat);
    }
    return {
      implementation: ch?.implementation ?? null,
      endpoint: ch?.endpoint ?? null,
      mode: ch?.mode ?? null,
      notes: ch?.notes ?? null,
      tokens,
      applySupported: false,
    };
  };
  return {
    version: policy?.version ?? null,
    gcs_4g: mapChannel(channels.gcs_4g || null),
    rfd900x: mapChannel(channels.rfd900x || null),
    applySupported: false,
  };
}

export function mapFcMessageCategories(fc) {
  const src = fc && typeof fc === 'object' ? fc : {};
  const out = {};
  for (const cat of MAVLINK_DISPLAY_CATEGORIES) {
    const field = FC_CATEGORY_FIELDS[cat];
    if (!field) {
      out[cat] = { present: false, validity: null, state: 'DISABLED' };
      continue;
    }
    const msg = src[field] && typeof src[field] === 'object' ? src[field] : null;
    const validity = msg?.validity || null;
    out[cat] = {
      present: !!msg,
      validity,
      system_id: msg?.system_id ?? null,
      component_id: msg?.component_id ?? null,
      state:
        validity === 'valid'
          ? 'OK'
          : validity === 'stale'
            ? 'STALE'
            : validity === 'invalid'
              ? 'DISCONNECTED'
              : 'DISABLED',
    };
  }
  return out;
}

function jsonOrScalar(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return value;
}

export function flattenCompanionConfig(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const groups = [
    { group: 'JETSON / COMPANION', key: 'static', tier: CONFIG_TIER.READ_ONLY, editable: false },
    { group: 'SYSTEM', key: 'read_only', tier: CONFIG_TIER.READ_ONLY, editable: false },
    { group: 'SYSTEM', key: 'runtime', tier: CONFIG_TIER.RUNTIME, editable: false },
    { group: 'NAVIGATION / FLIGHT', key: 'flight_critical', tier: CONFIG_TIER.FLIGHT_CRITICAL, editable: false },
    { group: 'CAMERA', key: 'camera_extrinsics', tier: CONFIG_TIER.READ_ONLY, editable: false },
    { group: 'VISION', key: 'aruco', tier: CONFIG_TIER.READ_ONLY, editable: false },
    { group: 'VISION', key: 'vision', tier: CONFIG_TIER.RUNTIME, editable: false },
  ];
  const rows = [];
  for (const g of groups) {
    const block = src[g.key];
    if (block == null) {
      rows.push({
        group: g.group,
        key: g.key,
        value: null,
        tier: g.tier,
        editable: false,
      });
      continue;
    }
    if (typeof block !== 'object' || Array.isArray(block)) {
      rows.push({
        group: g.group,
        key: g.key,
        value: jsonOrScalar(block),
        tier: g.tier,
        editable: false,
      });
      continue;
    }
    const keys = Object.keys(block);
    if (!keys.length) {
      rows.push({
        group: g.group,
        key: g.key,
        value: null,
        tier: g.tier,
        editable: false,
      });
      continue;
    }
    for (const k of keys) {
      rows.push({
        group: g.group,
        key: `${g.key}.${k}`,
        value: jsonOrScalar(block[k]),
        tier: g.tier,
        editable: false,
      });
    }
  }
  return rows;
}

export const DIAGNOSTIC_KEYS = Object.freeze([
  'fc',
  'mavlink',
  'vision',
  'navigation',
  'landing',
  'video',
  'network',
  'policy',
  'config',
  'api',
  'system',
]);
