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

export function hebrewJetsonState(state) {
  if (state === 'reachable') return 'מחובר';
  if (state === 'mock') return 'מדומה';
  if (state === 'unreachable') return 'לא מגיב';
  return 'מנותק';
}

export function hebrewFcState(state) {
  if (state === 'heartbeat') return 'דופק חי';
  if (state === 'linked') return 'מקושר';
  if (state === 'unlinked') return 'מנותק';
  return 'מנותק';
}

export function chipStateFromCompanion(kind, state) {
  if (kind === 'jetson') {
    if (state === 'reachable' || state === 'mock') return 'on';
    if (state === 'unreachable') return 'warn';
    return 'off';
  }
  if (state === 'heartbeat') return 'on';
  if (state === 'linked') return 'warn';
  return 'off';
}

export function hebrewCompanionPill({ jetson, fc } = {}) {
  if (fc === 'heartbeat') return 'מחובר · בקר טיסה';
  if (jetson === 'reachable' || jetson === 'mock') {
    if (fc === 'linked') return 'מחובר · מחשב משימה';
    return 'מחובר · מחשב משימה';
  }
  if (jetson === 'unreachable') return 'מחשב משימה לא מגיב';
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
  if (companion?.fc === 'heartbeat') {
    return { pillLabelHe: companionPill, pillDot: 'on' };
  }
  if (companion?.jetson === 'reachable' || companion?.jetson === 'mock') {
    return { pillLabelHe: companionPill, pillDot: companion?.fc === 'linked' ? 'warn' : 'warn' };
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
} = {}) {
  const jetson = jetsonLinkState({ mode, reachable });
  const fields = mapHealthFields(health, overlay);
  const fc = fcLinkState({
    jetson,
    fc_linked: fields.fc_linked,
    fc_heartbeat: fields.fc_heartbeat,
  });
  const connected = jetson === 'reachable' || jetson === 'mock';
  const mock = mode === 'mock';
  const pill = composeConnectPill({ companion: { jetson, fc } });
  return {
    mode: mode || 'off',
    reachable: jetson === 'reachable' || jetson === 'mock',
    jetson,
    jetsonLabelHe: 'מחשב משימה',
    jetsonStatusHe: hebrewJetsonState(jetson),
    fc,
    fcLabelHe: 'בקר טיסה',
    fcStatusHe: hebrewFcState(fc),
    fc_linked: fields.fc_linked,
    fc_heartbeat: fields.fc_heartbeat,
    connected,
    connectAvailable: !connected,
    disconnectAvailable: jetson === 'reachable',
    defaultConfigured: !!defaultConfigured,
    needAdvanced: !mock && !defaultConfigured && !connected,
    pillLabelHe: pill.pillLabelHe,
    pillDot: pill.pillDot,
    hint_he: mock
      ? 'חיבור מדומה למחשב משימה.'
      : connected
        ? (fc === 'heartbeat' ? 'מחשב משימה מחובר. בקר טיסה עם דופק.' : 'מחשב משימה מחובר.')
        : defaultConfigured
          ? 'חיבור אוטומטי למחשב המשימה.'
          : 'חברו מחשב משימה בלחיצה.',
  };
}
