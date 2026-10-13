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

/** @type {Map<string, number>} */
const frames = new Map();

export function noteCompanionVideoFrame(camId, at = Date.now()) {
  const id = String(camId || '').trim().toLowerCase();
  if (!id) return;
  const ts = Number(at);
  frames.set(id, Number.isFinite(ts) ? ts : Date.now());
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
    const at = frames.get(id);
    if (!Number.isFinite(at)) continue;
    const age = nowMs - at;
    if (age >= 0 && age <= max) return { camId: id, at };
  }
  return null;
}

export function resetCompanionVideoReachForTests() {
  frames.clear();
}

function explicitVideoFlag(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
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

/** HTTP is up and the companion reports a camera, stream, or frame. Reachability alone is not video. */
export function companionHttpVideoHealthy(companion) {
  if (!companion || typeof companion !== 'object') return false;
  const httpUp = companion.jetson === 'reachable'
    || companion.jetson === 'mock'
    || companion.reachable === true;
  if (!httpUp) return false;
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
