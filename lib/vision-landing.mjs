/**
 * Vision landing on final. Lateral and heading only.
 * Altitude and speed stay with the autopilot.
 * A command leaves only in SITL, and only after the landing phase,
 * a confidence dwell, and the altitude and distance envelope all agree.
 * Level 4 stays locked unless the existing runway unlock is confirmed.
 */

export const MAV_CMD_NAV_LAND = 21;
export const MAV_CMD_DO_GO_AROUND = 191;

export const VISION_LAND_LABEL = Object.freeze({
  waiting: 'ממתין',
  active: 'פעיל',
  released: 'שוחרר',
  go_around: 'סבוב מחדש',
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
  rcPwmDelta: 40,
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
    rcPwmDelta: num(env.VLC_VISION_LAND_RC_DELTA, d.rcPwmDelta),
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
 * Landing phase: the last mission item is NAV_LAND, and the current
 * waypoint is that item or the one immediately before it.
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
  const active = Number.isFinite(cur) && (cur === landSeq || (approachSeq != null && cur === approachSeq));
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

export function landDistanceM(vehicle, phase) {
  const given = Number(vehicle?.distToLandM);
  if (Number.isFinite(given)) return given;
  const land = phase?.land;
  if (!land) return null;
  return distanceM(vehicle?.lat, vehicle?.lon, land.lat, land.lon);
}

/**
 * Pilot roll, not the override echo.
 * ArduPilot puts get_radio_in() on RC_CHANNELS and on RC_CHANNELS_RAW.
 * While a roll override is held, that value is the command we sent.
 * SERVO_OUTPUT_RAW is the surface, not the stick.
 * A channel-1 sample within the deadband of the last commanded roll is
 * that echo and is ignored. The pilot stick is pilotRc.chan1_raw when
 * the vehicle has the receiver value from before the override. Otherwise
 * a channel-1 sample outside that deadband of the command is the pilot.
 * Channels 2–8 never cancel.
 */
function pilotRollPwm(vehicle, holding, commanded, delta) {
  const stick = Number(vehicle?.pilotRc?.chan1_raw);
  if (Number.isFinite(stick)) return stick;
  const raw = Number(vehicle?.rcChannels?.chan1_raw);
  if (!Number.isFinite(raw)) return null;
  const sent = Number(commanded);
  if (holding && Number.isFinite(sent) && Math.abs(raw - sent) < delta) return null;
  return raw;
}

function labelFor(state) {
  return VISION_LAND_LABEL[state] || VISION_LAND_LABEL.waiting;
}

export function createVisionLandingSession({ limits = VISION_LAND_DEFAULTS } = {}) {
  let manualArm = false;
  let confidentSince = null;
  let latched = null;
  let modeBase = null;
  let rcBase = null;
  let posture = 'waiting';

  function resetAttempt() {
    latched = null;
    modeBase = null;
    rcBase = null;
    confidentSince = null;
  }

  function setManualArm(arm) {
    const next = arm === true;
    if (manualArm && !next) resetAttempt();
    manualArm = next;
    return manualArm;
  }

  function pilotTouch(vehicle, holding, commanded) {
    const mode = Number(vehicle?.customMode);
    if (Number.isFinite(mode)) {
      if (modeBase == null) modeBase = mode;
      else if (mode !== modeBase) return 'mode';
    }
    const roll = pilotRollPwm(vehicle, holding, commanded, limits.rcPwmDelta);
    if (roll != null) {
      if (rcBase == null) rcBase = roll;
      else if (Math.abs(rcBase - roll) >= limits.rcPwmDelta) return 'rc';
    }
    return null;
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
    commandedRoll = null,
  } = {}) {
    const phase = missionLandingPhase(vehicle?.missionItems, vehicle?.missionCurrent);
    const attempt = phase.active || manualArm === true;
    const levelOk = Number(level) === 3 || (Number(level) === 4 && unlock === true && confirmed === true);
    const guidanceAllowed = levelOk && sitl === true;
    const dist = landDistanceM(vehicle, phase);
    const shaped = { ...(vehicle || {}), distToLandM: dist };
    const stamp = Number(now) || 0;

    if (!attempt) {
      resetAttempt();
      if (holding && sitl) {
        posture = 'released';
        return { action: 'release', state: 'released', labelHe: labelFor('released'), reason: 'phase', manualArm, phase: false };
      }
      posture = 'waiting';
      return { action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'phase', manualArm, phase: false };
    }

    if (latched === 'go_around') {
      posture = 'go_around';
      return { action: null, state: 'go_around', labelHe: labelFor('go_around'), reason: 'go_around', manualArm, phase: true };
    }
    if (latched === 'cancel') {
      posture = 'released';
      return { action: null, state: 'released', labelHe: labelFor('released'), reason: 'cancel', manualArm, phase: true };
    }

    if (!guidanceAllowed) {
      confidentSince = null;
      if (holding && sitl) {
        posture = 'released';
        return { action: 'release', state: 'released', labelHe: labelFor('released'), reason: sitl ? 'level' : 'not_sitl', manualArm, phase: true };
      }
      posture = 'waiting';
      return {
        action: null,
        state: 'waiting',
        labelHe: labelFor('waiting'),
        reason: sitl ? 'level' : 'not_sitl',
        manualArm,
        phase: true,
      };
    }

    const touch = pilotTouch(shaped, holding === true, commandedRoll);
    if (touch) {
      latched = 'cancel';
      confidentSince = null;
      posture = 'released';
      return {
        action: holding ? 'release' : null,
        state: 'released',
        labelHe: labelFor('released'),
        reason: touch,
        manualArm,
        phase: true,
      };
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
      return {
        action: 'go_around',
        release: holding === true,
        state: 'go_around',
        labelHe: labelFor('go_around'),
        reason: hazards.length > 0 ? 'hazard' : 'lateral',
        manualArm,
        phase: true,
      };
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
        return { action: 'release', state: 'released', labelHe: labelFor('released'), reason, manualArm, phase: true };
      }
      const state = posture === 'released' ? 'released' : 'waiting';
      return { action: null, state, labelHe: labelFor(state), reason: 'dwell', manualArm, phase: true };
    }

    if (confidentSince == null) confidentSince = stamp;
    if (stamp - confidentSince < limits.holdMs) {
      posture = 'waiting';
      return { action: null, state: 'waiting', labelHe: labelFor('waiting'), reason: 'dwell', manualArm, phase: true };
    }

    posture = 'active';
    return {
      action: 'guide',
      rollPwm,
      state: 'active',
      labelHe: labelFor('active'),
      reason: 'guide',
      manualArm,
      phase: true,
    };
  }

  return {
    plan,
    setManualArm,
    manualArm: () => manualArm,
  };
}
