/**
 * Guided dual-camera install checklist + live-frame verify.
 * Operator confirm is stored separately from Companion/vision probes.
 * Never invent camera_ok or frames. Never claim IMU/vision self-calibration.
 * No flight-command send. No Jetson shell deploy.
 */

import { probeCameraVision } from './vision-companion-probe.mjs';

export const CAMERA_INSTALL_STEP_IDS = Object.freeze([
  'role_select',
  'physical_connect',
  'jetson_wiring',
  'companion_pipeline',
  'live_frame',
]);

export const CAMERA_INSTALL_ROLES = Object.freeze({
  forward: Object.freeze({
    id: 'forward',
    cameraId: 'cam1',
    labelHe: 'קדמית',
    titleHe: 'מצלמה 1 — קדמית',
  }),
  down: Object.freeze({
    id: 'down',
    cameraId: 'cam2',
    labelHe: 'מטה',
    titleHe: 'מצלמה 2 — מטה',
  }),
});

export const CAMERA_INSTALL_ROLE_IDS = Object.freeze(['forward', 'down']);

export const CAMERA_INSTALL_MOUNT_KINDS = Object.freeze(['none', 'preset_45_down', 'free']);
export const CAMERA_INSTALL_MOUNT_PRESET_HE = 'בערך 45° מטה';
export const CAMERA_INSTALL_MOUNT_DISCLAIMER_HE = 'הערכה בלבד — לא כיול';
export const CAMERA_INSTALL_NO_FRAME_HE = 'אין פריים';
export const CAMERA_INSTALL_CONFIG_KEY = 'cameraInstallChecklist';

export const CAMERA_INSTALL_STEP_COPY = Object.freeze({
  role_select: Object.freeze({
    nameHe: 'בחרו תפקיד לכל מצלמה',
    helpHe: 'שתי מצלמות עדיפות. דגמים שונים בסדר. אחת קדמית ואחת מטה.',
  }),
  physical_connect: Object.freeze({
    nameHe: 'חברו את המצלמות למטוס',
    helpHe: 'חברו פיזית ואשרו כשסיימתם. המערכת לא מנחשת חיבור.',
  }),
  jetson_wiring: Object.freeze({
    nameHe: 'חברו למחשב המשימה',
    helpHe: 'חברו כבל מהמצלמה למחשב המשימה. אם לא ברור איזה שקע — נשאיר לא ידוע.',
  }),
  companion_pipeline: Object.freeze({
    nameHe: 'הפעילו את צינור הראייה',
    helpHe: 'הסטטוס מגיע רק מדיווח חי. אין המצאת מצלמה.',
  }),
  live_frame: Object.freeze({
    nameHe: 'בדקו שפריים חי נראה',
    helpHe: 'אישור רק כשיש פריים או קצב או גיל אמיתי. אחרת אין פריים.',
  }),
});

export const SYSTEM_VERIFY_HE = Object.freeze({
  unknown: 'לא ידוע',
  missing: 'חסר',
  ok: 'תקין',
});

const MOUNT_TEXT_MAX = 200;

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstBool(...values) {
  for (const v of values) {
    if (v === true || v === false) return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
  }
  return null;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function roleId(value, fallback) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'forward' || key === 'front' || key === 'קדמית') return 'forward';
  if (key === 'down' || key === 'nadir' || key === 'מטה') return 'down';
  return fallback;
}

export function emptyCameraInstallOperator() {
  return {
    roles: { cam1: 'forward', cam2: 'down' },
    confirms: {
      role_select: false,
      physical_connect: false,
      jetson_wiring: false,
      companion_pipeline: false,
      live_frame: false,
    },
    mountNote: {
      kind: 'none',
      text: '',
      estimateOnly: true,
      disclaimerHe: CAMERA_INSTALL_MOUNT_DISCLAIMER_HE,
    },
  };
}

export function normalizeCameraInstallOperator(raw) {
  const empty = emptyCameraInstallOperator();
  const src = obj(raw) || {};
  const rolesIn = obj(src.roles) || {};
  const confirmsIn = obj(src.confirms) || {};
  const mountIn = obj(src.mountNote) || obj(src.mount_note) || {};
  const kind = CAMERA_INSTALL_MOUNT_KINDS.includes(String(mountIn.kind || ''))
    ? String(mountIn.kind)
    : 'none';
  const text = String(mountIn.text || '').trim().slice(0, MOUNT_TEXT_MAX);
  const confirms = { ...empty.confirms };
  for (const id of CAMERA_INSTALL_STEP_IDS) {
    confirms[id] = confirmsIn[id] === true;
  }
  return {
    roles: {
      cam1: roleId(rolesIn.cam1, 'forward'),
      cam2: roleId(rolesIn.cam2, 'down'),
    },
    confirms,
    mountNote: {
      kind,
      text,
      estimateOnly: true,
      disclaimerHe: CAMERA_INSTALL_MOUNT_DISCLAIMER_HE,
      presetHe: kind === 'preset_45_down' ? CAMERA_INSTALL_MOUNT_PRESET_HE : '',
    },
  };
}

/**
 * Live-frame verify only from reported fps / frame count / frame age.
 * camera_ok alone is not a frame. Operator confirm is ignored here.
 */
export function resolveLiveFrameVerify({
  fps = null,
  frames = null,
  frameAgeMs = null,
} = {}) {
  const fieldsUsed = [];
  const fpsN = finiteOrNull(fps);
  const framesN = finiteOrNull(frames);
  const ageN = finiteOrNull(frameAgeMs);
  if (fpsN != null) fieldsUsed.push('fps');
  if (framesN != null) fieldsUsed.push('frames');
  if (ageN != null) fieldsUsed.push('frame_age_ms');
  const hasFrame = (fpsN != null && fpsN > 0)
    || (framesN != null && framesN > 0)
    || (ageN != null && ageN >= 0);
  if (!hasFrame) {
    return {
      state: 'missing',
      stateHe: CAMERA_INSTALL_NO_FRAME_HE,
      fps: fpsN,
      frames: framesN,
      frameAgeMs: ageN,
      fieldsUsed,
    };
  }
  return {
    state: 'ok',
    stateHe: 'פריים חי',
    fps: fpsN,
    frames: framesN,
    frameAgeMs: ageN,
    fieldsUsed,
  };
}

function extractFrameSignals(vision, video) {
  const v = obj(vision) || {};
  const vid = obj(video) || {};
  const fps = finiteOrNull(v.fps) ?? finiteOrNull(vid.raw_fps) ?? finiteOrNull(vid.fps);
  const frames = finiteOrNull(v.frame_id)
    ?? finiteOrNull(v.frameId)
    ?? finiteOrNull(v.frameCount)
    ?? finiteOrNull(v.frame_count)
    ?? finiteOrNull(vid.frame_id)
    ?? finiteOrNull(vid.frameCount);
  const ageMs = finiteOrNull(v.age_ms)
    ?? finiteOrNull(v.frame_age_ms)
    ?? finiteOrNull(v.frameAgeMs)
    ?? finiteOrNull(v.last_frame_age_ms)
    ?? finiteOrNull(vid.age_ms)
    ?? finiteOrNull(vid.frame_age_ms);
  return { fps, frames, frameAgeMs: ageMs };
}

function cameraOkFrom(vision, extras, probe) {
  if (probe && (probe.cameraOk === true || probe.cameraOk === false)) return probe.cameraOk;
  const v = obj(vision) || {};
  const e = obj(extras) || {};
  return firstBool(v.camera_ok, v.cameraOk, e.camera_ok, e.camera_connected, e.cameraConnected);
}

function perCameraOk(opticalNav, extras) {
  const nav = obj(opticalNav) || obj(extras?.optical_nav) || obj(extras?.opticalNav) || {};
  const cameras = obj(nav.cameras) || {};
  return {
    cam1: firstBool(obj(cameras.cam1)?.camera_ok, obj(cameras.cam1)?.cameraOk),
    cam2: firstBool(obj(cameras.cam2)?.camera_ok, obj(cameras.cam2)?.cameraOk),
  };
}

function systemForRoleSelect() {
  return { state: 'unknown', stateHe: SYSTEM_VERIFY_HE.unknown };
}

function systemForPhysical({ cameraOk, perCam }) {
  if (cameraOk === true || perCam.cam1 === true || perCam.cam2 === true) {
    return { state: 'ok', stateHe: SYSTEM_VERIFY_HE.ok };
  }
  if (cameraOk === false || perCam.cam1 === false || perCam.cam2 === false) {
    return { state: 'missing', stateHe: SYSTEM_VERIFY_HE.missing };
  }
  return { state: 'unknown', stateHe: SYSTEM_VERIFY_HE.unknown };
}

function systemForWiring({ cameraOk, rawPipeline, rawPipelineLive }) {
  if (rawPipelineLive === true) {
    return { state: 'ok', stateHe: SYSTEM_VERIFY_HE.ok };
  }
  if (cameraOk === false) {
    return { state: 'missing', stateHe: SYSTEM_VERIFY_HE.missing };
  }
  if (rawPipeline != null && rawPipelineLive === false) {
    return { state: 'missing', stateHe: SYSTEM_VERIFY_HE.missing };
  }
  return { state: 'unknown', stateHe: SYSTEM_VERIFY_HE.unknown };
}

function systemForPipeline({ cameraOk, liveFrame }) {
  if (cameraOk === true) {
    return { state: 'ok', stateHe: SYSTEM_VERIFY_HE.ok };
  }
  if (liveFrame.state === 'ok') {
    return { state: 'ok', stateHe: SYSTEM_VERIFY_HE.ok };
  }
  if (cameraOk === false) {
    return { state: 'missing', stateHe: SYSTEM_VERIFY_HE.missing };
  }
  return { state: 'unknown', stateHe: SYSTEM_VERIFY_HE.unknown };
}

function roleLabels(operator) {
  const cam1 = CAMERA_INSTALL_ROLES[operator.roles.cam1] || CAMERA_INSTALL_ROLES.forward;
  const cam2 = CAMERA_INSTALL_ROLES[operator.roles.cam2] || CAMERA_INSTALL_ROLES.down;
  return {
    cam1: { id: 'cam1', role: cam1.id, labelHe: cam1.labelHe, titleHe: `מצלמה 1 — ${cam1.labelHe}` },
    cam2: { id: 'cam2', role: cam2.id, labelHe: cam2.labelHe, titleHe: `מצלמה 2 — ${cam2.labelHe}` },
  };
}

/**
 * Build the install checklist. Operator confirms never mutate camera_ok.
 */
export function buildCameraInstallChecklist({
  operator = null,
  companion = null,
  vision = null,
  video = null,
  extras = null,
  opticalNav = null,
} = {}) {
  const progress = normalizeCameraInstallOperator(operator);
  const probe = probeCameraVision({ companion, vision, video, extras });
  const frameSignals = extractFrameSignals(vision, video);
  const liveFrame = resolveLiveFrameVerify(frameSignals);
  const cameraOk = cameraOkFrom(vision, extras, probe);
  const perCam = perCameraOk(opticalNav, extras);
  const roles = roleLabels(progress);

  const systemByStep = {
    role_select: systemForRoleSelect(),
    physical_connect: systemForPhysical({ cameraOk, perCam }),
    jetson_wiring: systemForWiring({
      cameraOk,
      rawPipeline: probe.rawPipeline,
      rawPipelineLive: probe.rawPipelineLive,
    }),
    companion_pipeline: systemForPipeline({ cameraOk, liveFrame }),
    live_frame: {
      state: liveFrame.state,
      stateHe: liveFrame.stateHe,
    },
  };

  const steps = CAMERA_INSTALL_STEP_IDS.map((id) => {
    const copy = CAMERA_INSTALL_STEP_COPY[id];
    const system = systemByStep[id];
    return {
      id,
      nameHe: copy.nameHe,
      helpHe: copy.helpHe,
      operatorConfirmed: progress.confirms[id] === true,
      systemState: system.state,
      systemStateHe: system.stateHe,
    };
  });

  const operatorConfirmedCount = steps.filter((s) => s.operatorConfirmed).length;
  const systemOkCount = steps.filter((s) => s.systemState === 'ok').length;

  return {
    ok: true,
    kind: 'camera_install_checklist',
    dualPreferred: true,
    roles,
    roleLabelsHe: {
      forward: CAMERA_INSTALL_ROLES.forward.labelHe,
      down: CAMERA_INSTALL_ROLES.down.labelHe,
    },
    steps,
    mountNote: progress.mountNote,
    operator: progress,
    probe: {
      cameraOk,
      health: probe.health,
      fps: probe.fps,
      frames: probe.frames,
      rawPipeline: probe.rawPipeline,
    },
    liveFrame,
    perCamera: perCam,
    summary: {
      operatorConfirmedCount,
      operatorTotal: CAMERA_INSTALL_STEP_IDS.length,
      systemOkCount,
      cameraOk,
      liveFrame: liveFrame.state,
      liveFrameHe: liveFrame.stateHe,
    },
    invented: {
      camera: false,
      frames: false,
      calibration: false,
    },
    calibrationClaimed: false,
  };
}

export function cameraInstallReadinessRow(checklist) {
  const snap = checklist && typeof checklist === 'object'
    ? checklist
    : buildCameraInstallChecklist({});
  const extra = {
    stage: 'experiment_1',
    requiredForExperiment1: false,
    operatorConfirmedCount: snap.summary.operatorConfirmedCount,
    operatorTotal: snap.summary.operatorTotal,
    systemOkCount: snap.summary.systemOkCount,
    cameraOk: snap.summary.cameraOk,
    liveFrame: snap.summary.liveFrame,
    invented: false,
    calibrationClaimed: false,
  };
  if (snap.liveFrame.state === 'ok') {
    return {
      id: 'camera_install',
      state: 'ok',
      nameHe: 'התקנת מצלמות',
      stateHe: 'פריים חי',
      missingHe: '',
      tone: 'ok',
      ...extra,
    };
  }
  const confirmed = snap.summary.operatorConfirmedCount;
  const operatorNote = confirmed > 0
    ? `${confirmed} מ־${snap.summary.operatorTotal} אושרו. אישור מפעיל אינו דיווח מצלמה.`
    : '';
  if (snap.summary.cameraOk === false || snap.liveFrame.state === 'missing') {
    return {
      id: 'camera_install',
      state: 'missing',
      nameHe: 'התקנת מצלמות',
      stateHe: CAMERA_INSTALL_NO_FRAME_HE,
      missingHe: operatorNote || 'אין פריים חי. אין המצאת מצלמה.',
      tone: confirmed > 0 ? 'warn' : 'off',
      ...extra,
    };
  }
  return {
    id: 'camera_install',
    state: 'unknown',
    nameHe: 'התקנת מצלמות',
    stateHe: confirmed > 0 ? `${confirmed} מ־${snap.summary.operatorTotal}` : 'לא ידוע',
    missingHe: operatorNote || 'אין דיווח מצלמה.',
    tone: 'off',
    ...extra,
  };
}
