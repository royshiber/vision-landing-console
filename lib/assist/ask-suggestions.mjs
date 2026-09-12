/**
 * Lightweight AIRVIX Ask suggestions from live honesty signals only.
 * Quiet by default (attention policy off). One short Hebrew suggestion.
 * Never invents telemetry numbers. FC writes still go through confirm.
 *
 * Roy 2026-09-12: opt-in or attention/critical, or when the operator raised a problem.
 */

import { getAssistRouteById } from './assist-routes.mjs';

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function pickSignals(context) {
  const ac = context?.aircraft_state || {};
  const ops = context?.ops_signals || {};
  return {
    connected: boolOrNull(ac.connected),
    altitude_m: typeof ac.altitude_m === 'number' && Number.isFinite(ac.altitude_m) ? ac.altitude_m : null,
    camera_ok: boolOrNull(ops.camera_ok),
    recording_on: boolOrNull(ops.recording_on),
    optical_missing: boolOrNull(ops.optical_missing),
  };
}

function navPayload(routeId) {
  const route = getAssistRouteById(routeId);
  if (!route) return null;
  return {
    route_id: route.id,
    tab: route.tab,
    subtab: route.subtab || null,
    workspace: route.workspace,
    capability: route.capability,
  };
}

/**
 * @param {object} context
 * @param {{ policyLevel?: string, problemRaised?: boolean }} [opts]
 * @returns {object|null}
 */
export function suggestAskFromContext(context, { policyLevel = 'off', problemRaised = false } = {}) {
  const level = String(policyLevel || 'off').trim();
  const allowed = problemRaised === true || level === 'attention' || level === 'critical';
  if (!allowed) return null;

  const s = pickSignals(context);
  if (s.connected === false) {
    const payload = navPayload('companion');
    if (!payload) return null;
    return {
      id: 'ask-suggest-disconnect',
      text_he: 'המטוס אינו מחובר. לפתוח סטטוס מחשבים?',
      action: 'UI_NAVIGATION',
      payload,
      requires_confirmation: true,
      writes_fc: false,
    };
  }
  if (s.connected === true && s.altitude_m == null) {
    const payload = navPayload('diagnostics');
    if (!payload) return null;
    return {
      id: 'ask-suggest-missing-alt',
      text_he: 'אין גובה מהבקר. לפתוח טלמטריה?',
      action: 'UI_NAVIGATION',
      payload,
      requires_confirmation: true,
      writes_fc: false,
    };
  }
  if (s.camera_ok === false) {
    const payload = navPayload('companion');
    if (!payload) return null;
    return {
      id: 'ask-suggest-camera-absent',
      text_he: 'מצלמה לא מדווחת. לפתוח סטטוס מחשבים?',
      action: 'UI_NAVIGATION',
      payload,
      requires_confirmation: true,
      writes_fc: false,
    };
  }
  if (s.recording_on === false) {
    const payload = navPayload('debrief');
    if (!payload) return null;
    return {
      id: 'ask-suggest-recording-off',
      text_he: 'הקלטה כבויה. לפתוח תחקור?',
      action: 'UI_NAVIGATION',
      payload,
      requires_confirmation: true,
      writes_fc: false,
    };
  }
  if (s.optical_missing === true) {
    const payload = navPayload('vision');
    if (!payload) return null;
    return {
      id: 'ask-suggest-optical-missing',
      text_he: 'ניווט אופטי ללא נעילה. לפתוח ראייה?',
      action: 'UI_NAVIGATION',
      payload,
      requires_confirmation: true,
      writes_fc: false,
    };
  }
  return null;
}
