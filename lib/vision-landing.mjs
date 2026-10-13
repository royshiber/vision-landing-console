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
export const OPTICAL_HANDOFF_M = 300;
export const OPTICAL_GLIDE_FLOOR_M = 5;
export const OPTICAL_PRESS_MIN_REL_ALT_M = 50;
export const OPTICAL_CLIMB_ALT_M = 60;
export const OPTICAL_CLIMB_STEP_M = 30;
export const OPTICAL_CLIMB_AHEAD_M = 450;
export const ALT_STALE_MS = 1500;
export const ON_GROUND_SPEED_MPS = 5;
export const ON_GROUND_ALT_M = 3;
export const ON_GROUND_HOLD_MS = 3000;
export const CLIMB_DONE_BAND_M = 3;
export const CLIMB_LEVEL_MPS = 0.5;
export const CLIMB_LEVEL_HOLD_MS = 3000;
/** ArduPlane MAV_DO_REPOSITION_FLAGS_CHANGE_MODE. Bit 0 of DO_REPOSITION param2. */
export const MAV_DO_REPOSITION_FLAGS_CHANGE_MODE = 1;

export const VISION_LAND_LABEL = Object.freeze({
  waiting: 'ממתין',
  active: 'נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה',
  active_short: 'אופטית פעילה',
  mission: 'נחיתת משימה: הנחיית גלגול',
  mission_button: 'נחיתת משימה פעילה',
  mission_button_short: 'משימה פעילה',
  released: 'שוחרר',
  go_around: 'סבוב מחדש',
  too_low: 'נמוך מדי להפעלה',
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
  climbStepM: OPTICAL_CLIMB_STEP_M,
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
    climbStepM: num(env.VLC_VISION_LAND_CLIMB_STEP_M, d.climbStepM),
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
 * Handoff is about 300 m so the final segment stays on that slope
 * (about 5 m at 80 m) instead of a flat floor. The floor is only a
 * backstop. An unknown aircraft altitude returns null so the caller
 * sends nothing.
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

/**
 * ArduPlane handle_command_int_do_reposition switches into GUIDED only when
 * param2 bit 0 is set or the plane is already GUIDED. Otherwise the command
 * is FAILED and the mode is left unchanged. SET_POSITION_TARGET_GLOBAL_INT
 * also leaves the mode, but that handler ignores lat/lon and only changes
 * altitude, so it cannot fly the glide. Guidance stays DO_REPOSITION with
 * param2 forced to 0, and the sender refuses the frame unless the latest
 * heartbeat is already GUIDED.
 */
export function arduPlaneRepositionMode(customMode, param2) {
  const mode = Number(customMode);
  const change = (Number(param2) & MAV_DO_REPOSITION_FLAGS_CHANGE_MODE) !== 0;
  if (!change && mode !== PLANE_MODE_GUIDED) return { mode, result: 4 };
  return { mode: PLANE_MODE_GUIDED, result: 0 };
}

/** Climb-out ahead of the aircraft. Never below the current altitude. RTL when altitude or heading is unknown. */
export function opticalClimbTarget(estimate, vehicle, limits = VISION_LAND_DEFAULTS) {
  const raw = vehicle?.altAglM;
  const current = Number(raw);
  const known = raw != null && raw !== '' && Number.isFinite(current);
  if (!known) return { rtl: true, altM: null };
  const floor = Number(limits.climbAltM) || OPTICAL_CLIMB_ALT_M;
  const step = Number(limits.climbStepM) || OPTICAL_CLIMB_STEP_M;
  const altM = Math.max(current + step, floor, current);
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

/**
 * A new press is refused below 50 m relative altitude, inside the handoff,
 * or while the flight controller reports landed state 4. An attempt that
 * is already guiding is not aborted here.
 */
export function opticalPressBlock(vehicle, estimate, limits = VISION_LAND_DEFAULTS) {
  if (!vehicle || typeof vehicle !== 'object') return null;
  if (Number(vehicle.landedState) === 4) return 'too_low';
  const rel = Number(vehicle.relativeAltM);
  const minRel = Number(limits.pressMinRelAltM);
  const floor = Number.isFinite(minRel) ? minRel : OPTICAL_PRESS_MIN_REL_ALT_M;
  if (Number.isFinite(rel) && rel < floor) return 'too_low';
  const phase = missionLandingPhase(vehicle.missionItems, vehicle.missionCurrent);
  const point = thresholdOf(estimate, phase);
  let dist = point ? distanceM(vehicle.lat, vehicle.lon, point.lat, point.lon) : null;
  if (dist == null) {
    const given = Number(vehicle.distToLandM);
    if (Number.isFinite(given)) dist = given;
  }
  const handoff = Number(limits.handoffM);
  const limit = Number.isFinite(handoff) ? handoff : OPTICAL_HANDOFF_M;
  if (dist != null && dist <= limit) return 'too_low';
  return null;
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
  let groundSince = null;
  let climbOutM = null;
  let levelSince = null;
  let lastAltSample = null;
  let manualResume = false;
  let awaitingGate = false;
  let suppressAuto = false;

  function resetAttempt() {
    latched = null;
    climbOutM = null;
    levelSince = null;
    lastAltSample = null;
    groundSince = null;
    manualResume = false;
    confidentSince = null;
    handed = false;
    handoverArmed = false;
    sawGuided = false;
    acceptModes = new Set();
  }

  /**
   * Every terminal state stays here until an explicit button press.
   * A tick must not leave it, including after a frozen clock resumes.
   */
  function latchTerminal(reason, climbAlt) {
    buttonSince = null;
    awaitingGate = true;
    confidentSince = null;
    groundSince = null;
    levelSince = null;
    lastAltSample = null;
    optical = false;
    sawGuided = false;
    handed = false;
    handoverArmed = false;
    manualResume = true;
    acceptModes = new Set();
    if (reason === 'go_around') {
      latched = 'go_around';
      posture = 'go_around';
      const alt = Number(climbAlt);
      if (Number.isFinite(alt) && alt > 0) climbOutM = alt;
      return;
    }
    latched = reason || 'released';
    posture = 'released';
    climbOutM = null;
  }

  function clearLatch() {
    latched = null;
    climbOutM = null;
    levelSince = null;
    lastAltSample = null;
    manualResume = false;
    awaitingGate = false;
    suppressAuto = false;
    posture = 'waiting';
  }

  function heartbeatStale(vehicle) {
    const age = Number(vehicle?.heartbeatAgeMs);
    if (!Number.isFinite(age)) return false;
    return age < 0 || age >= ALT_STALE_MS;
  }

  function guidingNow(holding) {
    return optical || posture === 'active' || handed || handoverArmed || holding === true;
  }

  function setOptical(on) {
    const next = on === true;
    if (!next) {
      if (optical) resetAttempt();
      optical = false;
      return false;
    }
    if (latched) return false;
    optical = true;
    manualResume = false;
    suppressAuto = false;
    awaitingGate = false;
    handed = false;
    handoverArmed = false;
    sawGuided = false;
    acceptModes = new Set([PLANE_MODE_GUIDED]);
    return true;
  }

  function blocked() {
    return latched === 'go_around' || latched === 'cancel';
  }

  function readClimbRate(vehicle, alt, now) {
    const given = Number(vehicle?.climbMps);
    if (Number.isFinite(given)) return given;
    const at = Number(vehicle?.altAt);
    const stamp = Number.isFinite(at) ? at : Number(now);
    const prev = lastAltSample;
    if (Number.isFinite(alt) && Number.isFinite(stamp)) lastAltSample = { alt, at: stamp };
    if (!prev || !Number.isFinite(alt) || !Number.isFinite(stamp)) return null;
    const dt = (stamp - prev.at) / 1000;
    if (!(dt > 0.2) || dt > 30) return null;
    return (alt - prev.alt) / dt;
  }

  /**
   * The climb is finished only inside the 3 m band, and only after |rate|
   * stays under 0.5 m/s for 3 s. A sink does not count. A missing rate does
   * not start or clear that wait.
   */
  function noteLevelOff(vehicle, now) {
    if (latched !== 'go_around' || !Number.isFinite(climbOutM)) {
      levelSince = null;
      return;
    }
    const alt = Number(vehicle?.altAglM);
    const rate = readClimbRate(vehicle, alt, now);
    const inBand = Number.isFinite(alt) && alt >= climbOutM - CLIMB_DONE_BAND_M;
    const levelRate = Number.isFinite(rate) && Math.abs(rate) < CLIMB_LEVEL_MPS;
    if (inBand && levelRate) {
      const stamp = Number(now) || 0;
      if (levelSince == null) levelSince = stamp;
      return;
    }
    if (!inBand || (Number.isFinite(rate) && Math.abs(rate) >= CLIMB_LEVEL_MPS)) {
      levelSince = null;
    }
  }

  function climbSettled(vehicle, now) {
    if (latched !== 'go_around') return true;
    const mode = Number(vehicle?.customMode);
    if (Number.isFinite(mode) && mode !== PLANE_MODE_GUIDED) return true;
    if (!Number.isFinite(climbOutM)) return true;
    const raw = vehicle?.altAglM;
    const alt = Number(raw);
    if (raw == null || raw === '' || !Number.isFinite(alt)) return false;
    noteLevelOff(vehicle, now);
    const stamp = Number(now) || 0;
    return levelSince != null && stamp - levelSince >= CLIMB_LEVEL_HOLD_MS;
  }

  /**
   * A press is the only way out of a terminal state. The climb must be
   * finished, and the runway gate must be earned again. This does not
   * start an attempt; the caller does that after the other checks pass.
   */
  function pressBlocked({ buttonReady = false, vehicle = null, estimate = null, now = 0 } = {}) {
    if (latched === 'go_around') {
      if (Array.isArray(estimate?.hazards) && estimate.hazards.length > 0) return 'go_around';
      if (!climbSettled(vehicle, now)) return 'go_around';
    }
    if (opticalPressBlock(vehicle, estimate, limits)) return 'too_low';
    if (buttonReady !== true) return 'no_runway';
    return null;
  }

  /** Terminal release. Does not arm the climb wait. */
  function releaseNow(reason) {
    const why = !reason || reason === 'go_around' ? 'released' : reason;
    latchTerminal(why);
  }

  /** Climb wait starts only after the caller has an accepted climb reposition. */
  function confirmGoAround(altM) {
    latchTerminal('go_around', altM);
  }

  function acceptHandover() {
    handed = true;
    handoverArmed = true;
    acceptModes.add(PLANE_MODE_AUTO);
    acceptModes.add(PLANE_MODE_GUIDED);
  }

  function retryHandover() {
    handoverArmed = false;
  }

  function abortGoAround(altM) {
    latchTerminal('go_around', altM);
  }

  function cancelExternal() {
    latchTerminal('mode');
  }

  function loseLink() {
    latchTerminal('link');
  }

  function noteStale() {
    latchTerminal('stale');
  }

  function updateButton(estimate, now) {
    const stamp = Number(now) || 0;
    const seen = estimate?.detected === true && runwayConfidence(estimate) >= limits.confidence;
    if (!seen) {
      buttonSince = null;
      return false;
    }
    if (buttonSince == null) buttonSince = stamp;
    const held = stamp - buttonSince >= limits.holdMs;
    if (!held) return false;
    awaitingGate = false;
    return true;
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
    const speed = Number(shaped.groundspeedMps);
    const relAlt = Number(shaped.relativeAltM);
    const speedAt = Number(shaped.groundspeedAt);
    const relAt = Number(shaped.relativeAltAt);
    const speedFresh = Number.isFinite(speed)
      && Number.isFinite(speedAt)
      && stamp - speedAt >= 0
      && stamp - speedAt <= limits.altStaleMs;
    const relFresh = Number.isFinite(relAlt)
      && Number.isFinite(relAt)
      && stamp - relAt >= 0
      && stamp - relAt <= limits.altStaleMs;
    const landedRaw = shaped.landedState;
    const landedPresent = landedRaw != null && landedRaw !== '' && Number.isFinite(Number(landedRaw));
    const landed = Number(landedRaw);
    const landedOk = !landedPresent || landed === 1 || landed === 4;
    const touchdown = speedFresh
      && relFresh
      && Math.abs(relAlt) < ON_GROUND_ALT_M
      && speed < ON_GROUND_SPEED_MPS
      && landedOk;
    const live = guidingNow(holding);
    if (!(live && touchdown)) groundSince = null;
    else if (groundSince == null) groundSince = stamp;
    const heldGround = live && touchdown && stamp - groundSince >= ON_GROUND_HOLD_MS;

    function terminal(wasHolding, reason, justLatched) {
      const around = latched === 'go_around';
      return pack({
        ...base,
        buttonReady: justLatched ? false : base.buttonReady === true,
        optical: false,
        manualArm: false,
        phase: false,
        action: (!around && wasHolding) ? 'release' : null,
        state: around ? 'go_around' : 'released',
        labelHe: labelFor(around ? 'go_around' : 'released'),
        reason,
      });
    }

    if (latched) {
      noteLevelOff(shaped, stamp);
      return terminal(false, latched, false);
    }
    if (live && heartbeatStale(shaped)) {
      latchTerminal('stale');
      return terminal(holding === true, 'stale', true);
    }
    if (heldGround) {
      resetAttempt();
      optical = false;
      posture = 'waiting';
      buttonSince = null;
      awaitingGate = true;
      suppressAuto = true;
      return pack({
        ...base,
        buttonReady: false,
        optical: false,
        manualArm: false,
        phase: false,
        action: holding ? 'release' : null,
        state: 'waiting',
        labelHe: labelFor('waiting'),
        reason: 'idle',
      });
    }

    if (!optical && !phase.active) {
      confidentSince = null;
      if (holding && sitl) {
        latchTerminal('phase');
        return terminal(true, 'phase', true);
      }
      posture = posture === 'released' ? 'released' : 'waiting';
      const bare = posture === 'waiting'
        && Array.isArray(shaped.missionItems)
        && shaped.missionItems.length > 0
        && !hasLand;
      return pack({
        ...base,
        action: null,
        state: posture,
        labelHe: bare ? labelFor('no_land') : labelFor(posture),
        reason: bare ? 'no_land' : 'phase',
      });
    }

    if (!guidanceAllowed) {
      confidentSince = null;
      if (holding && sitl) {
        const reason = sitl ? 'level' : 'not_sitl';
        latchTerminal(reason);
        return terminal(true, reason, true);
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
      latchTerminal('mode');
      return terminal(holding === true, 'mode', true);
    }

    if (!optical && phase.active && mode !== PLANE_MODE_AUTO) {
      confidentSince = null;
      if (holding || posture === 'active') {
        latchTerminal('mode');
        return terminal(holding === true, 'mode', true);
      }
      posture = 'waiting';
      return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'mode' });
    }

    if (shaped.connected === false) {
      confidentSince = null;
      if (optical || holding || posture === 'active' || handed) {
        latchTerminal('link');
        return terminal(holding === true, 'link', true);
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
      const inGuided = mode === PLANE_MODE_GUIDED;
      const climb = inGuided ? opticalClimbTarget(estimate, shaped, limits) : null;
      return pack({
        ...base,
        buttonReady: false,
        action: 'go_around',
        release: holding === true,
        climb: inGuided,
        expectMode: inGuided ? PLANE_MODE_GUIDED : PLANE_MODE_AUTO,
        lat: climb?.lat ?? null,
        lon: climb?.lon ?? null,
        altM: climb?.altM ?? null,
        rtl: climb?.rtl === true,
        state: 'active',
        labelHe: labelFor('active'),
        reason: hazards.length > 0 ? 'hazard' : 'lateral',
      });
    }

    if (optical) {
      if (mode === PLANE_MODE_GUIDED) sawGuided = true;
      if (sawGuided && heartbeatStale(shaped)) {
        latchTerminal('stale');
        return terminal(holding === true, 'stale', true);
      }
      if (!sawGuided) {
        posture = 'waiting';
        return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'guided_wait' });
      }
      if (handed) {
        posture = 'active';
        return pack({ ...base, action: null, state: 'active', labelHe: labelFor('active'), reason: 'land' });
      }
      if (!altFresh(shaped, stamp, limits.altStaleMs)) {
        latchTerminal('alt');
        return terminal(holding === true, 'alt', true);
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
          latchTerminal('no_threshold');
          return terminal(true, 'no_threshold', true);
        }
        posture = 'waiting';
        return pack({ ...base, action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'no_threshold' });
      }
      posture = 'active';
      if (glide.handoff) {
        const jump = missionLandJump(shaped.missionItems);
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
          useDoLandStart: jump?.useDoLandStart === true,
          landSeq: jump?.landSeq ?? null,
          lat: Number.isFinite(jump?.lat) ? jump.lat : glide.lat,
          lon: Number.isFinite(jump?.lon) ? jump.lon : glide.lon,
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

    if (suppressAuto) {
      confidentSince = null;
      posture = 'waiting';
      return pack({
        ...base,
        action: null,
        state: 'waiting',
        labelHe: labelFor('waiting'),
        reason: 'dwell',
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
        const reason = estimate?.detected !== true || conf < limits.confidence ? 'runway_lost' : 'envelope';
        latchTerminal(reason);
        return terminal(true, reason, true);
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
      labelHe: labelFor('mission'),
      reason: 'guide',
    });
  }

  return {
    plan,
    observe: updateButton,
    setOptical,
    setManualArm: setOptical,
    acceptHandover,
    retryHandover,
    abortGoAround,
    releaseNow,
    confirmGoAround,
    cancelExternal,
    loseLink,
    blocked,
    pressBlocked,
    clearLatch,
    noteStale,
    manualArm: () => optical,
    optical: () => optical,
  };
}
