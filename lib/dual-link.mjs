/**
 * Dual-link MAVLink model (radio + cellular).
 *
 * Locked product:
 * - Cellular is MAVLink over the cell path (not Companion-HTTP as the command path).
 * - Operator may run radio-only, cellular-only, or both.
 * - When both are connected, the operator picks the active command/telemetry link.
 * - Annotated vision video is always cellular from Jetson / מחשב משימה — never radio.
 */

export const LINK_ROLES = Object.freeze(['radio', 'cellular']);

export const LINK_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'listening',
  'connected',
  'error',
  'modem_absent',
]);

/** Annotated vision never rides the radio telemetry path. */
export const ANNOTATED_VIDEO_PATH = 'cellular';

export const ANNOTATED_VIDEO_REASONS = Object.freeze([
  'modem_absent',
  'cellular_disconnected',
  'stream_absent',
  'cellular_connected',
]);

export const ANNOTATED_VIDEO_REASON_HE = Object.freeze({
  modem_absent: 'אין שידור. מודם סלולר לא מחובר. ראייה מסומנת מגיעה רק ממחשב משימה.',
  cellular_disconnected: 'אין שידור. סלולר מנותק. ראייה מסומנת לא עוברת ברדיו.',
  stream_absent: 'אין שידור. אין זרם מסומן ממחשב משימה. ראייה מסומנת לא עוברת ברדיו.',
  cellular_connected: 'ראייה מסומנת זמינה דרך סלולר ממחשב משימה.',
});

/** Mission chrome only — Status / Connect keep the long honesty lines. */
export const ANNOTATED_VIDEO_REASON_HE_MISSION = Object.freeze({
  modem_absent: 'אין שידור. מודם לא מחובר.',
  cellular_disconnected: 'אין שידור. סלולר מנותק.',
  stream_absent: 'אין שידור. אין זרם מסומן.',
  cellular_connected: 'שידור סלולר ממחשב משימה.',
});

export const DEFAULT_CELLULAR_ENDPOINT = Object.freeze({
  type: 'udp',
  host: '0.0.0.0',
  port: 14560,
});

export function isLinkRole(value) {
  return value === 'radio' || value === 'cellular';
}

export function normalizeLinkRole(value, fallback = 'radio') {
  return isLinkRole(value) ? value : fallback;
}

export function normalizeLinkState(value) {
  return LINK_STATES.includes(value) ? value : 'disconnected';
}

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]';
}

export function liveStatusToLinkState(live, { role = 'radio', modemPresent = true } = {}) {
  if (role === 'cellular' && !modemPresent) return 'modem_absent';
  if (!live) return 'disconnected';
  if (live.connected) return 'connected';
  if (live.listening) return 'listening';
  if (live.lastError) return 'error';
  return 'disconnected';
}

/** Connect-panel chip. modem_absent is never painted as on/warn. */
export function chipStateFromLink(state) {
  const s = normalizeLinkState(state);
  if (s === 'connected') return 'on';
  if (s === 'listening' || s === 'connecting') return 'warn';
  if (s === 'modem_absent') return 'absent';
  return 'off';
}

/**
 * Choose which connected link is active for commands and flight telemetry.
 * Video is not part of this choice — it stays cellular-only.
 */
export function pickActiveLink({ radio, cellular, preferred } = {}) {
  const radioUp = normalizeLinkState(radio) === 'connected';
  const cellUp = normalizeLinkState(cellular) === 'connected';
  if (radioUp && cellUp) {
    return preferred === 'cellular' ? 'cellular' : 'radio';
  }
  if (radioUp) return 'radio';
  if (cellUp) return 'cellular';
  return null;
}

export function hebrewLinkState(state, { role = 'radio', modemPresent = true } = {}) {
  const s = normalizeLinkState(state);
  if (role === 'cellular' && !modemPresent && (s === 'disconnected' || s === 'modem_absent')) {
    return 'מודם לא מחובר';
  }
  if (s === 'connected') return 'מחובר';
  if (s === 'listening') return 'מאזין';
  if (s === 'connecting') return 'מתחבר';
  if (s === 'error') return 'שגיאה';
  if (s === 'modem_absent') return 'מודם לא מחובר';
  return 'מנותק';
}

export function hebrewLinkRole(role) {
  return role === 'cellular' ? 'סלולר' : 'רדיו טלמטריה';
}

export function hebrewLinkRoleShort(role) {
  return role === 'cellular' ? 'סלולר' : 'רדיו';
}

export function hebrewPillLabel({ radio, cellular, active, bothConnected } = {}) {
  if (bothConnected) {
    return active === 'cellular' ? 'שני קישורים · סלולר פעיל' : 'שני קישורים · רדיו פעיל';
  }
  if (normalizeLinkState(cellular) === 'connected') return 'מחובר · סלולר פעיל';
  if (normalizeLinkState(radio) === 'connected') return 'מחובר · רדיו פעיל';
  if (normalizeLinkState(radio) === 'listening') return 'מאזין';
  if (normalizeLinkState(cellular) === 'listening') return 'מאזין · סלולר';
  if (normalizeLinkState(radio) === 'connecting' || normalizeLinkState(cellular) === 'connecting') {
    return 'מתחבר';
  }
  return 'מנותק';
}

/**
 * Annotated vision video is cellular-only from Jetson.
 * Radio never satisfies this path. Cellular MAVLink up is not a video stream.
 * available:true only when an explicit annotated stream is present.
 */
export function annotatedVideoAvailability({
  cellular,
  modemPresent,
  streamPresent = false,
} = {}) {
  const cell = normalizeLinkState(cellular);
  const stream = streamPresent === true;
  const base = {
    available: false,
    path: ANNOTATED_VIDEO_PATH,
    neverRadio: true,
    radioSatisfies: false,
    streamPresent: false,
  };
  if (modemPresent === false || cell === 'modem_absent') {
    return {
      ...base,
      reason: 'modem_absent',
      reasonHe: ANNOTATED_VIDEO_REASON_HE.modem_absent,
    };
  }
  if (cell !== 'connected') {
    return {
      ...base,
      reason: 'cellular_disconnected',
      reasonHe: ANNOTATED_VIDEO_REASON_HE.cellular_disconnected,
    };
  }
  if (!stream) {
    return {
      ...base,
      reason: 'stream_absent',
      reasonHe: ANNOTATED_VIDEO_REASON_HE.stream_absent,
    };
  }
  return {
    ...base,
    available: true,
    streamPresent: true,
    reason: 'cellular_connected',
    reasonHe: ANNOTATED_VIDEO_REASON_HE.cellular_connected,
  };
}

export function summarizeDualLink({
  radio = 'disconnected',
  cellular = 'disconnected',
  preferred = 'radio',
  modemPresent = false,
  streamPresent = false,
} = {}) {
  const radioState = normalizeLinkState(radio);
  const cellularState = modemPresent
    ? normalizeLinkState(cellular)
    : 'modem_absent';
  const pref = normalizeLinkRole(preferred, 'radio');
  const active = pickActiveLink({ radio: radioState, cellular: cellularState, preferred: pref });
  const bothConnected = radioState === 'connected' && cellularState === 'connected';
  const video = annotatedVideoAvailability({
    cellular: cellularState,
    modemPresent,
    streamPresent,
  });
  return {
    radio: radioState,
    cellular: cellularState,
    preferred: pref,
    active,
    bothConnected,
    canSelectActive: bothConnected,
    modemPresent: !!modemPresent,
    video,
    radioLabelHe: hebrewLinkRole('radio'),
    cellularLabelHe: hebrewLinkRole('cellular'),
    radioShortHe: hebrewLinkRoleShort('radio'),
    cellularShortHe: hebrewLinkRoleShort('cellular'),
    radioStatusHe: hebrewLinkState(radioState, { role: 'radio' }),
    cellularStatusHe: hebrewLinkState(cellularState, { role: 'cellular', modemPresent }),
    pillLabelHe: hebrewPillLabel({
      radio: radioState,
      cellular: cellularState,
      active,
      bothConnected,
    }),
    activeLabelHe: active ? hebrewLinkRole(active) : 'אין קישור פעיל',
  };
}

/**
 * Cellular MAVLink connect gate.
 * Modem unplugged: only loopback endpoints may open a socket (software mock).
 * Remote hosts wait for a real modem — never Companion-HTTP.
 */
export function cellularConnectGate({ modemPresent, host } = {}) {
  if (modemPresent) return { allowed: true, mode: 'live' };
  if (isLoopbackHost(host)) return { allowed: true, mode: 'loopback_mock' };
  return {
    allowed: false,
    mode: 'modem_absent',
    state: 'modem_absent',
    messageHe: 'מודם לא מחובר. חברו מודם סלולר ואז נסו שוב.',
  };
}
