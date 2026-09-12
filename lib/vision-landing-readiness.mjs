/**
 * Vision Landing Experiment #1 readiness — display only.
 * Locked scope: fixed-wing final, PIC hand-fly, observe-only runway detection.
 * Annotations and lock-status are follow-ons, not #1 blockers.
 * Never invent camera, heartbeat, or video. Never enables ARM / LAND / auto-land.
 */

export const VISION_LANDING_EXPERIMENT = 1;

export const VISION_LANDING_QUESTION_HE = 'אפשר להתחיל ניסוי אחד?';
export const VISION_LANDING_SCOPE_HE = 'גישה סופית. טייס מטיס. זיהוי מסלול לצפייה בלבד.';

export const VISION_LANDING_CHECK_IDS = Object.freeze([
  'jetson',
  'fc',
  'camera',
  'plnd',
  'video',
  'lock',
  'flightCommands',
]);

export const EXPERIMENT1_BLOCKER_IDS = Object.freeze(['jetson', 'fc', 'camera']);
export const EXPERIMENT1_FOLLOW_ON_IDS = Object.freeze(['plnd', 'video', 'lock', 'flightCommands']);

export const PLND_PROFILE_KEYS = Object.freeze(['PLND_ENABLED', 'PLND_TYPE']);
export const VISION_NAV_PROFILE_KEYS = Object.freeze(['vision_enable_alt_m', 'vision_conf_min']);

/** No console route registers a manual-record arm API today. */
export const MANUAL_RECORD_API_PRESENT = false;

export const CHIP_HE = Object.freeze({
  on: 'מוכן',
  warn: 'חלקי',
  off: 'חסר',
});

const FOLLOW_ON_HE = 'המשך. לא חוסם את ניסוי אחד.';

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstBool(...values) {
  for (const v of values) {
    if (v === true || v === false) return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
  }
  return null;
}

function hasKeys(source, keys) {
  const o = obj(source);
  if (!o) return false;
  return keys.every((k) => o[k] != null && o[k] !== '');
}

function chipRank(chip) {
  if (chip === 'off') return 0;
  if (chip === 'warn') return 1;
  if (chip === 'on') return 2;
  return 0;
}

function worstChip(chips) {
  let worst = 'on';
  for (const c of chips) {
    if (chipRank(c) < chipRank(worst)) worst = c;
  }
  return worst;
}

function item(id, nameHe, chip, state, missingHe, extra = {}) {
  const blocker = EXPERIMENT1_BLOCKER_IDS.includes(id);
  return {
    id,
    nameHe,
    chip: chip === 'on' || chip === 'warn' ? chip : 'off',
    chipHe: CHIP_HE[chip] || CHIP_HE.off,
    state,
    missingHe,
    role: blocker ? 'blocker' : 'followOn',
    blocker,
    ...extra,
  };
}

export function jetsonReadiness({ companion } = {}) {
  const link = obj(companion) || {};
  const jetson = String(link.jetson || 'off');
  if (jetson === 'reachable' || jetson === 'mock') {
    if (link.hasData === false) {
      return item('jetson', 'מחשב משימה', 'warn', 'reachable', 'מחשב משימה מגיב. אין נתונים.');
    }
    return item('jetson', 'מחשב משימה', 'on', jetson, 'מחשב משימה מגיע.');
  }
  if (jetson === 'unreachable') {
    return item('jetson', 'מחשב משימה', 'warn', 'unreachable', 'מחשב משימה לא מגיב.');
  }
  return item('jetson', 'מחשב משימה', 'off', 'off', 'מחשב משימה לא מחובר.');
}

export function fcReadiness({ companion, mavlink } = {}) {
  const link = obj(companion) || {};
  const mav = obj(mavlink) || {};
  const fc = String(link.fc || 'unknown');
  const localHb = Number(mav.heartbeatCount) > 0
    || (typeof mav.lastHeartbeatAgeMs === 'number' && mav.lastHeartbeatAgeMs < 5000);
  const localUp = mav.connected === true;

  if (fc === 'heartbeat' || (localUp && localHb && (fc === 'heartbeat' || link.fc_heartbeat === true))) {
    return item('fc', 'דופק בקר', 'on', 'heartbeat', 'יש דופק בקר.');
  }
  if (localUp && localHb) {
    return item('fc', 'דופק בקר', 'on', 'heartbeat', 'יש דופק מקומי.');
  }
  if (fc === 'linked' || (localUp && !localHb)) {
    return item('fc', 'דופק בקר', 'warn', 'linked', 'יש קישור. אין דופק חי.');
  }
  if (fc === 'unlinked') {
    return item('fc', 'דופק בקר', 'off', 'unlinked', 'אין קישור לבקר.');
  }
  return item('fc', 'דופק בקר', 'off', 'unknown', 'אין דופק בקר. המצב לא ידוע.');
}

/**
 * Observe-only runway detection. unknown / absent / ok only from reported fields.
 * Missing snapshot is unknown — never ok.
 */
export function cameraReadiness({ companion, vision } = {}) {
  const link = obj(companion) || {};
  const jetson = String(link.jetson || 'off');
  const reachable = jetson === 'reachable' || jetson === 'mock';
  if (!reachable) {
    return item('camera', 'זיהוי מסלול', 'off', 'unknown', 'אין זיהוי מסלול לצפייה. מחשב משימה לא מגיע.');
  }
  const v = obj(vision);
  if (!v) {
    return item('camera', 'זיהוי מסלול', 'warn', 'unknown', 'זיהוי מסלול לא ידוע. אין דיווח צינור ראייה.');
  }
  const cameraOk = firstBool(v.camera_ok, v.cameraOk);
  if (cameraOk === true) {
    const running = v.running === true
      || v.status === 'ok'
      || v.health === 'ok'
      || v.health === 'healthy';
    if (running) {
      return item('camera', 'זיהוי מסלול', 'on', 'ok', 'זיהוי מסלול לצפייה פעיל.');
    }
    return item('camera', 'זיהוי מסלול', 'warn', 'ok', 'מצלמה קיימת. זיהוי מסלול לא מדווח כפעיל.');
  }
  if (cameraOk === false) {
    return item('camera', 'זיהוי מסלול', 'off', 'absent', 'אין זיהוי מסלול לצפייה.');
  }
  return item('camera', 'זיהוי מסלול', 'warn', 'unknown', 'זיהוי מסלול לא ידוע.');
}

export function plndReadiness({ arduTarget, arduCurrent, visionProfile } = {}) {
  const current = obj(arduCurrent);
  const target = obj(arduTarget);
  const profile = obj(visionProfile);
  const onFc = current && current.PLND_ENABLED != null;
  const targetPresent = hasKeys(target, PLND_PROFILE_KEYS);
  const visionNavPresent = hasKeys(profile, VISION_NAV_PROFILE_KEYS);
  const consolePresent = targetPresent || visionNavPresent;

  if (onFc) {
    const enabled = Number(current.PLND_ENABLED) === 1;
    if (enabled) {
      return item('plnd', 'פרופיל נחיתה מדויקת', 'on', 'present', `פרופיל קיים בבקר. ${FOLLOW_ON_HE}`);
    }
    return item('plnd', 'פרופיל נחיתה מדויקת', 'warn', 'present', `פרופיל כבוי בבקר. ${FOLLOW_ON_HE}`);
  }
  if (consolePresent) {
    return item('plnd', 'פרופיל נחיתה מדויקת', 'warn', 'console', `יש פרופיל בקונסולה. ${FOLLOW_ON_HE}`);
  }
  return item('plnd', 'פרופיל נחיתה מדויקת', 'warn', 'absent', FOLLOW_ON_HE);
}

export function videoReadiness({ dual, video } = {}) {
  const snap = obj(dual) || {};
  const avail = obj(snap.video) || obj(video) || {};
  const cellular = String(snap.cellular || '');
  const reason = String(avail.reason || '');
  if (avail.available === true || cellular === 'connected') {
    return item('video', 'סימון', 'on', 'available', `סימון זמין בסלולר. ${FOLLOW_ON_HE}`);
  }
  if (reason === 'modem_absent' || cellular === 'modem_absent' || snap.modemPresent === false) {
    return item('video', 'סימון', 'warn', 'modem_absent', `אין סימון. מודם סלולר חסר. ${FOLLOW_ON_HE}`);
  }
  if (reason === 'cellular_disconnected' || cellular === 'disconnected') {
    return item('video', 'סימון', 'warn', 'disconnected', `אין סימון. סלולר מנותק. ${FOLLOW_ON_HE}`);
  }
  return item('video', 'סימון', 'warn', 'missing', FOLLOW_ON_HE);
}

/**
 * Lock-status / recording. Armed only when a real manual-record API reports it.
 * Follow-on for Experiment #1. Absent API → honest not-locked default.
 */
export function recordingReadiness({ recording } = {}) {
  const rec = obj(recording) || {};
  const apiPresent = rec.apiPresent === true;
  if (!apiPresent) {
    return item(
      'lock',
      'נעילה',
      'warn',
      'not_recording',
      `אין מצב נעילה. ${FOLLOW_ON_HE}`,
      { apiPresent: false, armed: false },
    );
  }
  if (rec.armed === true) {
    return item('lock', 'נעילה', 'on', 'armed', `יש נעילה. ${FOLLOW_ON_HE}`, { apiPresent: true, armed: true });
  }
  return item(
    'lock',
    'נעילה',
    'warn',
    'not_recording',
    `אין נעילה. ${FOLLOW_ON_HE}`,
    { apiPresent: true, armed: false },
  );
}

export function flightCommandReadiness() {
  return item(
    'flightCommands',
    'פקודות טיסה',
    'warn',
    'gated',
    'טייס מטיס. פקודות מהמסך חסומות. אין חימוש או נחיתה.',
    {
      enabled: false,
      humanGate: 29,
      sendsArm: false,
      sendsLand: false,
      sendsAutoLand: false,
    },
  );
}

export function buildVisionLandingReadiness(input = {}) {
  const items = [
    jetsonReadiness(input),
    fcReadiness(input),
    cameraReadiness(input),
    plndReadiness(input),
    videoReadiness(input),
    recordingReadiness(input),
    flightCommandReadiness(),
  ];
  const blockerItems = items.filter((row) => row.blocker);
  const blockersReady = blockerItems.every((row) => row.chip === 'on');
  const flight = items.find((row) => row.id === 'flightCommands');
  const experimentReady = blockersReady;
  let answerHe;
  if (experimentReady) {
    answerHe = 'כן. ניסוי אחד. גישה סופית. טייס מטיס. זיהוי מסלול לצפייה.';
  } else {
    const missing = blockerItems.filter((row) => row.chip !== 'on').map((row) => row.nameHe);
    answerHe = missing.length
      ? `לא. חסר ${missing.join(' · ')}.`
      : 'לא. חסר זיהוי מסלול לצפייה.';
  }
  const overallChip = experimentReady ? 'on' : worstChip(blockerItems.map((r) => r.chip));
  return {
    ok: true,
    experiment: VISION_LANDING_EXPERIMENT,
    questionHe: VISION_LANDING_QUESTION_HE,
    scopeHe: VISION_LANDING_SCOPE_HE,
    answerHe,
    experimentReady,
    sensorsReady: blockersReady,
    overallChip,
    items,
    flightCommandsEnabled: false,
    humanGate: { id: 29, enabled: false },
    picHandFly: true,
    observeOnly: true,
    flightCommandsGated: flight?.enabled === false,
  };
}

export function resolveManualRecordState(ctx = {}) {
  const rec = obj(ctx.manualRecord) || obj(ctx.recording);
  if (rec && rec.apiPresent === true) {
    return { apiPresent: true, armed: rec.armed === true };
  }
  return { apiPresent: MANUAL_RECORD_API_PRESENT, armed: false };
}
