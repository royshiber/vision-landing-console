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
  gimbal: Object.freeze({
    id: 'gimbal',
    cameraId: 'cam3',
    labelHe: 'גימבל',
    titleHe: 'מצלמה 3 — גימבל',
  }),
});

export const CAMERA_INSTALL_ROLE_IDS = Object.freeze(['forward', 'down', 'gimbal']);
export const CAMERA_INSTALL_SLOT_IDS = Object.freeze(['cam1', 'cam2', 'cam3']);

export const CAMERA_INSTALL_MOUNT_KINDS = Object.freeze(['none', 'preset_45_down', 'free']);
export const CAMERA_INSTALL_MOUNT_PRESET_HE = 'בערך 45° מטה';
export const CAMERA_INSTALL_MOUNT_DISCLAIMER_HE = 'הערכה בלבד — לא כיול';
export const CAMERA_INSTALL_NO_FRAME_HE = 'אין פריים';
export const CAMERA_INSTALL_CONFIG_KEY = 'cameraInstallChecklist';

export const CAMERA_INSTALL_STEP_COPY = Object.freeze({
  role_select: Object.freeze({
    nameHe: 'בחרו תפקיד לכל מצלמה',
    helpHe: 'שתי מצלמות עדיפות. דגמים שונים בסדר. אחת קדמית ואחת מטה. גימבל הוא מצלמה שלישית, רק אם הפעלתם אותו.',
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
    helpHe: 'כל מצלמה שהופעלה צריכה פריים חי משלה. מצלמה אחת לא מכסה את השנייה.',
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
  if (key === 'gimbal' || key === 'גימבל' || key === 'cam3' || key === 'siyi') return 'gimbal';
  if (key === 'off' || key === 'disabled' || key === 'none' || key === 'כבוי') return 'off';
  return fallback;
}

export function emptyCameraInstallOperator() {
  return {
    roles: { cam1: 'forward', cam2: 'down', cam3: 'off' },
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
      cam3: roleId(rolesIn.cam3, 'off'),
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

function cameraPool(vision, video, opticalNav, extras) {
  const v = obj(vision) || {};
  const vid = obj(video) || {};
  const nav = obj(opticalNav) || obj(extras?.optical_nav) || obj(extras?.opticalNav) || {};
  return [
    obj(v.cameras)?.cam1,
    obj(v.cameras)?.cam2,
    obj(v.cameras)?.cam3,
    obj(nav.cameras)?.cam1,
    obj(nav.cameras)?.cam2,
    obj(nav.cameras)?.cam3,
    obj(extras?.cameras)?.cam1,
    obj(extras?.cameras)?.cam2,
    obj(extras?.cameras)?.cam3,
    v,
    vid,
  ].filter(Boolean);
}

function extractFrameSignals(vision, video, opticalNav, extras) {
  const pools = cameraPool(vision, video, opticalNav, extras);
  let fps = null;
  let frames = null;
  let ageMs = null;
  for (const item of pools) {
    fps = fps ?? finiteOrNull(item.fps) ?? finiteOrNull(item.raw_fps);
    frames = frames
      ?? finiteOrNull(item.frame_id)
      ?? finiteOrNull(item.frameId)
      ?? finiteOrNull(item.frameCount)
      ?? finiteOrNull(item.frame_count);
    ageMs = ageMs
      ?? finiteOrNull(item.age_ms)
      ?? finiteOrNull(item.frame_age_ms)
      ?? finiteOrNull(item.frameAgeMs)
      ?? finiteOrNull(item.last_frame_age_ms)
      ?? finiteOrNull(item.lastFrameAgeMs);
  }
  return { fps, frames, frameAgeMs: ageMs };
}

function cameraOkFrom(vision, extras, probe) {
  if (probe && (probe.cameraOk === true || probe.cameraOk === false)) return probe.cameraOk;
  const v = obj(vision) || {};
  const e = obj(extras) || {};
  return firstBool(v.camera_ok, v.cameraOk, e.camera_ok, e.camera_connected, e.cameraConnected);
}

function perCameraOk(opticalNav, extras, vision) {
  const nav = obj(opticalNav) || obj(extras?.optical_nav) || obj(extras?.opticalNav) || {};
  const cameras = obj(nav.cameras) || obj(vision?.cameras) || obj(extras?.cameras) || {};
  const detail = (id) => {
    const cam = obj(cameras[id]) || {};
    return {
      camera_ok: firstBool(cam.camera_ok, cam.cameraOk),
      present: firstBool(cam.present),
      fps: finiteOrNull(cam.fps),
      frame_count: finiteOrNull(cam.frame_count ?? cam.frameCount),
      last_frame_age_ms: finiteOrNull(cam.last_frame_age_ms ?? cam.lastFrameAgeMs),
      error: typeof cam.error === 'string' ? cam.error : null,
      source: cam.source || null,
      dry_run: cam.dry_run === true || cam.dryRun === true,
      real: cam.real === true,
      state: typeof cam.state === 'string' ? cam.state : null,
      enabled: cam.enabled === false ? false : cam.enabled === true ? true : null,
    };
  };
  const cam1 = detail('cam1');
  const cam2 = detail('cam2');
  const cam3 = detail('cam3');
  return {
    cam1: cam1.camera_ok,
    cam2: cam2.camera_ok,
    cam3: cam3.camera_ok,
    detail: { cam1, cam2, cam3 },
  };
}

function cameraMap(opticalNav, extras, vision) {
  const nav = obj(opticalNav) || obj(extras?.optical_nav) || obj(extras?.opticalNav) || {};
  return obj(nav.cameras) || obj(vision?.cameras) || obj(extras?.cameras) || {};
}

function enabledCameraIds(operator, cameras) {
  const ids = [];
  for (const id of ['cam1', 'cam2']) {
    const cam = obj(cameras[id]);
    if (cam && cam.enabled === false) continue;
    ids.push(id);
  }
  const role = operator?.roles?.cam3;
  const cam3 = obj(cameras.cam3);
  if (role === 'gimbal' || cam3?.enabled === true) ids.push('cam3');
  return ids;
}

function slotLive(cam) {
  const state = typeof cam.state === 'string' ? cam.state : '';
  if (state && state !== 'streaming') return resolveLiveFrameVerify({});
  if (cam.enabled === false) return resolveLiveFrameVerify({});
  return resolveLiveFrameVerify({
    fps: cam.fps,
    frames: cam.frame_count ?? cam.frameCount,
    frameAgeMs: cam.last_frame_age_ms ?? cam.lastFrameAgeMs ?? cam.frame_age_ms,
  });
}

/**
 * Live frames are required on every enabled camera.
 * Legacy payloads with only an aggregate fps stay on the old single signal.
 */
function liveFramesForEnabled(operator, cameras, aggregate) {
  const requiredIds = enabledCameraIds(operator, cameras);
  const haveSlots = requiredIds.some((id) => obj(cameras[id]));
  if (!haveSlots) {
    return { live: resolveLiveFrameVerify(aggregate), perSlot: null, requiredIds };
  }
  const perSlot = {};
  const missing = [];
  for (const id of requiredIds) {
    const live = slotLive(obj(cameras[id]) || {});
    perSlot[id] = live;
    if (live.state !== 'ok') missing.push(id);
  }
  if (missing.length) {
    return {
      live: {
        state: 'missing',
        stateHe: CAMERA_INSTALL_NO_FRAME_HE,
        fps: null,
        frames: null,
        frameAgeMs: null,
        fieldsUsed: [],
        missingCameras: missing,
      },
      perSlot,
      requiredIds,
    };
  }
  const first = perSlot[requiredIds[0]] || resolveLiveFrameVerify({});
  return {
    live: { ...first, state: 'ok', stateHe: 'פריים חי', missingCameras: [] },
    perSlot,
    requiredIds,
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
  const cam3Role = operator.roles.cam3;
  const cam3 = cam3Role === 'gimbal'
    ? CAMERA_INSTALL_ROLES.gimbal
    : { id: 'off', labelHe: 'כבויה' };
  return {
    cam1: { id: 'cam1', role: cam1.id, enabled: true, labelHe: cam1.labelHe, titleHe: `מצלמה 1 — ${cam1.labelHe}` },
    cam2: { id: 'cam2', role: cam2.id, enabled: true, labelHe: cam2.labelHe, titleHe: `מצלמה 2 — ${cam2.labelHe}` },
    cam3: {
      id: 'cam3',
      role: cam3.id,
      enabled: cam3Role === 'gimbal',
      labelHe: cam3.labelHe,
      titleHe: cam3Role === 'gimbal' ? 'מצלמה 3 — גימבל' : 'מצלמה 3 — כבויה',
    },
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
  const frameSignals = extractFrameSignals(vision, video, opticalNav, extras);
  const cameras = cameraMap(opticalNav, extras, vision);
  const livePack = liveFramesForEnabled(progress, cameras, frameSignals);
  const liveFrame = livePack.live;
  const cameraOk = cameraOkFrom(vision, extras, probe);
  const perCam = perCameraOk(opticalNav, extras, vision);
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
      gimbal: CAMERA_INSTALL_ROLES.gimbal.labelHe,
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
    requiredCameras: livePack.requiredIds,
    perSlotLive: livePack.perSlot,
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
