/**
 * Runway awareness gate for the console.
 * Levels 0–2 never call the link. Level 3 may steer only in SITL.
 * A NAV_LAND item in AUTO steers roll. The optical-land button enters GUIDED
 * and flies a glide, then hands the flare to the mission in AUTO.
 * Level 4 stays refused unless the env flag is on and the operator confirmed in Hebrew.
 */

import {
  createVisionLandingSession,
  missionHasNavLand,
  missionLandJump,
  opticalClimbTarget,
  PLANE_MODE_AUTO,
  PLANE_MODE_GUIDED,
  readVisionLandLimits,
  VISION_LAND_LABEL,
} from './vision-landing.mjs';

export const RUNWAY_LEVELS = Object.freeze([
  { level: 0, name: 'OFF', labelHe: 'כבוי', descHe: 'בלי זיהוי ובלי ציור' },
  { level: 1, name: 'DISPLAY', labelHe: 'תצוגה', descHe: 'קו האמצע, הסטייה ותיבות הסכנה' },
  { level: 2, name: 'ALERTS', labelHe: 'התראות', descHe: 'אזהרה והמלצה ללכת סביב' },
  { level: 3, name: 'GUIDANCE_SIM', labelHe: 'הנחיית סימולטור', descHe: 'חישוב היגוי. פקודה רק מול סימולטור' },
  { level: 4, name: 'GUIDANCE_REAL', labelHe: 'הנחיה אמיתית', descHe: 'נעול עד אישור מפורש' },
]);

export const RUNWAY_CONFIRM_PHRASE = 'מאשר';

const KIND_HE = { person: 'אדם', vehicle: 'רכב', animal: 'חיה', obstacle: 'מכשול' };

export function runwayFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function readRunwayLevel(env = process.env) {
  const level = Number(env.VLC_RUNWAY_LEVEL ?? 0);
  if (!Number.isInteger(level) || level < 0 || level > 4) return 0;
  return level;
}

export function runwayLevel4Unlocked(env = process.env) {
  return runwayFlag(env.VLC_RUNWAY_LEVEL4_UNLOCK);
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/** Positive heading error turns right. Positive offset (right of the line) turns left. */
export function rollPwmFromEstimate(estimate) {
  if (!estimate || estimate.detected !== true) return null;
  const heading = Number(estimate.heading_error_deg);
  const offsetM = Number(estimate.offset_m);
  const offsetNorm = Number(estimate.offset_norm);
  const head = Number.isFinite(heading) ? heading : 0;
  let offsetTerm = 0;
  if (Number.isFinite(offsetM)) offsetTerm = offsetM * 8;
  else if (Number.isFinite(offsetNorm)) offsetTerm = offsetNorm * 40;
  const delta = clamp(head * 4 - offsetTerm, -120, 120);
  return Math.round(1500 + delta);
}

export function computeGuidance(estimate) {
  const rollPwm = rollPwmFromEstimate(estimate);
  if (rollPwm == null) return null;
  return { kind: 'ROLL_OVERRIDE', rollPwm, sitlOnly: true };
}

export function authorizeRunway({ level, sitl, unlock = false, confirmed = false, hazards = [] } = {}) {
  const n = Number(level);
  if (n <= 0) return { allow: false, reason: 'off' };
  if (n === 1 || n === 2) return { allow: false, reason: 'observe_only' };
  if (n === 4 && !(unlock && confirmed)) return { allow: false, reason: 'level4_locked' };
  if (n !== 3 && n !== 4) return { allow: false, reason: 'off' };
  if (Array.isArray(hazards) && hazards.length > 0) return { allow: false, reason: 'hazard' };
  if (sitl !== true) return { allow: false, reason: 'not_sitl' };
  return { allow: true, reason: 'sitl' };
}

export function runwayAdviceHe(level, hazards) {
  if (Number(level) < 2 || !hazards?.length) return '';
  const label = hazards[0].label_he || KIND_HE[hazards[0].kind] || 'מכשול';
  return `יש ${label} על המסלול. מומלץ ללכת סביב.`;
}

export function createRunwayController({ link, env = process.env, now = () => Date.now(), limits = null } = {}) {
  let level = readRunwayLevel(env);
  let confirmed = false;
  let commandsSent = 0;
  let lastEstimate = null;
  let lastGuidance = null;
  let lastReason = level === 0 ? 'off' : 'observe_only';
  let held = false;
  let heldKind = null;
  let lastVision = {
    state: 'waiting',
    labelHe: 'ממתין',
    manualArm: false,
    reason: 'phase',
    phase: false,
  };
  const vision = createVisionLandingSession({
    limits: { ...readVisionLandLimits(env), ...(limits || {}) },
  });

  function view(extra = {}) {
    const hazards = Array.isArray(lastEstimate?.hazards) ? lastEstimate.hazards : [];
    const row = RUNWAY_LEVELS[level] || RUNWAY_LEVELS[0];
    return {
      ok: true,
      level,
      levelName: row.name,
      labelHe: row.labelHe,
      level4Unlocked: runwayLevel4Unlocked(env),
      level4Confirmed: confirmed === true,
      detected: lastEstimate ? lastEstimate.detected === true : null,
      estimate: level >= 1 ? lastEstimate : null,
      hazards: level >= 1 ? hazards : [],
      adviceHe: runwayAdviceHe(level, hazards),
      guidance: level >= 3 ? lastGuidance : null,
      vision: {
        state: lastVision.state,
        labelHe: lastVision.labelHe,
        manualArm: lastVision.manualArm === true,
        reason: lastVision.reason || null,
        phase: lastVision.phase === true,
        buttonReady: lastVision.buttonReady === true,
        optical: lastVision.optical === true,
        hasLand: lastVision.hasLand === true,
      },
      sendReason: lastReason,
      commandsSent,
      flightCommands: false,
      allowSend: false,
      ...extra,
    };
  }

  function setLevel(body = {}) {
    const next = Number(body.level);
    if (!Number.isInteger(next) || next < 0 || next > 4) {
      return { ...view(), ok: false, status: 400, reason: 'bad_level', messageHe: 'רמה לא מוכרת' };
    }
    if (next === 4) {
      const phrase = String(body.phrase || '');
      const accepted = body.confirm === true && phrase === RUNWAY_CONFIRM_PHRASE;
      if (!runwayLevel4Unlocked(env) || !accepted) {
        confirmed = false;
        const locked = !runwayLevel4Unlocked(env);
        return {
          ...view(),
          ok: false,
          status: 403,
          reason: locked ? 'level4_locked' : 'confirm',
          needConfirm: !locked && !accepted,
          messageHe: locked
            ? 'הנחיה אמיתית נעולה. הרמה לא השתנתה.'
            : 'נדרש אישור בעברית לפני הנחיה אמיתית.',
        };
      }
      confirmed = true;
    } else {
      confirmed = false;
    }
    level = next;
    lastReason = next <= 0 ? 'off' : next <= 2 ? 'observe_only' : lastReason;
    return { ...view(), ok: true, status: 200, messageHe: RUNWAY_LEVELS[next].labelHe };
  }

  function decide(vehicle) {
    const hazards = Array.isArray(lastEstimate?.hazards) ? lastEstimate.hazards : [];
    lastGuidance = level >= 3 ? computeGuidance(lastEstimate) : null;
    const decision = authorizeRunway({
      level,
      sitl: vehicle?.simulator === true,
      unlock: runwayLevel4Unlocked(env),
      confirmed,
      hazards,
    });
    lastReason = decision.reason;
    return decision;
  }

  function takeEstimate(estimate) {
    if (estimate === undefined) return;
    lastEstimate = estimate && typeof estimate === 'object' ? estimate : null;
  }

  function note({ estimate = undefined, vehicle = null } = {}) {
    takeEstimate(estimate);
    const decision = decide(vehicle);
    const buttonReady = vision.observe(lastEstimate, now());
    const items = vehicle?.missionItems;
    const hasLand = missionHasNavLand(items);
    const bare = Array.isArray(items) && items.length > 0 && !hasLand;
    const quiet = lastVision.state !== 'active' && lastVision.state !== 'go_around' && lastVision.state !== 'released';
    let label = {};
    if (quiet && bare) label = { state: 'waiting', labelHe: VISION_LAND_LABEL.no_land, reason: 'no_land' };
    else if (quiet && hasLand && lastVision.reason === 'no_land') {
      label = { state: 'waiting', labelHe: VISION_LAND_LABEL.waiting, reason: 'phase' };
    }
    lastVision = { ...lastVision, buttonReady, hasLand, ...label };
    return { ...view({ sentNow: 0, allowSend: false }), decision };
  }

  function deliver(cmd) {
    if (typeof link?.sendGuidance !== 'function') return { sent: false, reason: 'no_link' };
    try {
      return link.sendGuidance(cmd) || { sent: false };
    } catch (err) {
      return { sent: false, reason: err?.code || 'not_sitl' };
    }
  }

  function setManualArm(arm) {
    vision.setOptical(arm === true);
    return view();
  }

  function requestOptical(vehicle) {
    const buttonReady = vision.observe(lastEstimate, now());
    const hasLand = missionHasNavLand(vehicle?.missionItems);
    lastVision = { ...lastVision, buttonReady, hasLand };
    const blocked = vision.pressBlocked({ buttonReady, vehicle, estimate: lastEstimate });
    if (blocked === 'go_around') {
      return { ...view(), ok: false, reason: 'go_around', messageHe: VISION_LAND_LABEL.go_around };
    }
    if (blocked) {
      return { ...view(), ok: false, reason: blocked, messageHe: VISION_LAND_LABEL.blocked };
    }
    const sitl = vehicle?.simulator === true;
    const levelOk = level === 3 || (level === 4 && runwayLevel4Unlocked(env) && confirmed === true);
    if (!levelOk) {
      const locked = level === 4;
      return {
        ...view(),
        ok: false,
        reason: locked ? 'level4_locked' : 'level',
        messageHe: locked ? 'הנחיה אמיתית נעולה. הרמה לא השתנתה.' : VISION_LAND_LABEL.level,
      };
    }
    if (!sitl) return { ...view(), ok: false, reason: 'not_sitl' };
    if (vehicle?.connected !== true) return { ...view(), ok: false, reason: 'no_link' };
    if (!hasLand) {
      return { ...view(), ok: false, reason: 'no_land', messageHe: VISION_LAND_LABEL.no_land };
    }
    const already = vision.optical() === true && Number(vehicle?.customMode) === PLANE_MODE_GUIDED;
    let sentNow = 0;
    if (!already) {
      const sent = deliver({ kind: 'ENTER_GUIDED' });
      if (sent?.sent !== true) return { ...view(), ok: false, reason: sent?.reason || 'not_sitl' };
      vision.clearLatch();
      if (vision.setOptical(true) !== true) return { ...view(), ok: false, reason: 'go_around' };
      commandsSent += 1;
      sentNow = 1;
    }
    lastVision = {
      ...lastVision,
      optical: true,
      manualArm: true,
      buttonReady: true,
      hasLand: true,
      state: 'waiting',
      labelHe: VISION_LAND_LABEL.waiting,
      reason: 'guided_wait',
    };
    return { ...view({ sentNow, allowSend: false }), ok: true };
  }

  function noteSent(result, reason) {
    if (result?.sent === true) {
      commandsSent += 1;
      if (reason) lastReason = reason;
      return 1;
    }
    if (result?.reason) lastReason = result.reason;
    return 0;
  }

  function chain(value, fn) {
    if (value && typeof value.then === 'function') return value.then(fn);
    return fn(value);
  }

  function ackAccepted(sent) {
    if (!sent || sent.sent !== true) return false;
    if (!Object.prototype.hasOwnProperty.call(sent, 'ack')) return true;
    const result = Number(sent.ack?.result);
    return result === 0 || result === 5;
  }

  function autoAccepted(sent) {
    if (!ackAccepted(sent)) return false;
    if (!sent || !Object.prototype.hasOwnProperty.call(sent, 'heartbeatMode')) return true;
    return Number(sent.heartbeatMode) === PLANE_MODE_AUTO;
  }

  function gate(sent) {
    if (sent?.reason === 'mode_changed') {
      markCancelled();
      return 'cancel';
    }
    if (sent?.reason === 'stale_heartbeat') return 'stale';
    return null;
  }

  function refreshMission() {
    if (typeof link?.refreshMission !== 'function') return null;
    try {
      return link.refreshMission() || null;
    } catch (err) {
      return { ok: false, reason: err?.code || 'mission' };
    }
  }

  function markCancelled() {
    vision.cancelExternal();
    held = false;
    heldKind = null;
    lastVision = {
      ...lastVision,
      optical: false,
      manualArm: false,
      action: null,
      state: 'released',
      labelHe: VISION_LAND_LABEL.released,
      reason: 'mode',
    };
  }

  function markGoAround(vehicle) {
    const limitsNow = { ...readVisionLandLimits(env), ...(limits || {}) };
    const climb = opticalClimbTarget(lastEstimate, vehicle, limitsNow);
    vision.abortGoAround(climb && climb.rtl !== true ? climb.altM : null);
    held = false;
    heldKind = null;
    lastVision = {
      ...lastVision,
      optical: false,
      manualArm: false,
      action: null,
      state: 'go_around',
      labelHe: VISION_LAND_LABEL.go_around,
      reason: 'go_around',
    };
  }

  function sendClimb(step, vehicle) {
    const limitsNow = { ...readVisionLandLimits(env), ...(limits || {}) };
    const computed = opticalClimbTarget(lastEstimate, vehicle, limitsNow);
    const plannedAlt = Number(step?.altM);
    const usePlanned = step?.climb === true
      && step?.rtl !== true
      && Number.isFinite(Number(step?.lat))
      && Number.isFinite(Number(step?.lon))
      && plannedAlt > 0;
    const point = step?.rtl === true ? { rtl: true } : (usePlanned ? step : computed);
    if (!point || point.rtl === true || !Number.isFinite(Number(point.lat))) {
      return chain(deliver({ kind: 'RTL', expectMode: PLANE_MODE_GUIDED }), (sent) => {
        if (gate(sent)) return 0;
        return noteSent(sent, 'rtl');
      });
    }
    return chain(deliver({
      kind: 'REPOSITION',
      lat: point.lat,
      lon: point.lon,
      altM: point.altM,
      expectMode: PLANE_MODE_GUIDED,
    }), (sent) => {
      if (gate(sent)) return 0;
      const wrote = noteSent(sent, 'climb');
      if (ackAccepted(sent)) return wrote;
      return chain(deliver({ kind: 'RTL', expectMode: PLANE_MODE_GUIDED }), (rtl) => {
        if (gate(rtl)) return wrote;
        return wrote + noteSent(rtl, 'rtl');
      });
    });
  }

  function finish(sentNow, decision) {
    return { ...view({ sentNow, allowSend: false, holding: held }), decision };
  }

  function withHeartbeat(vehicle) {
    if (!vehicle || typeof vehicle !== 'object') return vehicle;
    if (Number.isFinite(Number(vehicle.heartbeatAgeMs))) return vehicle;
    const at = Number(link?.conn?.lastHeartbeatWallMs);
    if (!Number.isFinite(at)) return vehicle;
    return { ...vehicle, heartbeatAgeMs: Date.now() - at };
  }

  function tick({ estimate = undefined, vehicle = null } = {}) {
    takeEstimate(estimate);
    const decision = decide(vehicle);
    const sitl = vehicle?.simulator === true;
    const linkUp = vehicle?.connected === true;
    const sensed = withHeartbeat(vehicle);
    const step = vision.plan({
      level,
      sitl,
      unlock: runwayLevel4Unlocked(env),
      confirmed,
      estimate: lastEstimate,
      vehicle: sensed,
      holding: held,
      now: now(),
      rollPwm: lastGuidance?.rollPwm ?? null,
    });
    lastVision = step;
    function releaseStale(decision, already = 0) {
      vision.noteStale();
      let sentNow = already;
      if (sitl && heldKind === 'roll') {
        sentNow += noteSent(deliver({ kind: 'ROLL_OVERRIDE', release: true, rollPwm: 0 }), 'release');
      }
      held = false;
      heldKind = null;
      lastVision = {
        ...lastVision,
        optical: false,
        manualArm: false,
        action: null,
        state: 'released',
        labelHe: VISION_LAND_LABEL.released,
        reason: 'stale',
      };
      lastReason = 'stale';
      return finish(sentNow, decision);
    }

    if (step.action === 'go_around') {
      let prelude = 0;
      if (step.release && sitl && heldKind === 'roll') {
        prelude += noteSent(deliver({ kind: 'ROLL_OVERRIDE', release: true, rollPwm: 0 }), 'release');
      }
      held = false;
      heldKind = null;
      if (!(linkUp && sitl)) {
        lastReason = 'go_around';
        return finish(prelude, decision);
      }
      const abort = step.climb === true
        ? sendClimb(step, vehicle)
        : chain(deliver({ kind: 'GO_AROUND', expectMode: step.expectMode ?? PLANE_MODE_AUTO }), (sent) => {
          if (gate(sent)) return 0;
          const wrote = noteSent(sent, 'go_around');
          if (ackAccepted(sent)) return wrote;
          return chain(deliver({ kind: 'RTL', expectMode: step.expectMode ?? PLANE_MODE_AUTO }), (rtl) => {
            if (gate(rtl)) return wrote;
            return wrote + noteSent(rtl, 'rtl');
          });
        });
      return chain(abort, (extra) => {
        lastReason = 'go_around';
        return finish(prelude + extra, decision);
      });
    }
    if (step.action === 'release') {
      let sentNow = 0;
      if (sitl && heldKind === 'roll') {
        sentNow += noteSent(deliver({ kind: 'ROLL_OVERRIDE', release: true, rollPwm: 0 }), 'release');
      }
      held = false;
      heldKind = null;
      lastReason = step.reason || 'release';
      return finish(sentNow, decision);
    }
    if (step.action === 'handover') {
      if (!(linkUp && sitl)) return finish(0, decision);
      return chain(refreshMission(), (mission) => {
        if (mission && mission.ok === false) {
          markGoAround(vehicle);
          return chain(sendClimb({ climb: true }, vehicle), (extra) => finish(extra, decision));
        }
        const items = mission && Array.isArray(mission.items) ? mission.items : vehicle?.missionItems;
        const land = missionLandJump(items);
        if (!land) {
          markGoAround(vehicle);
          return chain(sendClimb({ climb: true }, vehicle), (extra) => finish(extra, decision));
        }
        const opened = deliver({ kind: 'ENTER_AUTO', expectMode: PLANE_MODE_GUIDED });
        return chain(opened, (modeSent) => {
          const stopped = gate(modeSent);
          if (stopped === 'stale') return releaseStale(decision);
          if (stopped) return finish(0, decision);
          const modeWrote = noteSent(modeSent, 'land');
          if (!autoAccepted(modeSent)) {
            const hb = Number(modeSent?.heartbeatMode);
            if (Number.isFinite(hb) && hb !== PLANE_MODE_GUIDED && hb !== PLANE_MODE_AUTO) {
              markCancelled();
              return finish(modeWrote, decision);
            }
            markGoAround(vehicle);
            return chain(sendClimb(step, vehicle), (extra) => finish(modeWrote + extra, decision));
          }
          const jump = land.useDoLandStart
            ? {
              kind: 'DO_LAND_START',
              lat: Number.isFinite(land.lat) ? land.lat : step.lat,
              lon: Number.isFinite(land.lon) ? land.lon : step.lon,
              expectMode: PLANE_MODE_AUTO,
            }
            : { kind: 'SET_CURRENT', seq: land.landSeq, expectMode: PLANE_MODE_AUTO };
          return chain(deliver(jump), (jumped) => {
            const jumpStop = gate(jumped);
            if (jumpStop === 'stale') return releaseStale(decision, modeWrote);
            if (jumpStop) return finish(modeWrote, decision);
            const jumpWrote = noteSent(jumped, 'land');
            if (!ackAccepted(jumped)) {
              markGoAround(vehicle);
              return chain(deliver({ kind: 'GO_AROUND', expectMode: PLANE_MODE_AUTO }), (sent) => {
                if (gate(sent)) return finish(modeWrote + jumpWrote, decision);
                const wrote = noteSent(sent, 'go_around');
                if (ackAccepted(sent)) return finish(modeWrote + jumpWrote + wrote, decision);
                return chain(deliver({ kind: 'RTL', expectMode: PLANE_MODE_AUTO }), (rtl) => {
                  if (gate(rtl)) return finish(modeWrote + jumpWrote + wrote, decision);
                  return finish(modeWrote + jumpWrote + wrote + noteSent(rtl, 'rtl'), decision);
                });
              });
            }
            vision.acceptHandover();
            lastVision = { ...lastVision, state: 'active', reason: 'land', labelHe: VISION_LAND_LABEL.active };
            lastReason = 'land';
            return finish(modeWrote + jumpWrote, decision);
          });
        });
      });
    }
    if (step.action === 'reposition') {
      if (!(linkUp && sitl)) return finish(0, decision);
      return chain(deliver({
        kind: 'REPOSITION',
        lat: step.lat,
        lon: step.lon,
        altM: step.altM,
        expectMode: PLANE_MODE_GUIDED,
      }), (sent) => {
        const stopped = gate(sent);
        if (stopped === 'stale') return releaseStale(decision);
        if (stopped) return finish(0, decision);
        if (!ackAccepted(sent)) {
          markGoAround(vehicle);
          return chain(sendClimb({ climb: true, rtl: false }, vehicle), (extra) => {
            lastReason = 'go_around';
            return finish(extra, decision);
          });
        }
        const wrote = noteSent(sent, 'glide');
        if (wrote) {
          held = true;
          heldKind = 'glide';
        }
        lastReason = 'glide';
        return finish(wrote, decision);
      });
    }
    if (step.action === 'guide' && lastGuidance) {
      if (!linkUp) {
        let sentNow = 0;
        if (held && sitl) {
          sentNow += noteSent(deliver({ kind: 'ROLL_OVERRIDE', release: true, rollPwm: 0 }), 'release');
          held = false;
          heldKind = null;
        }
        lastReason = 'link';
        return finish(sentNow, decision);
      }
      const wrote = noteSent(deliver({ ...lastGuidance, expectMode: PLANE_MODE_AUTO }), 'guide');
      if (lastReason === 'stale_heartbeat') return releaseStale(decision);
      if (lastReason === 'mode_changed') {
        markCancelled();
        return finish(0, decision);
      }
      if (wrote) {
        held = true;
        heldKind = 'roll';
      }
      lastReason = 'guide';
      return finish(wrote, decision);
    }
    if (decision.allow) lastReason = step.reason || decision.reason;
    return finish(0, decision);
  }

  return {
    status: () => view(),
    setLevel,
    setManualArm,
    requestOptical,
    note,
    tick,
    holding: () => held,
    commandsSent: () => commandsSent,
  };
}
