/**
 * Honest Companion/Jetson camera + runway-detect probe for Experiment #1.
 * Observe-only. Never invent camera_ok, GPS, runway detect, or lock.
 * Aruco / marker landing-target is not runway detection.
 */

export const CAMERA_VISION_STATES = Object.freeze(['ok', 'absent', 'unknown']);
export const RUNWAY_DETECT_STATES = Object.freeze([
  'detected',
  'not_detected',
  'unknown',
  'not_implemented',
  'absent',
]);
export const RUNWAY_LOCK_STATES = Object.freeze([
  'unknown',
  'not',
  'detecting',
  'locked',
]);

const LOCK_ALIASES = Object.freeze({
  unknown: 'unknown',
  not: 'not',
  not_locked: 'not',
  notlocked: 'not',
  unlocked: 'not',
  none: 'not',
  off: 'not',
  detecting: 'detecting',
  detect: 'detecting',
  acquired: 'detecting',
  searching: 'detecting',
  locking: 'detecting',
  locked: 'locked',
  locked_confident: 'locked',
  lockedconfident: 'locked',
  confident: 'locked',
});

const RUNWAY_LABEL_RE = /^(runway|runway_detect|runway_detector|runway_edge|airstrip|strip|landing_strip|מסלול)$/i;
const RUNWAY_SOURCE_RE = /^(runway|runway_detect|runway_detector|airstrip|landing_strip)$/i;
const NON_RUNWAY_SOURCE_RE = /^(aruco|marker|apriltag|april_tag|none|)$/i;

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

function lockBool(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function normalizeLockToken(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'locked' : 'not';
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return LOCK_ALIASES[key] || null;
}

function lockCandidates({ landing, vision, extras } = {}) {
  const l = obj(landing) || {};
  const v = obj(vision) || {};
  const e = obj(extras) || {};
  const nested = obj(l.runway) || obj(v.runway) || obj(e.runway) || {};
  return [
    ['landing.lock_state', l.lock_state],
    ['landing.lockState', l.lockState],
    ['landing.runway_lock', l.runway_lock],
    ['landing.runwayLock', l.runwayLock],
    ['landing.lock', l.lock],
    ['landing.locked', l.locked],
    ['landing.runway_locked', l.runway_locked],
    ['landing.runwayLocked', l.runwayLocked],
    ['landing.status_lock', l.status_lock],
    ['landing.runway.lock_state', nested.lock_state],
    ['landing.runway.lock', nested.lock],
    ['landing.runway.locked', nested.locked],
    ['vision.lock_state', v.lock_state],
    ['vision.runway_lock', v.runway_lock],
    ['vision.lock', v.lock],
    ['vision.locked', v.locked],
    ['extras.runway_lock', e.runway_lock],
    ['extras.lock_state', e.lock_state],
    ['extras.locked', e.locked],
    ['extras.lock', e.lock],
  ];
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asList(...values) {
  const out = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...v);
    else if (v && typeof v === 'object') out.push(v);
  }
  return out;
}

function jetsonReachable(companion) {
  const link = obj(companion) || {};
  const jetson = String(link.jetson || 'off');
  return jetson === 'reachable' || jetson === 'mock';
}

function pipelineLive(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'stopped' || s === 'unavailable' || s === 'off' || s === 'idle') {
    return false;
  }
  return true;
}

function detectionLabel(det) {
  const d = obj(det) || {};
  return String(d.label || d.class || d.type || d.kind || '').trim();
}

function isRunwayDetection(det) {
  return RUNWAY_LABEL_RE.test(detectionLabel(det));
}

function collectDetections({ vision, landing, visionResult } = {}) {
  const v = obj(vision) || {};
  const l = obj(landing) || {};
  const r = obj(visionResult) || {};
  return asList(v.detections, l.detections, r.detections);
}

function explicitRunwayFlag({ vision, landing, extras, visionResult } = {}) {
  const v = obj(vision) || {};
  const l = obj(landing) || {};
  const e = obj(extras) || {};
  const r = obj(visionResult) || {};
  const nested = obj(l.runway) || obj(v.runway) || obj(e.runway) || {};
  return firstBool(
    l.runway_detected,
    l.runwayDetected,
    l.runway_detect,
    v.runway_detected,
    v.runwayDetected,
    v.runway_detect,
    r.runway_detected,
    r.runwayDetected,
    e.runway_detected,
    e.runwayDetected,
    e.runway_detect,
    nested.detected,
    nested.runway_detected,
  );
}

function runwaySource({ landing, extras } = {}) {
  const l = obj(landing) || {};
  const e = obj(extras) || {};
  const nested = obj(l.runway) || obj(e.runway) || {};
  const raw = l.source ?? nested.source ?? e.runway_source ?? e.detector ?? null;
  return raw == null ? '' : String(raw).trim();
}

function detectorDeclared({ landing, extras, vision } = {}) {
  const l = obj(landing) || {};
  const e = obj(extras) || {};
  const v = obj(vision) || {};
  const nested = obj(l.runway) || obj(v.runway) || obj(e.runway) || {};
  const declared = firstBool(
    e.runway_detector,
    e.runwayDetector,
    l.runway_detector,
    l.runwayDetector,
    nested.present,
    nested.implemented,
    nested.enabled,
  );
  return declared;
}

function landingReportPresent(landing) {
  const l = obj(landing);
  if (!l) return false;
  if (l.source != null && String(l.source).trim() !== '') return true;
  if (l.validity != null && String(l.validity).trim() !== '') return true;
  if (Array.isArray(l.detections)) return true;
  if (l.target != null) return true;
  if (l.runway_detected != null || l.runwayDetected != null || l.runway_detect != null) return true;
  if (obj(l.runway)) return true;
  return false;
}

/**
 * Camera / vision health from reported Companion fields only.
 * @returns {{
 *   state: 'ok'|'absent'|'unknown',
 *   cameraOk: boolean|null,
 *   health: string|null,
 *   running: boolean|null,
 *   rawPipeline: string|null,
 *   rawPipelineLive: boolean|null,
 *   frames: number|null,
 *   fps: number|null,
 *   fieldsUsed: string[],
 * }}
 */
export function probeCameraVision({ companion, vision, video, extras } = {}) {
  const v = obj(vision);
  const vid = obj(video);
  const extra = obj(extras) || {};
  const fieldsUsed = [];
  const cameraOk = firstBool(
    v?.camera_ok,
    v?.cameraOk,
    extra.camera_ok,
    extra.camera_connected,
    extra.cameraConnected,
  );
  if (v && (v.camera_ok === true || v.camera_ok === false || v.cameraOk === true || v.cameraOk === false)) {
    fieldsUsed.push('vision.camera_ok');
  } else if (extra.camera_ok === true || extra.camera_ok === false || extra.camera_connected === true || extra.camera_connected === false) {
    fieldsUsed.push('extras.camera_connected');
  }
  const health = v?.health != null ? String(v.health) : null;
  if (health) fieldsUsed.push('vision.health');
  const running = firstBool(v?.running);
  if (running === true || running === false) fieldsUsed.push('vision.running');
  const rawPipeline = vid?.raw_pipeline != null ? String(vid.raw_pipeline) : null;
  const rawPipelineLive = rawPipeline == null ? null : pipelineLive(rawPipeline);
  if (rawPipeline != null) fieldsUsed.push('video.raw_pipeline');
  const fps = finiteOrNull(v?.fps) ?? finiteOrNull(vid?.raw_fps) ?? finiteOrNull(vid?.fps);
  if (fps != null) fieldsUsed.push('vision.fps');
  const frames = finiteOrNull(v?.frame_id) ?? finiteOrNull(v?.frameId) ?? finiteOrNull(v?.frameCount);
  if (frames != null) fieldsUsed.push('vision.frame_id');

  if (!jetsonReachable(companion)) {
    return {
      state: 'unknown',
      cameraOk,
      health,
      running,
      rawPipeline,
      rawPipelineLive,
      frames,
      fps,
      fieldsUsed,
    };
  }
  if (cameraOk === false) {
    return {
      state: 'absent',
      cameraOk,
      health,
      running,
      rawPipeline,
      rawPipelineLive,
      frames,
      fps,
      fieldsUsed,
    };
  }
  if (cameraOk === true) {
    return {
      state: 'ok',
      cameraOk,
      health,
      running,
      rawPipeline,
      rawPipelineLive,
      frames,
      fps,
      fieldsUsed,
    };
  }
  return {
    state: 'unknown',
    cameraOk: null,
    health,
    running,
    rawPipeline,
    rawPipelineLive,
    frames,
    fps,
    fieldsUsed,
  };
}

/**
 * Observe-only runway detection. Never maps Aruco/marker landing-target to detected.
 * @returns {{
 *   state: 'detected'|'not_detected'|'unknown'|'not_implemented'|'absent',
 *   detected: boolean|null,
 *   source: string|null,
 *   label: string|null,
 *   fieldsUsed: string[],
 *   detector: 'runway'|'landing_target'|'none'|'unknown',
 * }}
 */
export function probeRunwayDetect({ companion, vision, landing, extras, visionResult, landingPathAbsent } = {}) {
  const v = obj(vision);
  const l = obj(landing);
  const extra = obj(extras);
  const result = obj(visionResult);
  const fieldsUsed = [];
  const src = runwaySource({ landing, extras });
  if (src) fieldsUsed.push('landing.source');
  const explicit = explicitRunwayFlag({ vision, landing, extras, visionResult });
  if (explicit === true || explicit === false) fieldsUsed.push('runway_detected');
  const detections = collectDetections({ vision, landing, visionResult });
  const runwayDets = detections.filter(isRunwayDetection);
  if (runwayDets.length) fieldsUsed.push('detections.label');
  const declared = detectorDeclared({ landing, extras, vision });
  if (declared === true || declared === false) fieldsUsed.push('runway_detector');

  if (!jetsonReachable(companion)) {
    return {
      state: 'unknown',
      detected: null,
      source: src || null,
      label: runwayDets[0] ? detectionLabel(runwayDets[0]) : null,
      fieldsUsed,
      detector: 'unknown',
    };
  }

  if (landingPathAbsent === true && explicit == null && !runwayDets.length && declared == null) {
    return {
      state: 'not_implemented',
      detected: null,
      source: src || null,
      label: null,
      fieldsUsed: [...fieldsUsed, 'status/landing'],
      detector: 'none',
    };
  }

  if (declared === false) {
    return {
      state: 'absent',
      detected: null,
      source: src || null,
      label: null,
      fieldsUsed,
      detector: 'none',
    };
  }

  if (explicit === true || runwayDets.length > 0) {
    return {
      state: 'detected',
      detected: true,
      source: src || (runwayDets[0] ? detectionLabel(runwayDets[0]) : 'runway'),
      label: runwayDets[0] ? detectionLabel(runwayDets[0]) : 'runway',
      fieldsUsed,
      detector: 'runway',
    };
  }

  if (explicit === false) {
    return {
      state: 'not_detected',
      detected: false,
      source: src || 'runway',
      label: null,
      fieldsUsed,
      detector: 'runway',
    };
  }

  if (src && RUNWAY_SOURCE_RE.test(src)) {
    const landingDetected = firstBool(l?.detected);
    const validTarget = l?.validity === 'valid' && l?.target != null;
    if (landingDetected === true || validTarget) {
      return {
        state: 'detected',
        detected: true,
        source: src,
        label: 'runway',
        fieldsUsed,
        detector: 'runway',
      };
    }
    return {
      state: 'not_detected',
      detected: false,
      source: src,
      label: null,
      fieldsUsed,
      detector: 'runway',
    };
  }

  if (declared === true) {
    return {
      state: 'not_detected',
      detected: false,
      source: src || 'runway',
      label: null,
      fieldsUsed,
      detector: 'runway',
    };
  }

  if (src && NON_RUNWAY_SOURCE_RE.test(src)) {
    return {
      state: 'not_implemented',
      detected: null,
      source: src,
      label: detections[0] ? detectionLabel(detections[0]) : null,
      fieldsUsed,
      detector: src === 'none' || src === '' ? 'none' : 'landing_target',
    };
  }

  if (landingReportPresent(l)) {
    return {
      state: 'not_implemented',
      detected: null,
      source: src || null,
      label: detections[0] ? detectionLabel(detections[0]) : null,
      fieldsUsed,
      detector: src ? 'landing_target' : 'none',
    };
  }

  return {
    state: 'unknown',
    detected: null,
    source: src || null,
    label: null,
    fieldsUsed,
    detector: 'unknown',
  };
}

/**
 * Observe-only runway lock. Never invent locked or detecting from detect/confidence.
 * No lock field → unknown. Explicit not / detecting / locked only.
 * @returns {{
 *   state: 'unknown'|'not'|'detecting'|'locked',
 *   source: string|null,
 *   token: string|null,
 *   fieldsUsed: string[],
 * }}
 */
export function probeRunwayLock({ companion, vision, landing, extras } = {}) {
  const fieldsUsed = [];
  const candidates = lockCandidates({ landing, vision, extras });

  if (!jetsonReachable(companion)) {
    return {
      state: 'unknown',
      source: null,
      token: null,
      fieldsUsed,
    };
  }

  for (const [source, value] of candidates) {
    if (value == null || value === '') continue;
    const token = normalizeLockToken(value);
    if (token) {
      fieldsUsed.push(source);
      return {
        state: token,
        source,
        token: typeof value === 'boolean' ? String(value) : String(value),
        fieldsUsed,
      };
    }
    const flag = lockBool(value);
    if (flag === true) {
      fieldsUsed.push(source);
      return { state: 'locked', source, token: 'true', fieldsUsed };
    }
    if (flag === false) {
      fieldsUsed.push(source);
      return { state: 'not', source, token: 'false', fieldsUsed };
    }
  }

  return {
    state: 'unknown',
    source: null,
    token: null,
    fieldsUsed,
  };
}

function readKind(err) {
  const status = Number(err?.status);
  if (status === 404 || status === 501) return 'absent';
  return 'error';
}

async function readCompanionPath(fn) {
  if (typeof fn !== 'function') return { ok: false, data: null, absent: false };
  try {
    const data = await fn();
    return { ok: true, data: obj(data) || data || null, absent: false };
  } catch (err) {
    const kind = readKind(err);
    return { ok: false, data: null, absent: kind === 'absent' };
  }
}

/**
 * Overlay first; fill missing vision/landing/video from Companion GET paths.
 * 404/501 on landing is an honest not_implemented signal, not a detect.
 */
export async function collectCompanionVisionSignals({ overlay, client } = {}) {
  const o = obj(overlay) || {};
  let vision = obj(o.vision);
  let video = obj(o.video);
  let landing = obj(o.landing);
  let extras = obj(o.extras) || obj(o.diagnostics) || null;
  let visionResult = obj(o.visionResult);
  let landingPathAbsent = false;
  const live = { vision: false, video: false, landing: false, visionResult: false };

  if (client) {
    const needVision = !vision;
    const needVideo = !video;
    const needLanding = !landing;
    const [vRead, vidRead, lRead, rRead] = await Promise.all([
      needVision ? readCompanionPath(client.getStatusVision?.bind(client)) : Promise.resolve(null),
      needVideo ? readCompanionPath(client.getStatusVideo?.bind(client)) : Promise.resolve(null),
      needLanding ? readCompanionPath(client.getStatusLanding?.bind(client)) : Promise.resolve(null),
      !visionResult && needVision ? readCompanionPath(client.getVisionResult?.bind(client)) : Promise.resolve(null),
    ]);
    if (vRead?.ok && obj(vRead.data)) {
      vision = { ...vision, ...obj(vRead.data) };
      live.vision = true;
    }
    if (vidRead?.ok && obj(vidRead.data)) {
      video = { ...video, ...obj(vidRead.data) };
      live.video = true;
    }
    if (lRead?.absent) landingPathAbsent = true;
    if (lRead?.ok && obj(lRead.data)) {
      landing = { ...landing, ...obj(lRead.data) };
      live.landing = true;
    }
    if (rRead?.ok && obj(rRead.data)) {
      visionResult = { ...visionResult, ...obj(rRead.data) };
      live.visionResult = true;
      if (!vision) vision = obj(rRead.data);
    }
  }

  return {
    vision,
    video,
    landing,
    extras,
    visionResult,
    landingPathAbsent,
    live,
  };
}
