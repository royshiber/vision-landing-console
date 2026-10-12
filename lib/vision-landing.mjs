/**
 * Vision landing.
 * Path A: the active mission item is NAV_LAND and the mode stays AUTO.
 *   Roll only, after the confidence dwell. Altitude stays with the mission.
 * Path B: the optical-land button. SITL only. SET_MODE GUIDED, then a
 *   glide toward the runway threshold, then one NAV_LAND so ArduPlane flares.
 * Cancel is a mode change away from AUTO or GUIDED, a hazard go-around,
 * or a link-loss release. Level 4 stays locked.
 */

export const MAV_CMD_NAV_LAND = 21;
export const MAV_CMD_DO_GO_AROUND = 191;
export const MAV_CMD_DO_REPOSITION = 192;
export const PLANE_MODE_AUTO = 10;
export const PLANE_MODE_GUIDED = 15;
export const OPTICAL_GLIDE_DEG = 3;
export const OPTICAL_HANDOFF_M = 80;

export const VISION_LAND_LABEL = Object.freeze({
  waiting: 'ממתין',
  active: 'נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה',
  released: 'שוחרר',
  go_around: 'סבוב מחדש',
  blocked: 'אין מסלול במסגרת',
});

export const VISION_LAND_DEFAULTS = Object.freeze({
  confidence: 0.7,
  holdMs: 2000,
  minAltM: 8,
  maxAltM: 120,
  minDistM: 40,
  maxDistM: 1800,
  goAroundAltM: 20,
  maxOffsetM: 12,
  maxOffsetNorm: 0.5,
  glideDeg: OPTICAL_GLIDE_DEG,
  handoffM: OPTICAL_HANDOFF_M,
});

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function readVisionLandLimits(env = process.env) {
  const d = VISION_LAND_DEFAULTS;
  return {
    confidence: num(env.VLC_VISION_LAND_CONFIDENCE, d.confidence),
    holdMs: num(env.VLC_VISION_LAND_HOLD_MS, d.holdMs),
    minAltM: num(env.VLC_VISION_LAND_MIN_ALT_M, d.minAltM),
    maxAltM: num(env.VLC_VISION_LAND_MAX_ALT_M, d.maxAltM),
    minDistM: num(env.VLC_VISION_LAND_MIN_DIST_M, d.minDistM),
    maxDistM: num(env.VLC_VISION_LAND_MAX_DIST_M, d.maxDistM),
    goAroundAltM: num(env.VLC_VISION_LAND_GO_AROUND_ALT_M, d.goAroundAltM),
    maxOffsetM: num(env.VLC_VISION_LAND_MAX_OFFSET_M, d.maxOffsetM),
    maxOffsetNorm: num(env.VLC_VISION_LAND_MAX_OFFSET_NORM, d.maxOffsetNorm),
    glideDeg: num(env.VLC_VISION_LAND_GLIDE_DEG, d.glideDeg),
    handoffM: num(env.VLC_VISION_LAND_HANDOFF_M, d.handoffM),
  };
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const aLat = Number(lat1);
  const aLon = Number(lon1);
  const bLat = Number(lat2);
  const bLon = Number(lon2);
  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return null;
  const earth = 6378137;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = ((bLat - aLat) * Math.PI) / 180;
  const dl = ((bLon - aLon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Landing phase: the last mission item is NAV_LAND, and that item is
 * the active waypoint.
 */
export function missionLandingPhase(items, current) {
  const list = Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : [];
  if (!list.length) return { active: false, land: null, approach: null };
  const sorted = [...list].sort((a, b) => Number(a.seq) - Number(b.seq));
  const land = sorted[sorted.length - 1];
  if (Number(land.command) !== MAV_CMD_NAV_LAND) return { active: false, land: null, approach: null };
  const approach = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
  const cur = Number(current);
  const landSeq = Number(land.seq);
  const approachSeq = approach == null ? null : Number(approach.seq);
  const active = Number.isFinite(cur) && cur === landSeq;
  return { active, land, approach, landSeq, approachSeq };
}

export function runwayConfidence(estimate) {
  if (!estimate || estimate.detected !== true) return 0;
  const raw = estimate.confidence;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parts = [Number(raw?.offset), Number(raw?.heading)].filter(Number.isFinite);
  if (!parts.length) return 0;
  return Math.min(...parts);
}

/**
 * Glide target in GUIDED. Altitude is relative to home, on a 3 degree
 * slope, and never above the aircraft. The horizontal aim is the threshold.
 * Inside the handoff distance ArduPlane's NAV_LAND owns the flare.
 */
export function opticalGlideTarget({
  lat,
  lon,
  altAglM,
  thresholdLat,
  thresholdLon,
  glideDeg = OPTICAL_GLIDE_DEG,
  handoffM = OPTICAL_HANDOFF_M,
} = {}) {
  const dist = distanceM(lat, lon, thresholdLat, thresholdLon);
  const tLat = Number(thresholdLat);
  const tLon = Number(thresholdLon);
  if (dist == null || !Number.isFinite(tLat) || !Number.isFinite(tLon)) return null;
  const slope = Math.tan((Number(glideDeg) * Math.PI) / 180);
  const glideAlt = dist * (Number.isFinite(slope) ? slope : 0);
  const current = Number(altAglM);
  const altM = Math.max(0, Number.isFinite(current) ? Math.min(current, glideAlt) : glideAlt);
  return {
    lat: tLat,
    lon: tLon,
    altM,
    distM: dist,
    handoff: dist <= Number(handoffM),
  };
}

function thresholdOf(estimate, phase) {
  const lat = Number(estimate?.threshold_lat ?? phase?.land?.lat);
  const lon = Number(estimate?.threshold_lon ?? phase?.land?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function landDistanceM(vehicle, phase) {
  const given = Number(vehicle?.distToLandM);
  if (Number.isFinite(given)) return given;
  const land = phase?.land;
  if (!land) return null;
  return distanceM(vehicle?.lat, vehicle?.lon, land.lat, land.lon);
}

function labelFor(state) {
  return VISION_LAND_LABEL[state] || VISION_LAND_LABEL.waiting;
}

export function createVisionLandingSession({ limits = VISION_LAND_DEFAULTS } = {}) {
  let optical = false;
  let sawGuided = false;
  let landSent = false;
  let buttonSince = null;
  let confidentSince = null;
  let latched = null;
  let posture = 'waiting';

  function resetAttempt() {
    latched = null;
    confidentSince = null;
    landSent = false;
    sawGuided = false;
  }

  function setOptical(on) {
    const next = on === true;
    if (optical && !next) resetAttempt();
    optical = next;
    if (!next) {
      sawGuided = false;
      landSent = false;
    }
    return optical;
  }

  function updateButton(estimate, now) {
    const stamp = Number(now) || 0;
    const seen = estimate?.detected === true && runwayConfidence(estimate) >= limits.confidence;
    if (!seen) {
      buttonSince = null;
      return false;
    }
    if (buttonSince == null) buttonSince = stamp;
    return stamp - buttonSince >= limits.holdMs;
  }

  function pack(extra) {
    return {
      manualArm: optical,
      optical,
      buttonReady: extra.buttonReady === true,
      phase: extra.phase === true,
      ...extra,
    };
  }

  function plan({
    level = 0,
    sitl = false,
    unlock = false,
    confirmed = false,
    estimate = null,
    vehicle = null,
    holding = false,
    now = 0,
    rollPwm = null,
  } = {}) {
    const stamp = Number(now) || 0;
    const buttonReady = updateButton(estimate, stamp);
    const phase = missionLandingPhase(vehicle?.missionItems, vehicle?.missionCurrent);
    const dist = landDistanceM(vehicle, phase);
    const shaped = { ...(vehicle || {}), distToLandM: dist };
    const mode = Number(shaped.customMode);
    const levelOk = Number(level) === 3 || (Number(level) === 4 && unlock === true && confirmed === true);
    const guidanceAllowed = levelOk && sitl === true;
    const base = {
      buttonReady,
      manualArm: optical,
      optical,
      phase: phase.active || optical,
    };

    if (latched === 'go_around') {
      posture = 'go_around';
      return pack({ ...base, action: null, state: 'go_around', labelHe: labelFor('go_around'), reason: 'go_around' });
    }
    if (latched === 'cancel') {
      posture = 'released';
      return pack({ ...base, action: null, state: 'released', labelHe: labelFor('released'), reason: 'cancel' });
    }

    if (!optical && !phase.active) {
      confidentSince = null;
      if (holding && sitl) {
        posture = 'released';
        return pack({ ...base, action: 'release', state: 'released', labelHe: labelFor('released'), reason: 'phase' });
      }
      posture = posture === 'released' ? 'released' : 'waiting';
      return pack({ ...base, action: null, state: posture, labelHe: labelFor(posture), reason: 'phase' });
    }

    if (!guidanceAllowed) {
      confidentSince = null;
      if (holding && sitl) {
        posture = 'released';
        return pack({ ...base, action: 'release', state: 'released', labelHe: labelFor('released'), reason: sitl ? 'level' : 'not_sitl' });
      }
      posture = 'waiting';
      return pack({
        ...base,
        action: null,
        state: 'waiting',
        labelHe: labelFor('waiting'),
        reason: sitl ? 'level' : 'not_sitl',
      });
    }

    if (optical && sawGuided && mode !== PLANE_MODE_GUIDED) {
      latched = 'cancel';
      confidentSince = null;
      posture = 'released';
      return pack({
        ...base,
        action: holding ? 'release' : null,
        state: 'released',
        labelHe: labelFor('released'),
        reason: 'mode',
      });
    }

    if (!optical && phase.active && mode !== PLANE_MODE_AUTO) {
      confidentSince = null;
      if (holding || posture === 'active') {
        latched = 'cancel';
        posture = 'released';
        return pack({
          ...base,
          action: holding ? 'release' : null,
          state: 'released',
          labelHe: labelFor('released'),
          reason: 'mode',
        });
      }
      posture = 'waiting';
      return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'mode' });
    }

    if (shaped.connected === false) {
      confidentSince = null;
      if (holding) {
        posture = 'released';
        return pack({ ...base, action: 'release', state: 'released', labelHe: labelFor('released'), reason: 'link' });
      }
      posture = 'waiting';
      return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'link' });
    }

    const hazards = Array.isArray(estimate?.hazards) ? estimate.hazards : [];
    const alt = Number(shaped.altAglM);
    const offsetM = Number(estimate?.offset_m);
    const offsetNorm = Number(estimate?.offset_norm);
    const low = Number.isFinite(alt) && alt < limits.goAroundAltM;
    const wide = (Number.isFinite(offsetM) && Math.abs(offsetM) >= limits.maxOffsetM)
      || (!Number.isFinite(offsetM) && Number.isFinite(offsetNorm) && Math.abs(offsetNorm) >= limits.maxOffsetNorm);
    if (hazards.length > 0 || (low && wide)) {
      latched = 'go_around';
      confidentSince = null;
      posture = 'go_around';
      return pack({
        ...base,
        action: 'go_around',
        release: holding === true,
        state: 'go_around',
        labelHe: labelFor('go_around'),
        reason: hazards.length > 0 ? 'hazard' : 'lateral',
      });
    }

    if (optical) {
      if (mode === PLANE_MODE_GUIDED) sawGuided = true;
      if (!sawGuided) {
        posture = 'waiting';
        return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'guided_wait' });
      }
      const point = thresholdOf(estimate, phase);
      const glide = point ? opticalGlideTarget({
        lat: shaped.lat,
        lon: shaped.lon,
        altAglM: shaped.altAglM,
        thresholdLat: point.lat,
        thresholdLon: point.lon,
        glideDeg: limits.glideDeg,
        handoffM: limits.handoffM,
      }) : null;
      if (!glide) {
        if (holding) {
          posture = 'released';
          return pack({ ...base, action: 'release', state: 'released', labelHe: labelFor('released'), reason: 'no_threshold' });
        }
        posture = 'waiting';
        return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'no_threshold' });
      }
      posture = 'active';
      if (landSent) {
        return pack({
          ...base,
          action: null,
          state: 'active',
          labelHe: labelFor('active'),
          reason: 'land',
          lat: glide.lat,
          lon: glide.lon,
        });
      }
      if (glide.handoff) {
        landSent = true;
        return pack({
          ...base,
          action: 'land',
          state: 'active',
          labelHe: labelFor('active'),
          reason: 'land',
          lat: glide.lat,
          lon: glide.lon,
          altM: 0,
        });
      }
      return pack({
        ...base,
        action: 'reposition',
        state: 'active',
        labelHe: labelFor('active'),
        reason: 'glide',
        lat: glide.lat,
        lon: glide.lon,
        altM: glide.altM,
      });
    }

    const conf = runwayConfidence(estimate);
    const envOk = Number.isFinite(alt)
      && alt >= limits.minAltM
      && alt <= limits.maxAltM
      && Number.isFinite(dist)
      && dist >= limits.minDistM
      && dist <= limits.maxDistM;
    const ready = estimate?.detected === true && conf >= limits.confidence && envOk && rollPwm != null;
    if (!ready) {
      confidentSince = null;
      if (holding) {
        posture = 'released';
        const reason = estimate?.detected !== true || conf < limits.confidence ? 'runway_lost' : 'envelope';
        return pack({ ...base, action: 'release', state: 'released', labelHe: labelFor('released'), reason });
      }
      const state = posture === 'released' ? 'released' : 'waiting';
      return pack({ ...base, action: null, state, labelHe: labelFor(state), reason: 'dwell' });
    }

    if (confidentSince == null) confidentSince = stamp;
    if (stamp - confidentSince < limits.holdMs) {
      posture = 'waiting';
      return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'dwell' });
    }

    posture = 'active';
    return pack({
      ...base,
      action: 'guide',
      rollPwm,
      state: 'active',
      labelHe: labelFor('active'),
      reason: 'guide',
    });
  }

  return {
    plan,
    observe: updateButton,
    setOptical,
    setManualArm: setOptical,
    manualArm: () => optical,
    optical: () => optical,
  };
}
