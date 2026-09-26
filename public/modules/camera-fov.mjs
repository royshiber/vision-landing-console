/** Per-camera field of view. Geometry uses this saved value, never a fixed focal length. */

export const FOV_MIN = 20;
export const FOV_MAX = 180;
export const FOV_DEFAULTS = Object.freeze({ cam0: 120, cam1: 79 });
export const FOV_STORAGE_KEY = 'vlc.camera.fov.v1';
/** Same board size the companion marker pose uses when no other size is set. */
export const MARKER_SIZE_M = 0.16;

export function parseFov(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n < FOV_MIN || n > FOV_MAX) return { ok: false, value: null };
  return { ok: true, value: n };
}

export function readStoredFov(storage, camId) {
  const fallback = FOV_DEFAULTS[camId] ?? FOV_DEFAULTS.cam0;
  if (!storage || typeof storage.getItem !== 'function') return fallback;
  try {
    const raw = storage.getItem(FOV_STORAGE_KEY);
    if (raw == null || raw === '') return fallback;
    const parsed = JSON.parse(raw);
    const check = parseFov(parsed?.[camId]);
    return check.ok ? check.value : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredFov(storage, camId, value) {
  const fallback = FOV_DEFAULTS[camId] ?? FOV_DEFAULTS.cam0;
  const check = parseFov(value);
  if (!check.ok) return { ok: false, value: readStoredFov(storage, camId) || fallback };
  let current = {};
  try {
    const raw = storage?.getItem?.(FOV_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch {
    current = {};
  }
  current[camId] = check.value;
  storage.setItem(FOV_STORAGE_KEY, JSON.stringify(current));
  return { ok: true, value: check.value };
}

/**
 * Horizontal field of view, square pixels.
 * fx = (width / 2) / tan(fov / 2). 180° stays finite.
 */
export function intrinsicsFromFov(width, height, fovDeg) {
  const check = parseFov(fovDeg);
  const w = Number(width);
  const h = Number(height);
  if (!check.ok || !(w > 0) || !(h > 0)) return null;
  const limited = Math.min(check.value, 179.999);
  const half = (limited * Math.PI / 180) / 2;
  const fx = (w / 2) / Math.tan(half);
  if (!Number.isFinite(fx) || fx <= 0) return null;
  return {
    fx,
    fy: fx,
    cx: (w - 1) / 2,
    cy: (h - 1) / 2,
    fov_deg: check.value,
  };
}

export function cornerSpanPx(corners) {
  if (!Array.isArray(corners) || corners.length < 4) return null;
  const pts = corners.slice(0, 4).map((p) => [Number(p?.[0]), Number(p?.[1])]);
  if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  const edge = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const span = (edge(pts[0], pts[1]) + edge(pts[1], pts[2]) + edge(pts[2], pts[3]) + edge(pts[3], pts[0])) / 4;
  return span > 0 ? span : null;
}

/** Pinhole distance from the saved horizontal FOV. Returns null when the span is missing. */
export function distanceMFromCorners(corners, imageWidth, fovDeg, markerSizeM = MARKER_SIZE_M) {
  const span = cornerSpanPx(corners);
  const k = intrinsicsFromFov(imageWidth, imageWidth, fovDeg);
  const size = Number(markerSizeM);
  if (!k || span == null || !(size > 0)) return null;
  const distance = (k.fx * size) / span;
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}
