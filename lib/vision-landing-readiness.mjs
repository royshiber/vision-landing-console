/**
 * Vision Landing Readiness — honest checklist for vision-only TO/L prep.
 * Display only. Never invent camera or GPS. No flight-command send.
 * No Companion-real safety widening.
 */

import { annotatedVideoAvailability } from './dual-link.mjs';
import { videoPipelineUiState } from './companion-display.mjs';

export const VISION_LANDING_READINESS_IDS = Object.freeze([
  'jetson_companion',
  'fc_heartbeat',
  'camera_vision',
  'plnd_profile',
  'annotated_video',
  'telemetry_recording',
  'flight_commands_gate',
]);

export const FLIGHT_COMMANDS_GATE = 'closed';
export const FLIGHT_COMMAND_TOKENS = Object.freeze(['ARM', 'LAND', 'auto-land']);
export const PLND_PROFILE_KEYS = Object.freeze(['PLND_ENABLED', 'PLND_TYPE']);
export const VISION_NAV_PROFILE_KEYS = Object.freeze([
  'vision_enable_alt_m',
  'vision_conf_min',
  'flare_alt_m',
]);

const GCS_HEARTBEAT_FRESH_MS = 3500;

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstBool(...values) {
  for (const v of values) {
    if (v === true || v === false) return v;
  }
  return null;
}

function hasAnyKey(dict, keys) {
  const o = obj(dict);
  if (!o) return false;
  return keys.some((k) => o[k] != null && o[k] !== '');
}

function pipelineName(video) {
  const v = obj(video) || {};
  const raw = v.raw_pipeline ?? v.rawPipeline ?? null;
  return raw == null ? null : String(raw);
}

/**
 * Camera / vision from real Companion fields only.
 * Missing fields stay unknown. Never invent ok or absent.
 */
export function resolveCameraVisionState({
  companionReachable = false,
  cameraOk = null,
  visionHealth = null,
  rawPipeline = null,
} = {}) {
  if (!companionReachable) return 'unknown';
  const ok = firstBool(cameraOk);
  if (ok === true) return 'ok';
  if (ok === false) return 'absent';
  const health = String(visionHealth || '').trim().toLowerCase();
  if (health === 'valid') return 'ok';
  if (health === 'unavailable') return 'absent';
  if (rawPipeline == null || rawPipeline === '') return 'unknown';
  const ui = videoPipelineUiState(rawPipeline);
  if (ui === 'available' || ui === 'degraded' || ui === 'starting') return 'ok';
  if (ui === 'unavailable' || ui === 'stopped') return 'absent';
  return 'unknown';
}

export function resolveJetsonCompanionState({ jetson = null, mode = null, reachable = null } = {}) {
  const j = String(jetson || '').toLowerCase();
  if (j === 'reachable' || j === 'mock' || j === 'unreachable' || j === 'off') return j;
  const m = String(mode || '').toLowerCase();
  if (m === 'mock') return 'mock';
  if (m === 'real' && reachable === true) return 'reachable';
  if (m === 'real' && reachable === false) return 'unreachable';
  return 'off';
}

/**
 * FC MAVLink / UART heartbeat. Companion UART and GCS MAVLink are both real.
 * No heartbeat is invented when neither path has reported one.
 */
export function resolveFcHeartbeatState({
  companionFc = null,
  companionHeartbeat = null,
  gcsHeartbeatFresh = null,
} = {}) {
  if (companionHeartbeat === true || gcsHeartbeatFresh === true) return 'heartbeat';
  const fc = String(companionFc || '').toLowerCase();
  if (fc === 'heartbeat') return 'heartbeat';
  if (fc === 'linked') return 'linked';
  if (fc === 'unlinked') return 'unlinked';
  if (gcsHeartbeatFresh === false) return 'unlinked';
  return 'unknown';
}

/**
 * PLND / vision-nav profile is present only from a live FC READ or a persisted store.
 * In-memory ArduPilot defaults alone are not a confirmed profile.
 */
export function resolvePlndProfileState({
  liveFcParams = null,
  persistedArduTarget = null,
  persistedVisionProfile = null,
} = {}) {
  const live = obj(liveFcParams);
  if (live && Object.keys(live).length > 0) {
    return hasAnyKey(live, PLND_PROFILE_KEYS) ? 'present' : 'missing';
  }
  if (hasAnyKey(persistedArduTarget, PLND_PROFILE_KEYS)) return 'present';
  if (hasAnyKey(persistedVisionProfile, VISION_NAV_PROFILE_KEYS)) return 'present';
  return 'missing';
}

/**
 * Manual record API wins. If that API does not exist, default not-recording.
 * Auto archive sessions are not treated as armed recording.
 */
export function resolveTelemetryRecordingState({ manualRecordApi = null } = {}) {
  const api = obj(manualRecordApi);
  if (api && typeof api.recording === 'boolean') {
    return api.recording ? 'recording' : 'not-recording';
  }
  return 'not-recording';
}

export function isGcsHeartbeatFresh(status, now = Date.now()) {
  const s = obj(status);
  if (!s) return false;
  if (s.connected !== true) return false;
  if (s.lastHeartbeatAgeMs != null) {
    const age = Number(s.lastHeartbeatAgeMs);
    return Number.isFinite(age) && age >= 0 && age < GCS_HEARTBEAT_FRESH_MS;
  }
  if (s.lastHeartbeatAt) {
    const at = Date.parse(s.lastHeartbeatAt);
    return Number.isFinite(at) && now - at < GCS_HEARTBEAT_FRESH_MS;
  }
  return false;
}

function row(id, state, nameHe, stateHe, missingHe, tone, extra = {}) {
  return {
    id,
    state,
    nameHe,
    stateHe,
    missingHe,
    tone,
    ...extra,
  };
}

function jetsonRow(state) {
  if (state === 'reachable') {
    return row('jetson_companion', state, 'מחשב משימה', 'מגיע', '', 'ok');
  }
  if (state === 'mock') {
    return row('jetson_companion', state, 'מחשב משימה', 'מדומה', '', 'ok');
  }
  if (state === 'unreachable') {
    return row('jetson_companion', state, 'מחשב משימה', 'לא מגיב', 'חסרה הגעה למחשב משימה', 'bad');
  }
  return row('jetson_companion', 'off', 'מחשב משימה', 'כבוי', 'חסרה הגעה למחשב משימה', 'off');
}

function fcRow(state) {
  if (state === 'heartbeat') {
    return row('fc_heartbeat', state, 'דופק בקר טיסה', 'דופק חי', '', 'ok');
  }
  if (state === 'linked') {
    return row('fc_heartbeat', state, 'דופק בקר טיסה', 'מקושר', 'אין דופק מקישור בקר', 'warn');
  }
  if (state === 'unlinked') {
    return row('fc_heartbeat', state, 'דופק בקר טיסה', 'מנותק', 'אין דופק מקישור בקר', 'bad');
  }
  return row('fc_heartbeat', 'unknown', 'דופק בקר טיסה', 'לא ידוע', 'אין דופק מקישור בקר', 'off');
}

function cameraRow(state) {
  if (state === 'ok') {
    return row('camera_vision', state, 'צינור ראייה', 'תקין', '', 'ok');
  }
  if (state === 'absent') {
    return row('camera_vision', state, 'צינור ראייה', 'חסר', 'אין דיווח מצלמה מהממשק', 'bad');
  }
  return row('camera_vision', 'unknown', 'צינור ראייה', 'לא ידוע', 'אין דיווח מצלמה מהממשק', 'off');
}

function plndRow(state) {
  if (state === 'present') {
    return row('plnd_profile', state, 'פרופיל נחיתה לפי ראייה', 'קיים', '', 'ok');
  }
  return row('plnd_profile', 'missing', 'פרופיל נחיתה לפי ראייה', 'חסר', 'אין פרופיל נחיתה לפי ראייה', 'bad');
}

function videoRow(video) {
  const v = obj(video) || annotatedVideoAvailability({});
  const reason = String(v.reason || '');
  if (v.available === true) {
    return row('annotated_video', 'available', 'נתיב וידאו מסומן', 'זמין', '', 'ok', {
      path: 'cellular',
      reason: 'cellular_connected',
    });
  }
  if (reason === 'modem_absent') {
    return row('annotated_video', 'modem_absent', 'נתיב וידאו מסומן', 'מודם חסר', 'מודם סלולר לא מחובר', 'warn', {
      path: 'cellular',
      reason: 'modem_absent',
    });
  }
  return row('annotated_video', 'cellular_disconnected', 'נתיב וידאו מסומן', 'סלולר מנותק', 'סלולר מנותק לנתיב המסומן', 'bad', {
    path: 'cellular',
    reason: reason || 'cellular_disconnected',
  });
}

function recordingRow(state) {
  if (state === 'recording') {
    return row('telemetry_recording', state, 'הקלטת טלמטריה', 'מקליט', '', 'ok');
  }
  return row('telemetry_recording', 'not-recording', 'הקלטת טלמטריה', 'לא מקליט', 'הקלטה לא חמושה', 'warn');
}

function flightGateRow() {
  return row(
    'flight_commands_gate',
    FLIGHT_COMMANDS_GATE,
    'שער פקודות טיסה',
    'סגור',
    'חימוש ונחיתה אוטומטית דורשים שער אנושי',
    'closed',
    {
      tokens: [...FLIGHT_COMMAND_TOKENS],
      issue: 29,
      send: false,
    },
  );
}

/**
 * Build the seven-row honesty matrix from already-observed snapshots.
 * Callers must pass real API / link fields. This function does not probe hardware.
 */
export function buildVisionLandingReadiness(input = {}) {
  const companion = obj(input.companion) || {};
  const overlay = obj(input.overlay) || {};
  const vision = obj(overlay.vision) || obj(companion.vision) || {};
  const videoOverlay = obj(overlay.video) || obj(companion.video) || {};

  const jetson = resolveJetsonCompanionState({
    jetson: companion.jetson,
    mode: companion.mode,
    reachable: companion.reachable,
  });
  const companionReachable = jetson === 'reachable' || jetson === 'mock';
  const fc = resolveFcHeartbeatState({
    companionFc: companion.fc,
    companionHeartbeat: firstBool(companion.fc_heartbeat, overlay.fc_heartbeat),
    gcsHeartbeatFresh: input.gcsHeartbeatFresh === true
      ? true
      : input.gcsHeartbeatFresh === false
        ? false
        : null,
  });
  const camera = resolveCameraVisionState({
    companionReachable,
    cameraOk: firstBool(vision.camera_ok, vision.cameraOk),
    visionHealth: vision.health,
    rawPipeline: pipelineName(videoOverlay),
  });
  const plnd = resolvePlndProfileState({
    liveFcParams: input.liveFcParams,
    persistedArduTarget: input.persistedArduTarget,
    persistedVisionProfile: input.persistedVisionProfile,
  });
  const video = obj(input.video) || annotatedVideoAvailability({
    cellular: input.cellular,
    modemPresent: input.modemPresent,
  });
  const recording = resolveTelemetryRecordingState({
    manualRecordApi: input.manualRecordApi,
  });

  const rows = [
    jetsonRow(jetson),
    fcRow(fc),
    cameraRow(camera),
    plndRow(plnd),
    videoRow(video),
    recordingRow(recording),
    flightGateRow(),
  ];

  return {
    ok: true,
    kind: 'vision_landing_readiness',
    rows,
    flightCommandsGate: FLIGHT_COMMANDS_GATE,
    flightCommandTokens: [...FLIGHT_COMMAND_TOKENS],
    invented: { camera: false, gps: false },
    sendFlightCommands: false,
  };
}
