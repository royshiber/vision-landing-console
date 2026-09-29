/**
 * ArduPlane follow-target for SITL only.
 * GUIDED orbit via DO_REPOSITION. Default off. A real vehicle never receives a command.
 */

export const FOLLOW_LIMITS = Object.freeze({
  minAglM: 60,
  maxHomeM: 2000,
  orbitRadiusM: 150,
  targetLossMs: 60_000,
  guidedMode: 15,
  rtlMode: 11,
  rcPwmDelta: 40,
});

const EARTH_M = 6378137;

export const FOLLOW_COPY = Object.freeze({
  off: 'כבוי. רק בסימולטור.',
  notSim: 'פועל רק מול סימולטור.',
  noLink: 'אין קישור לסימולטור.',
  banner: 'סימולטור בלבד',
  ready: 'מוכן לעקוב.',
  tracking: 'עוקבים אחרי המטרה במעגל.',
  rtl: 'אין מטרה. RTL.',
  cancelled: 'המעקב בוטל כי מצב שלט RC השתנה.',
  below: 'הגובה נמוך מדי. הפקודה נדחתה.',
  above: 'הגובה גבוה מדי. הפקודה נדחתה.',
  home: 'המטרה רחוקה מדי מהבית. הפקודה נדחתה.',
  fence: 'המטרה מחוץ לגדר. הפקודה נדחתה.',
  noHome: 'אין נקודת בית. הפקודה נדחתה.',
  noPosition: 'אין מיקום למטוס. הפקודה נדחתה.',
  noDetection: 'אין זיהוי במעקב.',
  stopped: 'המעקב נעצר.',
});

export function followTargetFlagOn(env = process.env) {
  const v = String(env.FOLLOW_TARGET_SITL ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function destinationPoint(lat, lon, bearing, distance) {
  const δ = distance / EARTH_M;
  const θ = (bearing * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );
  let lonOut = (λ2 * 180) / Math.PI;
  lonOut = ((lonOut + 540) % 360) - 180;
  return { lat: (φ2 * 180) / Math.PI, lon: lonOut };
}

function finite(n) {
  return Number.isFinite(Number(n));
}

/** ArduPilot FENCE_TYPE bits: alt max, circle, polygon, alt min. */
export function geofenceFromParams(params = {}) {
  const enable = Number(params.FENCE_ENABLE);
  if (enable !== 1) return { enabled: false, radiusM: null, altMaxM: null, altMinM: null, polygon: null };
  const typeRaw = params.FENCE_TYPE;
  const typeKnown = finite(typeRaw);
  const type = typeKnown ? Number(typeRaw) : 0;
  const circle = !typeKnown || (type & 2) !== 0;
  const polygonOn = typeKnown && (type & 4) !== 0;
  const altMaxOn = !typeKnown || (type & 1) !== 0;
  const altMinOn = typeKnown && (type & 8) !== 0;
  const radius = Number(params.FENCE_RADIUS);
  const altMax = Number(params.FENCE_ALT_MAX);
  const altMin = Number(params.FENCE_ALT_MIN);
  const polygon = polygonOn && Array.isArray(params.fencePolygon) ? params.fencePolygon : null;
  return {
    enabled: true,
    radiusM: circle && finite(radius) && radius > 0 ? radius : null,
    altMaxM: altMaxOn && finite(altMax) ? altMax : null,
    altMinM: altMinOn && finite(altMin) ? altMin : null,
    polygon,
  };
}

export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = Number(polygon[i].lat);
    const xi = Number(polygon[i].lon);
    const yj = Number(polygon[j].lat);
    const xj = Number(polygon[j].lon);
    const intersect = ((yi > point.lat) !== (yj > point.lat))
      && (point.lon < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function reasonMessage(reasons) {
  if (reasons.includes('fence_alt')) return FOLLOW_COPY.above;
  if (reasons.includes('below_agl')) return FOLLOW_COPY.below;
  if (reasons.includes('beyond_geofence') || reasons.includes('outside_polygon')) return FOLLOW_COPY.fence;
  if (reasons.includes('beyond_home') || reasons.includes('orbit_outside')) return FOLLOW_COPY.home;
  if (reasons.includes('no_home')) return FOLLOW_COPY.noHome;
  if (reasons.includes('no_position')) return FOLLOW_COPY.noPosition;
  return FOLLOW_COPY.fence;
}

export function horizontalLimits(point, home, fence) {
  const reasons = [];
  if (!home || !finite(home.lat) || !finite(home.lon)) {
    reasons.push('no_home');
    return { ok: false, reasons, homeM: null };
  }
  const homeM = distanceM(home.lat, home.lon, point.lat, point.lon);
  if (homeM > FOLLOW_LIMITS.maxHomeM) reasons.push('beyond_home');
  if (fence?.enabled && fence.radiusM != null && homeM > fence.radiusM) reasons.push('beyond_geofence');
  if (fence?.enabled && fence.polygon && fence.polygon.length >= 3 && !pointInPolygon(point, fence.polygon)) {
    reasons.push('outside_polygon');
  }
  return { ok: reasons.length === 0, reasons, homeM };
}

/**
 * Legal GUIDED orbit point. Altitude is at least 60 m AGL and inside the fence band.
 * Radius stays 150 m. The point must also sit inside 2 km from home and the geofence.
 */
export function planFollow({ vehicle, target, now = Date.now() } = {}) {
  const requested = finite(target?.altM) ? Number(target.altM) : FOLLOW_LIMITS.minAglM;
  if (requested < FOLLOW_LIMITS.minAglM) {
    return { ok: false, reasons: ['below_agl'], messageHe: FOLLOW_COPY.below, altM: requested };
  }
  const fence = geofenceFromParams(vehicle?.params || {});
  let altM = requested;
  if (fence.enabled && fence.altMinM != null) altM = Math.max(altM, fence.altMinM);
  if (altM < FOLLOW_LIMITS.minAglM) {
    return { ok: false, reasons: ['below_agl'], messageHe: FOLLOW_COPY.below, altM };
  }
  if (fence.enabled && fence.altMaxM != null && altM > fence.altMaxM) {
    return { ok: false, reasons: ['fence_alt'], messageHe: FOLLOW_COPY.above, altM };
  }
  if (!finite(target?.lat) || !finite(target?.lon)) {
    return { ok: false, reasons: ['no_position'], messageHe: FOLLOW_COPY.noPosition, altM };
  }
  const home = finite(vehicle?.homeLat) && finite(vehicle?.homeLon)
    ? { lat: Number(vehicle.homeLat), lon: Number(vehicle.homeLon) }
    : null;
  const targetPoint = { lat: Number(target.lat), lon: Number(target.lon) };
  const targetLimits = horizontalLimits(targetPoint, home, fence);
  if (!targetLimits.ok) {
    return { ok: false, reasons: targetLimits.reasons, messageHe: reasonMessage(targetLimits.reasons), altM };
  }
  if (!finite(vehicle?.lat) || !finite(vehicle?.lon)) {
    return { ok: false, reasons: ['no_position'], messageHe: FOLLOW_COPY.noPosition, altM };
  }
  const fit = circleFits(targetPoint, FOLLOW_LIMITS.orbitRadiusM, home, fence);
  if (!fit.ok) {
    return { ok: false, reasons: fit.reasons, messageHe: reasonMessage(fit.reasons), altM };
  }
  return {
    ok: true,
    reasons: [],
    messageHe: FOLLOW_COPY.tracking,
    altM,
    waypoint: { ...targetPoint, altM },
    radiusM: FOLLOW_LIMITS.orbitRadiusM,
    fenceEnabled: fence.enabled,
    now,
  };
}

/** The whole loiter circle must stay inside home and the geofence, not only its centre. */
function circleFits(center, radiusM, home, fence) {
  const reasons = [];
  if (!home || !finite(home.lat) || !finite(home.lon)) {
    return { ok: false, reasons: ['no_home'] };
  }
  const homeM = distanceM(home.lat, home.lon, center.lat, center.lon);
  if (homeM + radiusM > FOLLOW_LIMITS.maxHomeM + 0.5) reasons.push('beyond_home');
  if (fence?.enabled && fence.radiusM != null && homeM + radiusM > fence.radiusM + 0.5) {
    reasons.push('beyond_geofence');
  }
  if (fence?.enabled && fence.polygon && fence.polygon.length >= 3) {
    const points = [center];
    for (let step = 0; step < 16; step += 1) {
      points.push(destinationPoint(center.lat, center.lon, step * (360 / 16), radiusM));
    }
    if (points.some((point) => !pointInPolygon(point, fence.polygon))) reasons.push('outside_polygon');
  }
  return { ok: reasons.length === 0, reasons };
}

function rcSignature(rc) {
  if (!rc) return null;
  const chans = [];
  for (let i = 5; i <= 8; i += 1) {
    const raw = Number(rc[`chan${i}_raw`]);
    chans.push(Number.isFinite(raw) ? raw : null);
  }
  if (chans.every((n) => n == null)) return null;
  return chans;
}

export function rcModeChanged(baseline, rc) {
  if (!baseline || !rc) return false;
  const next = rcSignature(rc);
  if (!next) return false;
  for (let i = 0; i < baseline.length; i += 1) {
    if (baseline[i] == null || next[i] == null) continue;
    if (Math.abs(baseline[i] - next[i]) >= FOLLOW_LIMITS.rcPwmDelta) return true;
  }
  return false;
}

function publicState(extra) {
  return {
    enabled: extra.enabled === true,
    simulatorOnly: true,
    state: extra.state,
    messageHe: extra.messageHe,
    active: extra.state === 'tracking',
    altM: extra.altM ?? null,
    waypoint: extra.waypoint ?? null,
    target: extra.target ?? null,
    trackedDetection: extra.trackedDetection ?? null,
    limits: {
      minAglM: FOLLOW_LIMITS.minAglM,
      maxHomeM: FOLLOW_LIMITS.maxHomeM,
      orbitRadiusM: FOLLOW_LIMITS.orbitRadiusM,
      targetLossMs: FOLLOW_LIMITS.targetLossMs,
    },
  };
}

export function vehicleFromConnection(conn) {
  if (!conn) return { connected: false, simulator: false };
  let simulator = false;
  try {
    simulator = conn.simulatorDetection?.().simulator === true || conn.getStatus?.().simulator === true;
  } catch {
    simulator = false;
  }
  const g = conn.lastGlobalPos || {};
  const home = conn.lastHome || {};
  return {
    connected: conn.connected === true,
    simulator,
    lat: g.lat ?? null,
    lon: g.lon ?? null,
    altAglM: g.relativeAltM ?? null,
    homeLat: home.lat ?? null,
    homeLon: home.lon ?? null,
    customMode: conn.lastCustomMode ?? null,
    params: conn.params || {},
    rcChannels: conn.lastRcChannels || null,
  };
}

export function createFollowController({ link, enabled = () => false, now = () => Date.now() } = {}) {
  let target = null;
  let trackedDetection = null;
  let state = 'idle';
  let messageHe = FOLLOW_COPY.off;
  let lastWp = null;
  let seenGuided = false;
  let baselineRc = null;
  let rtlSent = false;

  function isOn() {
    return enabled() === true;
  }

  function idleOff() {
    return publicState({
      enabled: isOn(),
      state: isOn() ? state : 'off',
      messageHe: isOn() ? messageHe : FOLLOW_COPY.off,
      target: target ? { lat: target.lat, lon: target.lon, source: target.source } : null,
      trackedDetection,
      altM: target?.altM ?? null,
      waypoint: lastWp,
    });
  }

  function noteDetection(input) {
    if (!finite(input?.lat) || !finite(input?.lon)) {
      return { ok: false, messageHe: FOLLOW_COPY.noDetection, trackedDetection: null };
    }
    const stamp = now();
    trackedDetection = {
      lat: Number(input.lat),
      lon: Number(input.lon),
      altM: finite(input.altM) ? Number(input.altM) : FOLLOW_LIMITS.minAglM,
      updatedAt: stamp,
    };
    if (state === 'tracking' && target?.source === 'detection') {
      target.lat = trackedDetection.lat;
      target.lon = trackedDetection.lon;
      target.altM = trackedDetection.altM;
      target.updatedAt = stamp;
    }
    return { ok: true, trackedDetection, messageHe: state === 'tracking' ? FOLLOW_COPY.tracking : FOLLOW_COPY.ready };
  }

  function refuse(vehicle) {
    if (!isOn()) return { ok: false, ...idleOff(), messageHe: FOLLOW_COPY.off };
    if (!vehicle?.connected || vehicle.simulator !== true) {
      state = 'rejected';
      messageHe = vehicle?.connected ? FOLLOW_COPY.notSim : FOLLOW_COPY.noLink;
      return { ok: false, ...idleOff(), messageHe };
    }
    return null;
  }

  function selectTarget(input, vehicle) {
    const blocked = refuse(vehicle);
    if (blocked) return blocked;
    const source = input?.source === 'detection' ? 'detection' : 'map';
    const body = source === 'detection' && !finite(input?.lat) ? trackedDetection : input;
    const plan = planFollow({ vehicle, target: { ...body, source }, now: now() });
    if (!plan.ok) {
      state = 'rejected';
      messageHe = plan.messageHe;
      target = null;
      return { ok: false, ...idleOff(), messageHe, reasons: plan.reasons };
    }
    target = {
      lat: Number(body.lat),
      lon: Number(body.lon),
      altM: plan.altM,
      source,
      updatedAt: now(),
    };
    state = 'tracking';
    messageHe = FOLLOW_COPY.tracking;
    seenGuided = Number(vehicle.customMode) === FOLLOW_LIMITS.guidedMode;
    baselineRc = rcSignature(vehicle.rcChannels);
    rtlSent = false;
    lastWp = null;
    return tick(vehicle);
  }

  function stop() {
    state = 'idle';
    messageHe = FOLLOW_COPY.stopped;
    target = null;
    lastWp = null;
    seenGuided = false;
    rtlSent = false;
    return { ok: true, ...idleOff() };
  }

  function sendWaypoint(plan) {
    if (!plan?.ok || !plan.waypoint) return false;
    if (plan.altM < FOLLOW_LIMITS.minAglM) return false;
    if (plan.radiusM > FOLLOW_LIMITS.orbitRadiusM + 2) return false;
    if (typeof link?.flyTo !== 'function') return false;
    link.flyTo(plan.waypoint.lat, plan.waypoint.lon, plan.altM, {
      radiusM: plan.radiusM,
      changeMode: true,
    });
    lastWp = { ...plan.waypoint };
    return true;
  }

  function tick(vehicle) {
    if (!isOn()) {
      if (state === 'tracking') {
        state = 'idle';
        target = null;
      }
      messageHe = FOLLOW_COPY.off;
      return { ok: false, ...idleOff() };
    }
    if (state !== 'tracking' || !target) return { ok: state === 'idle', ...idleOff() };
    if (!vehicle?.connected || vehicle.simulator !== true) {
      state = 'cancelled';
      messageHe = FOLLOW_COPY.notSim;
      target = null;
      return { ok: false, ...idleOff() };
    }
    if (rcModeChanged(baselineRc, vehicle.rcChannels)) {
      state = 'cancelled';
      messageHe = FOLLOW_COPY.cancelled;
      target = null;
      return { ok: true, ...idleOff(), cancelled: 'rc' };
    }
    const mode = Number(vehicle.customMode);
    if (mode === FOLLOW_LIMITS.guidedMode) seenGuided = true;
    if (seenGuided && Number.isFinite(mode) && mode !== FOLLOW_LIMITS.guidedMode) {
      state = 'cancelled';
      messageHe = FOLLOW_COPY.cancelled;
      target = null;
      return { ok: true, ...idleOff(), cancelled: 'mode' };
    }
    const age = now() - target.updatedAt;
    if (age >= FOLLOW_LIMITS.targetLossMs) {
      if (!rtlSent && typeof link?.rtl === 'function') {
        link.rtl();
        rtlSent = true;
      }
      state = 'rtl';
      messageHe = FOLLOW_COPY.rtl;
      target = null;
      return { ok: true, ...idleOff(), rtl: true };
    }
    const plan = planFollow({ vehicle, target, now: now() });
    if (!plan.ok) {
      state = 'rejected';
      messageHe = plan.messageHe;
      target = null;
      return { ok: false, ...idleOff(), reasons: plan.reasons };
    }
    const moved = !lastWp || distanceM(lastWp.lat, lastWp.lon, plan.waypoint.lat, plan.waypoint.lon) > 20
      || lastWp.altM !== plan.altM;
    if (moved) {
      if (typeof link?.prepare === 'function' && link.prepare() === false) {
        return { ok: true, ...idleOff(), waypoint: lastWp };
      }
      sendWaypoint(plan);
    }
    messageHe = FOLLOW_COPY.tracking;
    return { ok: true, ...idleOff(), waypoint: lastWp };
  }

  return {
    noteDetection,
    selectTarget,
    stop,
    tick,
    status(vehicle) {
      const body = idleOff();
      const linked = vehicle?.connected === true && vehicle?.simulator === true;
      body.linked = linked;
      body.connected = vehicle?.connected === true;
      if (!isOn() || state !== 'idle' || messageHe === FOLLOW_COPY.stopped) return body;
      if (vehicle && !linked) body.messageHe = vehicle.connected ? FOLLOW_COPY.notSim : FOLLOW_COPY.noLink;
      else if (messageHe === FOLLOW_COPY.off) body.messageHe = FOLLOW_COPY.ready;
      return body;
    },
  };
}
