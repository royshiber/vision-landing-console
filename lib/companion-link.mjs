/**
 * Jetson ↔ FC connect status for the topbar.
 * Health fields fc_linked / fc_heartbeat are first-class.
 * Radio MAVLink down must not hide a live Companion UART heartbeat.
 * Read-only. No flight commands. No Companion apply/restart.
 */

export const JETSON_LINK_STATES = Object.freeze(['off', 'unreachable', 'reachable', 'mock']);
export const FC_LINK_STATES = Object.freeze(['unknown', 'unlinked', 'linked', 'heartbeat']);

export function firstBool(...values) {
  for (const v of values) {
    if (v === true || v === false) return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
  }
  return null;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Prefer Companion GET /api/health (or /api/v1/health) wire fields.
 * Fall back to mapped status / overlay FC + MAVLink bits.
 */
export function mapHealthFields(health, overlay) {
  const h = obj(health) || {};
  const o = obj(overlay) || {};
  const fc = obj(o.fc) || {};
  const mav = obj(o.mavlink) || {};
  const fc_heartbeat = firstBool(
    h.fc_heartbeat,
    h.fcHeartbeat,
    h.heartbeat,
    fc.heartbeat,
    mav.heartbeat_ok,
  );
  const fc_linked = firstBool(
    h.fc_linked,
    h.fcLinked,
    h.linked,
    fc.connected,
    mav.connected,
    fc_heartbeat === true ? true : null,
  );
  return { fc_linked, fc_heartbeat };
}

export function jetsonLinkState({ mode, reachable } = {}) {
  const m = String(mode || 'off').toLowerCase();
  if (m === 'mock') return 'mock';
  if (m === 'real' && reachable === true) return 'reachable';
  if (m === 'real' && reachable === false) return 'unreachable';
  return 'off';
}

export function fcLinkState({ jetson, fc_linked, fc_heartbeat } = {}) {
  if (jetson === 'off' || jetson === 'unreachable') return 'unknown';
  if (fc_heartbeat === true) return 'heartbeat';
  if (fc_linked === true) return 'linked';
  if (fc_linked === false || fc_heartbeat === false) return 'unlinked';
  return 'unknown';
}

export function finiteCompanionMetric(...values) {
  for (const v of values) {
    if (v == null || v === '') continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Live data path: heartbeat, or at least one real numeric / FC validity field.
 * A stored real session or an empty health 200 is not a data path.
 */
export function companionHasDataPath({ health = null, overlay = null, system = null } = {}) {
  const fields = mapHealthFields(health, overlay);
  if (fields.fc_heartbeat === true) return true;
  const sys = obj(system) || obj(overlay?.system) || {};
  if (finiteCompanionMetric(
    sys.cpu_percent,
    sys.cpuLoadPct,
    sys.temperature_c,
    sys.tempC,
    sys.memPct,
    sys.ram_used_mb,
    sys.gpu_percent,
  ) != null) {
    return true;
  }
  const fc = obj(overlay?.fc) || {};
  if (fc.heartbeat === true || fc.heartbeat_validity === 'valid') return true;
  if (finiteCompanionMetric(fc.loadPct, fc.memPct, fc.tempC, fc.load_pct) != null) return true;
  const mav = obj(overlay?.mavlink) || {};
  if (mav.heartbeat_ok === true) return true;
  return false;
}

export function hebrewJetsonState(state, { hasData = true } = {}) {
  if (state === 'unreachable') return 'לא מגיב';
  if (state === 'reachable') return hasData ? 'מחובר' : 'מחובר · אין נתונים';
  if (state === 'mock') return hasData ? 'מדומה' : 'מחובר · אין נתונים';
  return 'מנותק';
}

export function hebrewFcState(state, { hasData = true } = {}) {
  if (state === 'heartbeat') return hasData ? 'דופק חי' : 'מחובר · אין נתונים';
  if (state === 'linked') return hasData ? 'מקושר' : 'מחובר · אין נתונים';
  if (state === 'unlinked') return 'מנותק';
  return 'מנותק';
}

export function chipStateFromCompanion(kind, state, { hasData = true } = {}) {
  if (kind === 'jetson') {
    if (state === 'reachable' || state === 'mock') return hasData ? 'on' : 'warn';
    if (state === 'unreachable') return 'warn';
    return 'off';
  }
  if (state === 'heartbeat') return hasData ? 'on' : 'warn';
  if (state === 'linked') return 'warn';
  return 'off';
}

export function hebrewCompanionPill({ jetson, fc, hasData = true } = {}) {
  if (jetson === 'unreachable') return 'מחשב משימה לא מגיב';
  if ((jetson === 'reachable' || jetson === 'mock') && hasData === false) {
    return 'מחובר · אין נתונים';
  }
  if (fc === 'heartbeat') return 'מחובר · בקר טיסה';
  if (jetson === 'reachable' || jetson === 'mock') {
    if (fc === 'linked') return 'מחובר · מחשב משימה';
    return 'מחובר · מחשב משימה';
  }
  return null;
}

function dualFeelsConnected(dual) {
  const radio = dual?.radio;
  const cellular = dual?.cellular;
  return radio === 'connected' || cellular === 'connected';
}

function dualFeelsWaiting(dual) {
  const radio = dual?.radio;
  const cellular = dual?.cellular;
  return radio === 'listening' || cellular === 'listening'
    || radio === 'connecting' || cellular === 'connecting';
}

/**
 * Composite pill: Companion/FC heartbeat is a live link even when radio MAVLink is down.
 * Dual-link radio/cellular labels win only when those sockets are actually up.
 */
export function composeConnectPill({ dual = null, companion = null } = {}) {
  if (dualFeelsConnected(dual) && dual?.pillLabelHe) {
    return { pillLabelHe: dual.pillLabelHe, pillDot: 'on' };
  }
  const companionPill = hebrewCompanionPill(companion || {});
  if (companion?.hasData === false && (companion?.jetson === 'reachable' || companion?.jetson === 'mock')) {
    return { pillLabelHe: 'מחובר · אין נתונים', pillDot: 'warn' };
  }
  if (companion?.jetson === 'reachable' || companion?.jetson === 'mock') {
    return {
      pillLabelHe: 'מחובר · רשת בית',
      pillDot: companion?.fc === 'heartbeat' ? 'on' : 'warn',
    };
  }
  if (dualFeelsWaiting(dual) && dual?.pillLabelHe) {
    return { pillLabelHe: dual.pillLabelHe, pillDot: 'connecting' };
  }
  if (companion?.jetson === 'unreachable') {
    return { pillLabelHe: companionPill, pillDot: 'err' };
  }
  if (dual?.pillLabelHe) {
    return { pillLabelHe: dual.pillLabelHe, pillDot: 'off' };
  }
  return { pillLabelHe: 'מנותק', pillDot: 'off' };
}

export function summarizeCompanionLink({
  mode = 'off',
  reachable = false,
  health = null,
  overlay = null,
  defaultConfigured = false,
  urlConfigured = false,
  tokenConfigured = false,
} = {}) {
  const jetson = jetsonLinkState({ mode, reachable });
  const fields = mapHealthFields(health, overlay);
  const fc = fcLinkState({
    jetson,
    fc_linked: fields.fc_linked,
    fc_heartbeat: fields.fc_heartbeat,
  });
  const hasData = jetson === 'off' || jetson === 'unreachable'
    ? false
    : companionHasDataPath({ health, overlay });
  const connected = jetson === 'reachable' || jetson === 'mock';
  const mock = mode === 'mock';
  const widgetPill = composeConnectPill({ companion: { jetson, fc, hasData } });
  const companionPill = hebrewCompanionPill({ jetson, fc, hasData });
  const needToken = !mock && !connected && !!urlConfigured && !tokenConfigured;
  return {
    mode: mode || 'off',
    reachable: jetson === 'reachable' || jetson === 'mock',
    hasData,
    jetson,
    jetsonLabelHe: 'מחשב משימה',
    jetsonStatusHe: hebrewJetsonState(jetson, { hasData }),
    jetsonChip: chipStateFromCompanion('jetson', jetson, { hasData }),
    fc,
    fcLabelHe: 'בקר טיסה',
    fcStatusHe: hebrewFcState(fc, { hasData: hasData || fc === 'heartbeat' }),
    fcChip: chipStateFromCompanion('fc', fc, { hasData: hasData || fc === 'heartbeat' }),
    fc_linked: fields.fc_linked,
    fc_heartbeat: fields.fc_heartbeat,
    connected,
    connectAvailable: !connected,
    disconnectAvailable: jetson === 'reachable',
    defaultConfigured: !!defaultConfigured,
    needAdvanced: !mock && !defaultConfigured && !connected,
    needToken,
    focusField: needToken ? 'token' : null,
    pillLabelHe: companionPill || widgetPill.pillLabelHe,
    pillDot: widgetPill.pillDot,
    hint_he: mock
      ? 'חיבור מדומה למחשב משימה.'
      : jetson === 'unreachable'
        ? 'מחשב משימה לא מגיב.'
        : connected && !hasData
          ? 'מחשב משימה מגיב. אין נתונים.'
          : connected
            ? (fc === 'heartbeat' ? 'מחשב משימה מחובר. בקר טיסה עם דופק.' : 'מחשב משימה מחובר.')
            : defaultConfigured
              ? 'חיבור אוטומטי למחשב המשימה.'
              : needToken
                ? 'חסר אסימון. הזינו אותו במתקדם.'
                : 'חברו מחשב משימה בלחיצה.',
  };
}
