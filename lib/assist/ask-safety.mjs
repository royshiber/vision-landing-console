/**
 * AIRVIX Ask early-flight safety locks (Roy 2026-09-12).
 *
 * voice_direct_after_go — supersedes ask_voice_flight_confirm_always (#122).
 * After an explicit operator GO (session enable), safe param propose/apply
 * via the engineer path may run without per-action confirm.
 * Until GO: confirm-required (button / מאשר) so the operator can still act.
 *
 * Still NEVER auto ARM / DISARM / LAND / RTL / auto-land / live EKF/nav-source
 * switch / deploy / restart. Those stay blocked with Hebrew Human-Gate copy.
 * GO does not unlock them. Ask must NOT call FC command APIs for them.
 */

import { PARAM_DENYLIST } from '../advisor-actions.mjs';

/** Roy lock 2026-09-12. Do not revert to always-confirm without a new Human Decision. */
export const ASK_VOICE_SAFETY_LOCK = 'voice_direct_after_go';

/** Confirm phrases accepted after a pending Ask proposal (button remains primary). */
export const ASK_CONFIRM_PHRASES = Object.freeze(['מאשר', 'confirm']);

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

/**
 * Flight-affecting Ask proposals: confirm-required until session GO.
 * After GO, safe param apply is direct (engineer path). GO never unlocks
 * ARM / LAND / nav-switch — those are blocked before this function runs.
 */
export function askRequiresConfirmation(action, requested = true, goActive = false) {
  if (isAskFlightAffectingAction(action)) return goActive !== true;
  return requested === true;
}
