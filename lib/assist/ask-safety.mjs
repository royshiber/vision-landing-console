/**
 * AIRVIX Ask early-flight safety locks (Roy 2026-09-12).
 *
 * ask_voice_flight_confirm_always — Voice / Ask flight-affecting actions ALWAYS
 * require explicit Roy confirmation per action on early flights. Direct
 * voice-to-FC without per-action confirm is FORBIDDEN (future/gated).
 *
 * Still NEVER auto ARM / LAND / auto-land / live EKF/nav-source switch to FC.
 * Those stay blocked or Human-Gate-class: information or a non-executable
 * proposal only. Ask must NOT call FC command APIs for them.
 */

import { PARAM_DENYLIST } from '../advisor-actions.mjs';

/** Roy lock 2026-09-12. Do not set false. Direct voice-to-FC is forbidden. */
export const ASK_VOICE_FLIGHT_CONFIRM_ALWAYS = true; // ask_voice_flight_confirm_always

/** Confirm phrases accepted after a pending Ask proposal (button remains primary). */
export const ASK_CONFIRM_PHRASES = Object.freeze(['מאשר', 'confirm']);

/** Cancel phrases for a pending Ask proposal. */
export const ASK_CANCEL_PHRASES = Object.freeze(['בטל', 'cancel']);

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

export const ASK_BLOCKED_FLIGHT_KINDS = Object.freeze([
  'ARM',
  'DISARM',
  'LANDING_COMMAND',
  'MODE_CHANGE',
  'NAV_SOURCE_SWITCH',
  'DEPLOY',
  'RESTART_SERVICE',
  'FC_COMMAND',
]);

export function isAskConfirmPhrase(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return false;
  return ASK_CONFIRM_PHRASES.some((p) => q === p.toLowerCase());
}

export function isAskCancelPhrase(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return false;
  return ASK_CANCEL_PHRASES.some((p) => q === p.toLowerCase());
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

/**
 * Flight-affecting Ask proposals must always require confirm.
 * Roy lock ask_voice_flight_confirm_always — never honor requiresConfirmation=false.
 */
export function askRequiresConfirmation(action, requested = true) {
  if (!ASK_VOICE_FLIGHT_CONFIRM_ALWAYS) return requested === true;
  if (isAskFlightAffectingAction(action)) return true;
  return requested === true;
}
