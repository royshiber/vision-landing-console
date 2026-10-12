/**
 * Vision landing.
 * Path A: the active mission item is NAV_LAND and the mode stays AUTO.
 *   Roll only, after the confidence dwell. Altitude stays with the mission.
 * Path B: the optical-land button. SITL only. SET_MODE GUIDED, then a
 *   glide toward the runway threshold. Inside the handoff the console
 *   switches to AUTO and jumps to DO_LAND_START or the NAV_LAND item.
 *   A rejected jump climbs out or returns home. NAV_LAND is never sent
 *   while the mode is GUIDED.
 * A console mode change is part of the flow. A pilot mode change cancels.
 * Level 4 stays locked.
 */

import { bearingDeg, destinationPoint } from './follow-target.mjs';

export const MAV_CMD_NAV_LAND = 21;
export const MAV_CMD_DO_LAND_START = 189;
export const MAV_CMD_DO_GO_AROUND = 191;
export const MAV_CMD_DO_REPOSITION = 192;
export const PLANE_MODE_AUTO = 10;
export const PLANE_MODE_RTL = 11;
export const PLANE_MODE_GUIDED = 15;
export const OPTICAL_GLIDE_DEG = 3;
export const OPTICAL_HANDOFF_M = 80;
export const OPTICAL_GLIDE_FLOOR_M = 15;
export const OPTICAL_CLIMB_ALT_M = 60;
export const OPTICAL_CLIMB_AHEAD_M = 450;
export const ALT_STALE_MS = 1500;

export const VISION_LAND_LABEL = Object.freeze({
  waiting: 'ממתין',
  active: 'נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה',
  active_short: 'אופטית פעילה',
  released: 'שוחרר',
  go_around: 'סבוב מחדש',
  blocked: 'אין מסלול במסגרת',
  no_land: 'אין נחיתה במשימה',
  level: 'רמה 3 נדרשת לנחיתה אופטית',
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
  glideFloorM: OPTICAL_GLIDE_FLOOR_M,
  climbAltM: OPTICAL_CLIMB_ALT_M,
  climbAheadM: OPTICAL_CLIMB_AHEAD_M,
  altStaleMs: ALT_STALE_MS,
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
    glideFloorM: num(env.VLC_VISION_LAND_GLIDE_FLOOR_M, d.glideFloorM),
    climbAltM: num(env.VLC_VISION_LAND_CLIMB_ALT_M, d.climbAltM),
    climbAheadM: num(env.VLC_VISION_LAND_CLIMB_AHEAD_M, d.climbAheadM),
    altStaleMs: num(env.VLC_VISION_LAND_ALT_STALE_MS, d.altStaleMs),
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
 * Glide target in GUIDED. The slope is 3 degrees toward the threshold.
 * The commanded altitude stays at or above the floor until AUTO takes over.
 * An unknown aircraft altitude returns null so the caller sends nothing.
 */
export function opticalGlideTarget({
  lat,
  lon,
  altAglM,
  thresholdLat,
  thresholdLon,
  glideDeg = OPTICAL_GLIDE_DEG,
  handoffM = OPTICAL_HANDOFF_M,
  floorM = OPTICAL_GLIDE_FLOOR_M,
} = {}) {
  const dist = distanceM(lat, lon, thresholdLat, thresholdLon);
  const tLat = Number(thresholdLat);
  const tLon = Number(thresholdLon);
  const current = Number(altAglM);
  if (dist == null || !Number.isFinite(tLat) || !Number.isFinite(tLon)) return null;
  if (altAglM == null || altAglM === '' || !Number.isFinite(current)) return null;
  const slope = Math.tan((Number(glideDeg) * Math.PI) / 180);
  const glideAlt = dist * (Number.isFinite(slope) ? slope : 0);
  const floor = Number(floorM);
  const altM = Math.max(Number.isFinite(floor) ? floor : OPTICAL_GLIDE_FLOOR_M, Math.min(current, glideAlt));
  if (!(altM > 0)) return null;
  return {
    lat: tLat,
    lon: tLon,
    altM,
    distM: dist,
    handoff: dist <= Number(handoffM),
  };
}

export function missionHasNavLand(items) {
  return Array.isArray(items) && items.some((item) => Number(item?.command) === MAV_CMD_NAV_LAND);
}

/** Jump target for the final phase. DO_LAND_START when the marker exists, else the NAV_LAND seq. */
export function missionLandJump(items) {
  const list = Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : [];
  const land = [...list].reverse().find((item) => Number(item.command) === MAV_CMD_NAV_LAND);
  if (!land || !Number.isFinite(Number(land.seq))) return null;
  const marker = list.find((item) => Number(item.command) === MAV_CMD_DO_LAND_START);
  return {
    landSeq: Number(land.seq),
    lat: Number(land.lat),
    lon: Number(land.lon),
    useDoLandStart: Boolean(marker),
  };
}

export function altFresh(vehicle, now, staleMs = ALT_STALE_MS) {
  const raw = vehicle?.altAglM;
  const alt = Number(raw);
  const at = Number(vehicle?.altAt);
  const stamp = Number(now);
  if (raw == null || raw === '' || !Number.isFinite(alt) || !Number.isFinite(at) || !Number.isFinite(stamp)) return false;
  const age = stamp - at;
  return age >= 0 && age <= Number(staleMs);
}

function runwayHeadingDeg(estimate, vehicle) {
  const items = Array.isArray(vehicle?.missionItems) ? vehicle.missionItems : [];
  const land = [...items].reverse().find((item) => Number(item?.command) === MAV_CMD_NAV_LAND);
  const approach = land
    ? [...items].reverse().find((item) => Number(item?.seq) < Number(land.seq) && Number.isFinite(Number(item?.lat)))
    : null;
  if (approach && land) {
    const heading = bearingDeg(Number(approach.lat), Number(approach.lon), Number(land.lat), Number(land.lon));
    if (Number.isFinite(heading)) return heading;
  }
  const marked = Number(estimate?.runway_heading_deg);
  if (Number.isFinite(marked)) return marked;
  const heading = Number(vehicle?.headingDeg);
  return Number.isFinite(heading) ? heading : null;
}

/** Climb-out ahead of the aircraft. RTL when the runway heading is unknown. */
export function opticalClimbTarget(estimate, vehicle, limits = VISION_LAND_DEFAULTS) {
  const altM = Math.max(Number(limits.climbAltM) || OPTICAL_CLIMB_ALT_M, Number(limits.goAroundAltM) || 0, OPTICAL_CLIMB_ALT_M);
  const heading = runwayHeadingDeg(estimate, vehicle);
  const lat = Number(vehicle?.lat);
  const lon = Number(vehicle?.lon);
  if (heading == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { rtl: true, altM };
  }
  const ahead = Number(limits.climbAheadM) || OPTICAL_CLIMB_AHEAD_M;
  const dest = destinationPoint(lat, lon, heading, ahead);
  return { rtl: false, lat: dest.lat, lon: dest.lon, altM, heading };
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
  let handed = false;
  let handoverArmed = false;
  let acceptModes = new Set();
  let buttonSince = null;
  let confidentSince = null;
  let latched = null;
  let posture = 'waiting';

  function resetAttempt() {
    latched = null;
    confidentSince = null;
    handed = false;
    handoverArmed = false;
    sawGuided = false;
    acceptModes = new Set();
  }

  function setOptical(on) {
    const next = on === true;
    if (!next) {
      if (optical) resetAttempt();
      optical = false;
      return false;
    }
    if (latched === 'go_around' || latched === 'cancel') return false;
    if (latched === 'link') latched = null;
    optical = true;
    handed = false;
    handoverArmed = false;
    sawGuided = false;
    acceptModes = new Set([PLANE_MODE_GUIDED]);
    return true;
  }

  function blocked() {
    return latched === 'go_around' || latched === 'cancel';
  }

  function acceptHandover() {
    handed = true;
    handoverArmed = true;
    acceptModes.add(PLANE_MODE_AUTO);
    acceptModes.add(PLANE_MODE_GUIDED);
  }

  function abortGoAround() {
    latched = 'go_around';
    posture = 'go_around';
    optical = false;
  }

  function cancelExternal() {
    latched = 'cancel';
    optical = false;
    posture = 'released';
    sawGuided = false;
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
    const hasLand = missionHasNavLand(shaped.missionItems);
    const base = {
      buttonReady,
      manualArm: optical,
      optical,
      hasLand,
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
    if (latched === 'link') {
      posture = 'released';
      return pack({ ...base, optical: false, manualArm: false, action: null, state: 'released', labelHe: labelFor('released'), reason: 'link' });
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

    if (optical && sawGuided && Number.isFinite(mode) && !acceptModes.has(mode)) {
      latched = 'cancel';
      optical = false;
      confidentSince = null;
      posture = 'released';
      return pack({
        ...base,
        optical: false,
        manualArm: false,
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
      if (optical) {
        optical = false;
        latched = 'link';
        sawGuided = false;
        handed = false;
        handoverArmed = false;
        posture = 'released';
        return pack({
          ...base,
          optical: false,
          manualArm: false,
          action: holding ? 'release' : null,
          state: 'released',
          labelHe: labelFor('released'),
          reason: 'link',
        });
      }
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
      const inGuided = mode === PLANE_MODE_GUIDED;
      const climb = inGuided ? opticalClimbTarget(estimate, shaped, limits) : null;
      return pack({
        ...base,
        action: 'go_around',
        release: holding === true,
        climb: inGuided,
        expectMode: inGuided ? PLANE_MODE_GUIDED : PLANE_MODE_AUTO,
        lat: climb?.lat ?? null,
        lon: climb?.lon ?? null,
        altM: climb?.altM ?? null,
        rtl: climb?.rtl === true,
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
      if (handed) {
        posture = 'active';
        return pack({ ...base, action: null, state: 'active', labelHe: labelFor('active'), reason: 'land' });
      }
      if (!altFresh(shaped, stamp, limits.altStaleMs)) {
        posture = 'released';
        return pack({
          ...base,
          action: holding ? 'release' : null,
          state: 'released',
          labelHe: labelFor('released'),
          reason: 'alt',
        });
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
        floorM: limits.glideFloorM,
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
      if (glide.handoff) {
        const jump = missionLandJump(shaped.missionItems);
        if (!jump) {
          latched = 'go_around';
          optical = false;
          posture = 'go_around';
          const climb = opticalClimbTarget(estimate, shaped, limits);
          return pack({
            ...base,
            optical: false,
            action: 'go_around',
            climb: true,
            expectMode: PLANE_MODE_GUIDED,
            lat: climb.lat ?? null,
            lon: climb.lon ?? null,
            altM: climb.altM,
            rtl: climb.rtl === true,
            release: holding === true,
            state: 'go_around',
            labelHe: labelFor('go_around'),
            reason: 'no_land',
          });
        }
        if (handoverArmed) {
          return pack({ ...base, action: null, state: 'active', labelHe: labelFor('active'), reason: 'land' });
        }
        handoverArmed = true;
        acceptModes.add(PLANE_MODE_AUTO);
        return pack({
          ...base,
          action: 'handover',
          state: 'active',
          labelHe: labelFor('active'),
          reason: 'land',
          expectMode: PLANE_MODE_GUIDED,
          useDoLandStart: jump.useDoLandStart,
          landSeq: jump.landSeq,
          lat: Number.isFinite(jump.lat) ? jump.lat : glide.lat,
          lon: Number.isFinite(jump.lon) ? jump.lon : glide.lon,
        });
      }
      return pack({
        ...base,
        action: 'reposition',
        state: 'active',
        labelHe: labelFor('active'),
        reason: 'glide',
        expectMode: PLANE_MODE_GUIDED,
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
    acceptHandover,
    abortGoAround,
    cancelExternal,
    blocked,
    manualArm: () => optical,
    optical: () => optical,
  };
}
