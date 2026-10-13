/**
 * Annotated video follows companion frames and camera health.
 * A MAVLink link role never decides whether cam0 is reachable.
 */
import {
  ANNOTATED_VIDEO_REASON_HE,
  annotatedStreamPresent,
  annotatedVideoAvailability,
} from './dual-link.mjs';

const FRAME_MAX_AGE_MS = 12000;
const HEALTH_MAX_AGE_MS = 12000;

/** @type {Map<string, { seq: number, at: number }>} */
const frames = new Map();

/**
 * A cached poll must not refresh reachability.
 * The sequence has to move forward, and the capture time has to be under 12s old.
 * @returns {boolean}
 */
export function noteCompanionVideoFrame(camId, info = {}) {
  const id = String(camId || '').trim().toLowerCase();
  if (!id) return false;
  const seq = Number(info?.seq);
  const capturedAt = Number(info?.capturedAt);
  const now = Number(info?.now);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  if (!Number.isFinite(seq)) return false;
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return false;
  const age = nowMs - capturedAt;
  if (age < 0 || age > FRAME_MAX_AGE_MS) return false;
  const prev = frames.get(id);
  if (prev && !(seq > prev.seq)) return false;
  frames.set(id, { seq, at: capturedAt });
  return true;
}

export function recentCompanionVideoFrame({
  camId = '',
  now = Date.now(),
  maxAgeMs = FRAME_MAX_AGE_MS,
} = {}) {
  const nowMs = Number(now);
  const max = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : FRAME_MAX_AGE_MS;
  const wanted = String(camId || '').trim().toLowerCase();
  const ids = wanted ? [wanted] : [...frames.keys()];
  for (const id of ids) {
    const row = frames.get(id);
    const at = row?.at;
    if (!Number.isFinite(at)) continue;
    const age = nowMs - at;
    if (age >= 0 && age <= max) return { camId: id, at, seq: row.seq };
  }
  return null;
}

export function resetCompanionVideoReachForTests() {
  frames.clear();
}

const CAMERA_ERROR_STATES = new Set(['error', 'failed', 'fault', 'offline', 'unavailable', 'absent']);

export function cameraNodeInError(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const state = String(node.state || node.status || node.camera_state || node.cameraState || '').toLowerCase();
  if (CAMERA_ERROR_STATES.has(state)) return true;
  if (node.camera_error === true || node.cameraError === true || node.cam_error === true) return true;
  if (typeof node.error === 'string' && node.error.trim()) return true;
  if (node.error === true) return true;
  return false;
}

function treeHasCameraError(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((item) => treeHasCameraError(item, seen));
  if (cameraNodeInError(node)) return true;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object' && treeHasCameraError(value, seen)) return true;
  }
  return false;
}

function healthAgeMs(companion, now) {
  const health = companion?.health && typeof companion.health === 'object' ? companion.health : {};
  const age = Number(health.age_ms ?? health.ageMs ?? companion?.healthAgeMs);
  if (Number.isFinite(age) && age >= 0) return age;
  const at = Number(
    health.at ?? health.ts ?? health.checkedAt ?? health.checked_at ?? companion?.healthAt,
  );
  if (Number.isFinite(at) && at > 0) return Math.max(0, now - at);
  return null;
}

function explicitVideoFlag(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  if (cameraNodeInError(node)) return false;
  if (node.camera_ok === true || node.cameraOk === true) return true;
  if (node.has_frame === true || node.hasFrame === true) return true;
  if (node.video_ok === true || node.videoOk === true) return true;
  if (node.cameras_ok === true || node.camerasOk === true) return true;
  const state = String(node.state || '').toLowerCase();
  const cameraLike = node.id != null || node.role != null || node.camera_ok != null || node.cameraOk != null;
  if (cameraLike && (state === 'streaming' || state === 'live')) return true;
  const fps = Number(node.fps ?? node.annotated_fps ?? node.annotatedFps);
  if (cameraLike && Number.isFinite(fps) && fps > 0) return true;
  return false;
}

function bagHasVideo(bag) {
  if (!bag) return false;
  if (Array.isArray(bag)) return bag.some((item) => explicitVideoFlag(item));
  if (explicitVideoFlag(bag)) return true;
  if (typeof bag !== 'object') return false;
  for (const key of ['vision', 'video', 'cam0', 'cameras', 'camera']) {
    if (bagHasVideo(bag[key])) return true;
  }
  return false;
}

/** HTTP is up, the health sample is under 12s old, and no camera is in an error state. */
export function companionHttpVideoHealthy(companion, now = Date.now()) {
  if (!companion || typeof companion !== 'object') return false;
  const httpUp = companion.jetson === 'reachable'
    || companion.jetson === 'mock'
    || companion.reachable === true;
  if (!httpUp) return false;
  const age = healthAgeMs(companion, Number(now) || Date.now());
  if (age == null || age > HEALTH_MAX_AGE_MS) return false;
  const roots = [
    companion.health,
    companion.overlay,
    companion.vision,
    companion.video,
    companion.cam0,
    companion.cameras,
  ];
  if (roots.some((root) => treeHasCameraError(root))) return false;
  if (annotatedStreamPresent(companion)) return true;
  return bagHasVideo(companion.health)
    || bagHasVideo(companion.overlay)
    || bagHasVideo(companion.vision)
    || bagHasVideo(companion.video)
    || bagHasVideo(companion.cam0)
    || bagHasVideo(companion.cameras);
}

/**
 * Recent JPEG or companion camera health wins over the MAVLink role.
 * With neither, the existing cellular/modem/stream gate stays honest.
 */
export function resolveOperatorVideoAvailability({
  cellular,
  modemPresent,
  streamPresent = false,
  companion = null,
  recentFrame = null,
} = {}) {
  const base = annotatedVideoAvailability({ cellular, modemPresent, streamPresent });
  const frame = recentFrame === true || (recentFrame != null && typeof recentFrame === 'object');
  const health = companionHttpVideoHealthy(companion);
  if (!frame && !health) return { ...base, via: null };
  return {
    available: true,
    path: 'cellular',
    neverRadio: true,
    radioSatisfies: false,
    streamPresent: true,
    reason: 'cellular_connected',
    reasonHe: ANNOTATED_VIDEO_REASON_HE.cellular_connected,
    via: frame ? 'frame' : 'health',
  };
}
