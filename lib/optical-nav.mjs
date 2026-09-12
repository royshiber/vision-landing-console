/**
 * Optical navigation — display/logging honesty only.
 * Never invents WGS84, never switches FC/EKF source, never enables EKF inject.
 */

export const OPTICAL_NAV_ALT_CEILING_M = 300;
export const NAV_DISPLAY_GPS = 'gps';
export const NAV_DISPLAY_OPTICAL = 'optical';
export const NAV_DISPLAY_STORAGE_KEY = 'visionLandingNavDisplayV1';

export const OPTICAL_NAV_NOTE_STUB =
  'observe-only optical-nav stub; no cameras / estimator; position null; not EKF fused';

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function cameraStub(raw, role) {
  const cam = obj(raw) || {};
  return {
    id: typeof cam.id === 'string' && cam.id ? cam.id : null,
    role,
    shared_with: cam.shared_with || cam.sharedWith || 'landing_vision',
    camera_ok: boolOrNull(cam.camera_ok ?? cam.cameraOk) === true,
  };
}

/**
 * Empty honest optical-nav object. Position/velocity stay null.
 */
export function emptyOpticalNav(overrides = {}) {
  return {
    present: false,
    running: false,
    camera_ok: false,
    alt_ceiling_m: OPTICAL_NAV_ALT_CEILING_M,
    lat: null,
    lon: null,
    alt_m: null,
    position: null,
    velocity: null,
    age_ms: null,
    confidence: null,
    ekf_injected: false,
    display_only: true,
    cameras: {
      cam1: { id: 'cam1', role: 'vio_forward', shared_with: 'landing_vision', camera_ok: false },
      cam2: { id: 'cam2', role: 'optical_flow_down', shared_with: 'landing_vision', camera_ok: false },
    },
    note: OPTICAL_NAV_NOTE_STUB,
    ...overrides,
  };
}

function readWgs84(raw) {
  const src = obj(raw) || {};
  const pos = obj(src.position) || obj(src.position_wgs84) || obj(src.wgs84) || {};
  const lat = finiteOrNull(pos.lat ?? pos.latitude ?? src.lat ?? src.navLat);
  const lon = finiteOrNull(pos.lon ?? pos.lng ?? pos.longitude ?? src.lon ?? src.navLon);
  const alt_m = finiteOrNull(pos.alt_m ?? pos.alt ?? pos.altitude_m ?? src.alt_m);
  if (lat == null || lon == null) return { lat: null, lon: null, alt_m: null, position: null };
  return {
    lat,
    lon,
    alt_m,
    position: { lat, lon, alt_m },
  };
}

/**
 * Map a Companion optical-nav / extras blob. Never promotes NED position_m to lat/lon.
 */
export function normalizeOpticalNav(raw) {
  const src = obj(raw) || {};
  const camerasIn = obj(src.cameras) || {};
  const wgs = readWgs84(src);
  const cameraOk = boolOrNull(src.camera_ok ?? src.cameraOk);
  const running = boolOrNull(src.running);
  const present = boolOrNull(src.present);
  const ageMs = finiteOrNull(src.age_ms ?? src.ageMs);
  const confidence = finiteOrNull(src.confidence ?? obj(src.quality)?.confidence);
  const vel = Array.isArray(src.velocity)
    ? src.velocity
    : Array.isArray(src.velocity_m_s)
      ? src.velocity_m_s
      : null;
  const cam1 = cameraStub(camerasIn.cam1, 'vio_forward');
  const cam2 = cameraStub(camerasIn.cam2, 'optical_flow_down');
  if (!cam1.id) cam1.id = 'cam1';
  if (!cam2.id) cam2.id = 'cam2';

  return {
    present: present === true,
    running: running === true,
    camera_ok: cameraOk === true,
    alt_ceiling_m: finiteOrNull(src.alt_ceiling_m ?? src.altCeilingM) ?? OPTICAL_NAV_ALT_CEILING_M,
    lat: wgs.lat,
    lon: wgs.lon,
    alt_m: wgs.alt_m,
    position: wgs.position,
    velocity: vel,
    age_ms: ageMs,
    confidence: confidence != null && confidence === 0 && running !== true ? null : confidence,
    ekf_injected: false,
    display_only: true,
    cameras: { cam1, cam2 },
    note: typeof src.note === 'string' && src.note.trim() ? src.note.trim() : OPTICAL_NAV_NOTE_STUB,
  };
}

/** Real optical fix for display — cameras + estimator + finite WGS84. */
export function opticalNavHasFix(nav) {
  const n = obj(nav) || {};
  return n.camera_ok === true
    && n.running === true
    && Number.isFinite(n.lat)
    && Number.isFinite(n.lon);
}

export function resolveNavDisplayPreference(value) {
  return String(value || '').trim().toLowerCase() === NAV_DISPLAY_OPTICAL
    ? NAV_DISPLAY_OPTICAL
    : NAV_DISPLAY_GPS;
}

/**
 * Display/logging pick. Optical wins only with a real fix. Never invents coords.
 * @returns {{ source: 'gps'|'optical'|null, lat: number|null, lon: number|null, opticalAvailable: boolean }}
 */
export function selectDisplayFix({ preference, gps, optical } = {}) {
  const pref = resolveNavDisplayPreference(preference);
  const gpsLat = finiteOrNull(gps?.lat ?? gps?.gpsLat);
  const gpsLon = finiteOrNull(gps?.lon ?? gps?.gpsLon);
  const gpsOk = gpsLat != null && gpsLon != null;
  const opt = normalizeOpticalNav(optical);
  const opticalOk = opticalNavHasFix(opt);

  if (pref === NAV_DISPLAY_OPTICAL) {
    if (opticalOk) {
      return { source: NAV_DISPLAY_OPTICAL, lat: opt.lat, lon: opt.lon, opticalAvailable: true };
    }
    return { source: null, lat: null, lon: null, opticalAvailable: false };
  }
  if (gpsOk) {
    return { source: NAV_DISPLAY_GPS, lat: gpsLat, lon: gpsLon, opticalAvailable: opticalOk };
  }
  return { source: null, lat: null, lon: null, opticalAvailable: opticalOk };
}

/**
 * Compact Hebrew status for Mission. Unknown stays --. Never invents a fix.
 */
export function opticalNavStatusHe(nav) {
  const n = obj(nav);
  if (!n) return { text: '--', title: 'אין דיווח ניווט אופטי' };
  if (n.camera_ok !== true) {
    return { text: '--', title: 'אין מצלמה לניווט אופטי' };
  }
  if (n.running !== true) {
    return { text: '--', title: 'אומדן אופטי לא רץ' };
  }
  if (!opticalNavHasFix(n)) {
    const age = Number.isFinite(n.age_ms) ? `גיל ${Math.round(n.age_ms)}ms` : 'אין מיקום';
    return { text: '--', title: `אופטי רץ. ${age}` };
  }
  const pct = Number.isFinite(n.confidence) ? `${Math.round(n.confidence * 100)}%` : '';
  const age = Number.isFinite(n.age_ms) ? ` · ${Math.round(n.age_ms)}ms` : '';
  return {
    text: pct || 'פעיל',
    title: pct ? `אופטי פעיל · ביטחון ${pct}${age}` : `אופטי פעיל${age}`,
  };
}
