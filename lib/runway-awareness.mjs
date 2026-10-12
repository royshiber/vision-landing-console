/**
 * Runway awareness gate for the console.
 * Levels 0–2 never call the link. Level 3 may send a roll override only when
 * the vehicle is SITL. Level 4 stays refused unless the env flag is on and
 * the operator confirmed in Hebrew. A hazard on the strip suppresses the send.
 */

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

export function createRunwayController({ link, env = process.env } = {}) {
  let level = readRunwayLevel(env);
  let confirmed = false;
  let commandsSent = 0;
  let lastEstimate = null;
  let lastGuidance = null;
  let lastReason = level === 0 ? 'off' : 'observe_only';
  let held = false;

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

  function tick({ estimate = undefined, vehicle = null } = {}) {
    takeEstimate(estimate);
    const decision = decide(vehicle);
    const sitl = vehicle?.simulator === true;
    const linkUp = vehicle?.connected === true;
    let sentNow = 0;
    if (decision.allow && linkUp && lastGuidance) {
      const result = deliver(lastGuidance);
      if (result?.sent === true) {
        sentNow = 1;
        commandsSent += 1;
        held = true;
      } else if (result?.reason) {
        lastReason = result.reason;
      }
    } else if (held && sitl) {
      const result = deliver({ kind: 'ROLL_OVERRIDE', release: true, rollPwm: 0 });
      held = false;
      if (result?.sent === true) {
        sentNow = 1;
        commandsSent += 1;
        lastReason = 'release';
      } else if (result?.reason) {
        lastReason = result.reason;
      }
    }
    return { ...view({ sentNow, allowSend: false, holding: held }), decision };
  }

  return {
    status: () => view(),
    setLevel,
    note,
    tick,
    holding: () => held,
    commandsSent: () => commandsSent,
  };
}
