/**
 * Vision Landing Readiness — Experiment 1: fixed-wing final, observe-only.
 * Mandatory success is runway detection on final only.
 * Annotations are not required. Runway-lock to GCS is observe-only and not required.
 * PIC hand-flies to final. Display only. Never invent camera, GPS, or lock.
 * No flight-command send. No Companion-real safety widening.
 */

import { probeCameraVision, probeRunwayDetect, probeRunwayLock } from './vision-companion-probe.mjs';
import { annotatedVideoAvailability } from './dual-link.mjs';

export const VISION_LANDING_READINESS_IDS = Object.freeze([
  'jetson_companion',
  'fc_heartbeat',
  'camera_vision',
  'runway_detect',
  'runway_lock',
  'plnd_profile',
  'annotated_video',
  'telemetry_recording',
  'flight_commands_gate',
]);

export const RUNWAY_DETECT_STATES = Object.freeze([
  'unknown',
  'not_detected',
  'detected',
  'not_implemented',
  'absent',
]);

export const RUNWAY_LOCK_STATES = Object.freeze([
  'unknown',
  'not',
  'detecting',
  'locked',
]);

export const RUNWAY_LOCK_STATE_HE = Object.freeze({
  unknown: 'לא ידוע',
  not: 'אין נעילה',
  detecting: 'מזהה',
  locked: 'נעול',
});

export const EXPERIMENT_PURPOSE_HE = 'ניסוי כנף קבועה. טייס מפקד מטיס ידנית עד הגמר. המערכת צופה בלבד.';
export const EXPERIMENT_SUCCESS_HE = 'הצלחה היא זיהוי מסלול בגישת הגמר בלבד. סימון ונעילה אינם נדרשים.';

export const FLIGHT_COMMANDS_GATE = 'closed';
export const FLIGHT_COMMAND_TOKENS = Object.freeze(['ARM', 'LAND', 'auto-land']);
export const PLND_PROFILE_KEYS = Object.freeze(['PLND_ENABLED', 'PLND_TYPE']);
export const VISION_NAV_PROFILE_KEYS = Object.freeze([
  'vision_enable_alt_m',
  'vision_conf_min',
  'flare_alt_m',
]);
export const PLND_PROFILE_ALL_KEYS = Object.freeze([
  ...PLND_PROFILE_KEYS,
  ...VISION_NAV_PROFILE_KEYS,
]);

export const PLND_PROFILE_KEY_LABELS_HE = Object.freeze({
  PLND_ENABLED: 'נחיתה מדויקת פעילה',
  PLND_TYPE: 'סוג נחיתה מדויקת',
  vision_enable_alt_m: 'גובה הפעלת ראייה',
  vision_conf_min: 'סף ביטחון ראייה',
  flare_alt_m: 'גובה הצפה',
});

export const PLND_PROFILE_SOURCE_HE = Object.freeze({
  fc: 'בקר טיסה',
  companion: 'מחשב משימה',
  persisted: 'שמור בקונסולה',
});

export const PLND_PROFILE_STATE_HE = Object.freeze({
  present: 'קיים',
  missing: 'חסר',
  unknown: 'לא ידוע',
});

export const PLND_PROFILE_HREF = Object.freeze({
  tab: 'control',
  subtab: 'visionNavParams',
});

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

function sourceLooked(dict) {
  const o = obj(dict);
  return Boolean(o && Object.keys(o).length > 0);
}

function observedValue(dict, key) {
  const o = obj(dict);
  if (!o || !Object.prototype.hasOwnProperty.call(o, key)) return undefined;
  const value = o[key];
  if (value == null || value === '') return undefined;
  return value;
}

function pipelineName(video) {
  const v = obj(video) || {};
  const raw = v.raw_pipeline ?? v.rawPipeline ?? null;
  return raw == null ? null : String(raw);
}

/**
 * Camera / vision from reported Companion camera_ok only.
 * Health, fps, and raw pipeline are observed but never invent ok/absent.
 */
export function resolveCameraVisionState({
  companionReachable = false,
  cameraOk = null,
  visionHealth = null,
  rawPipeline = null,
  extras = null,
} = {}) {
  const probe = probeCameraVision({
    companion: { jetson: companionReachable ? 'reachable' : 'off' },
    vision: {
      camera_ok: cameraOk,
      health: visionHealth,
    },
    video: rawPipeline == null ? null : { raw_pipeline: rawPipeline },
    extras,
  });
  return probe.state;
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

function plndKeyRow(key, state, value, source) {
  return {
    key,
    nameHe: PLND_PROFILE_KEY_LABELS_HE[key] || key,
    state,
    stateHe: PLND_PROFILE_STATE_HE[state] || PLND_PROFILE_STATE_HE.unknown,
    value: state === 'present' ? value : null,
    source: state === 'present' ? source : null,
    sourceHe: state === 'present' ? (PLND_PROFILE_SOURCE_HE[source] || '') : '',
  };
}

/**
 * Honest PLND / vision-nav profile from real FC, Companion, or a persisted store.
 * No source → unknown. A looked source without the key → missing.
 * In-memory ArduPilot defaults alone are not a confirmed profile. Never invent values.
 */
export function buildPlndProfileHonesty({
  liveFcParams = null,
  companionParams = null,
  persistedArduTarget = null,
  persistedVisionProfile = null,
} = {}) {
  const fcLive = sourceLooked(liveFcParams);
  const companionLive = sourceLooked(companionParams);
  const arduPersisted = sourceLooked(persistedArduTarget);
  const visionPersisted = sourceLooked(persistedVisionProfile);
  const anySource = fcLive || companionLive || arduPersisted || visionPersisted;

  const keys = PLND_PROFILE_ALL_KEYS.map((key) => {
    const fcVal = observedValue(liveFcParams, key);
    if (fcVal !== undefined) return plndKeyRow(key, 'present', fcVal, 'fc');
    const companionVal = observedValue(companionParams, key);
    if (companionVal !== undefined) return plndKeyRow(key, 'present', companionVal, 'companion');
    const persistedVal = observedValue(persistedArduTarget, key) ?? observedValue(persistedVisionProfile, key);
    if (persistedVal !== undefined) return plndKeyRow(key, 'present', persistedVal, 'persisted');
    const fcFamily = PLND_PROFILE_KEYS.includes(key);
    if (fcFamily) {
      if (fcLive || arduPersisted) return plndKeyRow(key, 'missing', null, null);
      if (companionLive && PLND_PROFILE_KEYS.some((k) => observedValue(companionParams, k) !== undefined)) {
        return plndKeyRow(key, 'missing', null, null);
      }
      return plndKeyRow(key, 'unknown', null, null);
    }
    if (companionLive || visionPersisted) return plndKeyRow(key, 'missing', null, null);
    return plndKeyRow(key, 'unknown', null, null);
  });

  const presentCount = keys.filter((k) => k.state === 'present').length;
  let state = 'unknown';
  if (presentCount > 0) state = 'present';
  else if (anySource) state = 'missing';

  return {
    state,
    keys,
    anySource,
    invented: false,
  };
}

/**
 * PLND / vision-nav profile is present only from a live FC READ, Companion, or a persisted store.
 * No source is unknown — never invent present or a numeric value.
 */
export function resolvePlndProfileState(input = {}) {
  return buildPlndProfileHonesty(input).state;
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

/**
 * Experiment 1 success: runway detection on final.
 * Aruco / marker landing-target is not a runway detect.
 * Lock tokens are ignored here. Missing detect API stays unknown.
 */
export function resolveRunwayDetectState({
  companionReachable = false,
  landing = null,
  vision = null,
  extras = null,
  visionResult = null,
  landingPathAbsent = false,
} = {}) {
  const probe = probeRunwayDetect({
    companion: { jetson: companionReachable ? 'reachable' : 'off' },
    landing,
    vision,
    extras,
    visionResult,
    landingPathAbsent,
  });
  return probe.state;
}

/**
 * Observe-only GCS lock. Experiment 1 does not use this as a blocker.
 * Explicit Companion/vision lock fields only. Detect + confidence never invents locked.
 * Missing lock signal stays unknown — not later, not fake detecting.
 */
export function resolveRunwayLockState({
  companionReachable = false,
  landing = null,
  vision = null,
  extras = null,
} = {}) {
  return probeRunwayLock({
    companion: { jetson: companionReachable ? 'reachable' : 'off' },
    landing,
    vision,
    extras,
  }).state;
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
  const stage = extra.stage || 'experiment_1';
  const requiredForExperiment1 = extra.requiredForExperiment1 ?? stage !== 'later';
  return {
    id,
    state,
    nameHe,
    stateHe,
    missingHe,
    tone,
    ...extra,
    requiredForExperiment1,
    stage,
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

function runwayDetectRow(state) {
  if (state === 'detected') {
    return row('runway_detect', state, 'זיהוי מסלול בגמר', 'מזוהה', '', 'ok', {
      successCriterion: true,
    });
  }
  if (state === 'not_detected') {
    return row('runway_detect', state, 'זיהוי מסלול בגמר', 'לא מזוהה', 'אין זיהוי מסלול בגישת הגמר', 'warn', {
      successCriterion: true,
    });
  }
  if (state === 'absent') {
    return row('runway_detect', state, 'זיהוי מסלול בגמר', 'חסר', 'גלאי מסלול כבוי במחשב משימה', 'bad', {
      successCriterion: true,
    });
  }
  if (state === 'not_implemented') {
    return row('runway_detect', state, 'זיהוי מסלול בגמר', 'אין גלאי', 'אין גלאי מסלול במחשב משימה. לא הומצא זיהוי.', 'bad', {
      successCriterion: true,
    });
  }
  return row('runway_detect', 'unknown', 'זיהוי מסלול בגמר', 'לא ידוע', 'אין דיווח זיהוי מסלול מהממשק', 'off', {
    successCriterion: true,
  });
}

function runwayLockRow(probe) {
  const snapshot = probe && typeof probe === 'object'
    ? probe
    : { state: 'unknown', source: null, fieldsUsed: [] };
  const state = RUNWAY_LOCK_STATES.includes(snapshot.state) ? snapshot.state : 'unknown';
  const extra = {
    stage: 'later',
    requiredForExperiment1: false,
    observeOnly: true,
    source: snapshot.source || null,
    fieldsUsed: Array.isArray(snapshot.fieldsUsed) ? snapshot.fieldsUsed : [],
  };
  if (state === 'locked') {
    return row(
      'runway_lock',
      'locked',
      'נעילת מסלול לתחנת הקרקע',
      RUNWAY_LOCK_STATE_HE.locked,
      'נעילה מדווחת. לצפייה בלבד. לא חוסם את הניסוי.',
      'ok',
      extra,
    );
  }
  if (state === 'detecting') {
    return row(
      'runway_lock',
      'detecting',
      'נעילת מסלול לתחנת הקרקע',
      RUNWAY_LOCK_STATE_HE.detecting,
      'נעילה בתהליך. לצפייה בלבד. לא חוסם את הניסוי.',
      'warn',
      extra,
    );
  }
  if (state === 'not') {
    return row(
      'runway_lock',
      'not',
      'נעילת מסלול לתחנת הקרקע',
      RUNWAY_LOCK_STATE_HE.not,
      'אין נעילה. לצפייה בלבד. לא חוסם את הניסוי.',
      'later',
      extra,
    );
  }
  return row(
    'runway_lock',
    'unknown',
    'נעילת מסלול לתחנת הקרקע',
    RUNWAY_LOCK_STATE_HE.unknown,
    'אין דיווח נעילה מהממשק. לא חוסם את הניסוי.',
    'later',
    extra,
  );
}

function plndRow(honesty) {
  const snapshot = typeof honesty === 'string'
    ? { state: honesty, keys: [] }
    : (honesty || { state: 'unknown', keys: [] });
  const keys = Array.isArray(snapshot.keys) ? snapshot.keys : [];
  const extra = {
    stage: 'later',
    requiredForExperiment1: false,
    keys,
    href: { ...PLND_PROFILE_HREF },
    invented: false,
  };
  if (snapshot.state === 'present') {
    const incomplete = keys.some((k) => k.state !== 'present');
    return row(
      'plnd_profile',
      'present',
      'פרופיל נחיתה לפי ראייה',
      'קיים',
      incomplete ? 'חסרים מפתחות בפרופיל. לא חוסם את הניסוי.' : '',
      incomplete ? 'warn' : 'ok',
      extra,
    );
  }
  if (snapshot.state === 'unknown') {
    return row(
      'plnd_profile',
      'unknown',
      'פרופיל נחיתה לפי ראייה',
      'לא ידוע',
      'אין קריאה מבקר או ממחשב משימה. לא חוסם את הניסוי.',
      'later',
      extra,
    );
  }
  return row(
    'plnd_profile',
    'missing',
    'פרופיל נחיתה לפי ראייה',
    'חסר',
    'אין פרופיל נחיתה לפי ראייה. לא חוסם את הניסוי.',
    'later',
    extra,
  );
}

/**
 * Annotated vision is later for Experiment 1, but the cellular gate stays honest.
 * No modem → modem_absent. Never invent available / link-up.
 */
export function resolveAnnotatedVideoHonesty({
  video = null,
  cellular = null,
  modemPresent = false,
} = {}) {
  const present = modemPresent === true;
  if (!present) {
    return annotatedVideoAvailability({ cellular: 'modem_absent', modemPresent: false });
  }
  const overlay = obj(video);
  const cell = cellular
    || overlay?.cellular
    || (overlay?.available === true ? 'connected' : 'disconnected');
  return annotatedVideoAvailability({
    cellular: cell,
    modemPresent: true,
  });
}

function videoRow({ video, cellular, modemPresent } = {}) {
  const gate = resolveAnnotatedVideoHonesty({ video, cellular, modemPresent });
  const note = gate.reason === 'modem_absent'
    ? 'סימון על הווידאו אינו נדרש להצלחת הניסוי. מודם סלולר לא מחובר. אין שידור.'
    : gate.available
      ? 'סימון על הווידאו אינו נדרש להצלחת הניסוי.'
      : `סימון על הווידאו אינו נדרש להצלחת הניסוי. ${gate.reasonHe}`;
  return row(
    'annotated_video',
    'later',
    'סימון על הווידאו',
    'לא נדרש',
    note,
    'later',
    {
      stage: 'later',
      requiredForExperiment1: false,
      path: gate.path,
      available: gate.available,
      reason: gate.reason,
      reasonHe: gate.reasonHe,
      modemPresent: modemPresent === true,
    },
  );
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
    'אין שליטה מהרשימה. טייס מפקד מטיס ידנית עד הגמר.',
    'closed',
    {
      tokens: [...FLIGHT_COMMAND_TOKENS],
      issue: 29,
      send: false,
      observeOnly: true,
    },
  );
}

/**
 * Build the Experiment 1 honesty matrix from already-observed snapshots.
 * Callers must pass real API / link fields. This function does not probe hardware.
 */
export function buildVisionLandingReadiness(input = {}) {
  const companion = obj(input.companion) || {};
  const overlay = obj(input.overlay) || {};
  const vision = obj(overlay.vision) || obj(companion.vision) || {};
  const videoOverlay = obj(overlay.video) || obj(companion.video) || obj(input.video) || {};
  const landing = obj(overlay.landing) || obj(companion.landing) || null;
  const extras = obj(overlay.extras) || obj(companion.extras) || obj(input.extras) || null;
  const visionResult = obj(overlay.visionResult) || obj(input.visionResult) || null;

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
    cameraOk: firstBool(vision.camera_ok, vision.cameraOk, extras?.camera_ok, extras?.camera_connected),
    visionHealth: vision.health,
    rawPipeline: pipelineName(videoOverlay),
    extras,
  });
  const plnd = buildPlndProfileHonesty({
    liveFcParams: input.liveFcParams,
    companionParams: input.companionParams,
    persistedArduTarget: input.persistedArduTarget,
    persistedVisionProfile: input.persistedVisionProfile,
  });
  const recording = resolveTelemetryRecordingState({
    manualRecordApi: input.manualRecordApi,
  });
  const detect = resolveRunwayDetectState({
    companionReachable,
    landing,
    vision,
    extras,
    visionResult,
    landingPathAbsent: input.landingPathAbsent === true || overlay.landingPathAbsent === true,
  });
  const lock = probeRunwayLock({
    companion: { jetson: companionReachable ? 'reachable' : 'off' },
    landing,
    vision,
    extras,
  });

  const annotatedVideo = resolveAnnotatedVideoHonesty({
    video: input.video,
    cellular: input.cellular,
    modemPresent: input.modemPresent,
  });
  const rows = [
    jetsonRow(jetson),
    fcRow(fc),
    cameraRow(camera),
    runwayDetectRow(detect),
    runwayLockRow(lock),
    plndRow(plnd),
    videoRow({
      video: input.video,
      cellular: input.cellular,
      modemPresent: input.modemPresent,
    }),
    recordingRow(recording),
    flightGateRow(),
  ];

  return {
    ok: true,
    kind: 'vision_landing_readiness',
    experiment: {
      id: 'fixed_wing_final_observe',
      observeOnly: true,
      picHandFlyFinal: true,
      control: false,
      success: 'runway_detect_on_final',
      annotationsRequired: false,
      runwayLockRequired: false,
    },
    purposeHe: EXPERIMENT_PURPOSE_HE,
    successHe: EXPERIMENT_SUCCESS_HE,
    rows,
    flightCommandsGate: FLIGHT_COMMANDS_GATE,
    flightCommandTokens: [...FLIGHT_COMMAND_TOKENS],
    invented: { camera: false, gps: false, runway: false, annotations: false, lock: false },
    sendFlightCommands: false,
    runwayDetect: detect,
    runwayLock: {
      state: lock.state,
      source: lock.source,
    },
    annotatedVideo,
    experimentSuccess: detect === 'detected',
  };
}
