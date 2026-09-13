/**
 * AIRVIX Ask voice session lock (Roy 2026-09-13).
 *
 * voice_session_go — GO only opens the voice session.
 * After GO: LAND / RTL / return-home / mode changes apply with no per-action confirm.
 * Parameter changes always require confirmation (oral כן / אשר / מאשר is enough).
 * ARM / DISARM stay blocked. Never send. GO does not unlock them.
 *
 * Live EKF / nav-source switch, deploy, and restart stay blocked.
 */

import { PARAM_DENYLIST } from '../advisor-actions.mjs';

/** Roy lock 2026-09-13. GO opens the voice session; params always confirm. */
export const ASK_VOICE_SAFETY_LOCK = 'voice_session_go';

/** Confirm phrases accepted after a pending Ask param proposal (button remains primary). */
export const ASK_CONFIRM_PHRASES = Object.freeze(['מאשר', 'confirm', 'כן', 'אשר', 'yes']);

/** Cancel phrases for a pending Ask proposal. */
export const ASK_CANCEL_PHRASES = Object.freeze(['בטל', 'cancel']);

/** Spoken / typed session GO enable. Exact phrase after normalize. */
export const ASK_GO_ENABLE_PHRASES = Object.freeze(['go', 'יאללה', 'אשר go']);

/** Spoken / typed session GO end. Exact phrase after normalize. */
export const ASK_GO_DISABLE_PHRASES = Object.freeze(['end go', 'סיום go', 'בטל go']);

/**
 * Params that must never become an Ask apply path — denylist plus live
 * EKF / nav-source keys (Roy: no live GPS↔optical FC/EKF switch).
 */
export const ASK_BLOCKED_PARAM_KEYS = Object.freeze(new Set([
  ...PARAM_DENYLIST,
  'GPS_TYPE2',
  'AHRS_EKF_TYPE',
  'AHRS_GPS_USE',
]));

const ASK_BLOCKED_PARAM_PREFIXES = Object.freeze(['EK2_', 'EK3_', 'EKF_']);

/** Always blocked — never send, even after GO. */
export const ASK_BLOCKED_FLIGHT_KINDS = Object.freeze([
  'ARM',
  'DISARM',
  'NAV_SOURCE_SWITCH',
  'DEPLOY',
  'RESTART_SERVICE',
  'FC_COMMAND',
]);

/** Allowed after an open voice session (GO). No per-action confirm. */
export const ASK_SESSION_FLIGHT_OP_KINDS = Object.freeze([
  'LAND',
  'RTL',
  'MODE_CHANGE',
]);

function normalizeAskPhrase(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isAskConfirmPhrase(text) {
  const q = normalizeAskPhrase(text);
  if (!q) return false;
  return ASK_CONFIRM_PHRASES.some((p) => q === p.toLowerCase());
}

export function isAskCancelPhrase(text) {
  const q = normalizeAskPhrase(text);
  if (!q) return false;
  return ASK_CANCEL_PHRASES.some((p) => q === p.toLowerCase());
}

export function isAskGoEnablePhrase(text) {
  const q = normalizeAskPhrase(text);
  if (!q) return false;
  return ASK_GO_ENABLE_PHRASES.includes(q);
}

export function isAskGoDisablePhrase(text) {
  const q = normalizeAskPhrase(text);
  if (!q) return false;
  return ASK_GO_DISABLE_PHRASES.includes(q);
}

export function isAskBlockedParamKey(key) {
  const param = String(key || '').trim().toUpperCase();
  if (!param) return false;
  if (ASK_BLOCKED_PARAM_KEYS.has(param)) return true;
  return ASK_BLOCKED_PARAM_PREFIXES.some((prefix) => param.startsWith(prefix));
}

export function isAskFlightAffectingAction(action) {
  return action === 'PROPOSE_PARAM_CHANGE';
}

export function isAskSessionFlightOpKind(kind) {
  return ASK_SESSION_FLIGHT_OP_KINDS.includes(String(kind || '').toUpperCase());
}

/**
 * Parameter proposals always require confirmation (oral OK).
 * GO does not make params direct. Flight ops are not this function —
 * they run only after GO with no per-action confirm.
 */
export function askRequiresConfirmation(action, requested = true, _goActive = false) {
  if (isAskFlightAffectingAction(action)) return true;
  return requested === true;
}
