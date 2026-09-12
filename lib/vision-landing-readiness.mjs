/**
 * Vision Landing experiment readiness — display only.
 * Honest chips from known snapshots. Never invent camera, heartbeat, or video.
 * Never enables ARM / LAND / auto-land. Flight commands stay Human Gate #29.
 */

export const VISION_LANDING_QUESTION_HE = 'אפשר להתחיל ניסוי נחיתה ויזואלית?';

export const VISION_LANDING_CHECK_IDS = Object.freeze([
  'jetson',
  'fc',
  'camera',
  'plnd',
  'video',
  'recording',
  'flightCommands',
]);

export const PLND_PROFILE_KEYS = Object.freeze(['PLND_ENABLED', 'PLND_TYPE']);
export const VISION_NAV_PROFILE_KEYS = Object.freeze(['vision_enable_alt_m', 'vision_conf_min']);

/** No console route registers a manual-record arm API today. */
export const MANUAL_RECORD_API_PRESENT = false;

export const CHIP_HE = Object.freeze({
  on: 'מוכן',
  warn: 'חלקי',
  off: 'חסר',
});

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
  return {
    id,
    nameHe,
    chip: chip === 'on' || chip === 'warn' ? chip : 'off',
    chipHe: CHIP_HE[chip] || CHIP_HE.off,
    state,
    missingHe,
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
 * Camera / vision pipeline. unknown / absent / ok only from reported fields.
 * Missing snapshot is unknown — never ok.
 */
export function cameraReadiness({ companion, vision } = {}) {
  const link = obj(companion) || {};
  const jetson = String(link.jetson || 'off');
  const reachable = jetson === 'reachable' || jetson === 'mock';
  if (!reachable) {
    return item('camera', 'מצלמה', 'off', 'unknown', 'אין דיווח מצלמה. מחשב משימה לא מגיע.');
  }
  const v = obj(vision);
  if (!v) {
    return item('camera', 'מצלמה', 'warn', 'unknown', 'מצב מצלמה לא ידוע. אין דיווח צינור ראייה.');
  }
  const cameraOk = firstBool(v.camera_ok, v.cameraOk);
  if (cameraOk === true) {
    const running = v.running === true
      || v.status === 'ok'
      || v.health === 'ok'
      || v.health === 'healthy';
    if (running) {
      return item('camera', 'מצלמה', 'on', 'ok', 'צינור ראייה פעיל.');
    }
    return item('camera', 'מצלמה', 'warn', 'ok', 'מצלמה קיימת. צינור ראייה לא מדווח כפעיל.');
  }
  if (cameraOk === false) {
    return item('camera', 'מצלמה', 'off', 'absent', 'מצלמה חסרה או לא תקינה.');
  }
  return item('camera', 'מצלמה', 'warn', 'unknown', 'מצב מצלמה לא ידוע.');
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
      return item('plnd', 'פרופיל נחיתה מדויקת', 'on', 'present', 'פרופיל נחיתה מדויקת בבקר.');
    }
    return item('plnd', 'פרופיל נחיתה מדויקת', 'warn', 'present', 'פרופיל קיים. נחיתה מדויקת כבויה בבקר.');
  }
  if (consolePresent) {
    return item('plnd', 'פרופיל נחיתה מדויקת', 'warn', 'console', 'יש פרופיל בקונסולה. לא נקרא מהבקר.');
  }
  return item('plnd', 'פרופיל נחיתה מדויקת', 'off', 'absent', 'אין פרופיל נחיתה מדויקת.');
}

export function videoReadiness({ dual, video } = {}) {
  const snap = obj(dual) || {};
  const avail = obj(snap.video) || obj(video) || {};
  const cellular = String(snap.cellular || '');
  const reason = String(avail.reason || '');
  if (avail.available === true || cellular === 'connected') {
    return item('video', 'וידאו מסומן', 'on', 'available', 'וידאו מסומן זמין בסלולר.');
  }
  if (reason === 'modem_absent' || cellular === 'modem_absent' || snap.modemPresent === false) {
    return item('video', 'וידאו מסומן', 'off', 'modem_absent', 'אין וידאו מסומן. מודם סלולר חסר.');
  }
  if (reason === 'cellular_disconnected' || cellular === 'disconnected') {
    return item('video', 'וידאו מסומן', 'off', 'disconnected', 'אין וידאו מסומן. סלולר מנותק.');
  }
  return item('video', 'וידאו מסומן', 'off', 'missing', 'אין וידאו מסומן.');
}

/**
 * Recording is armed only when a real manual-record API reports it.
 * Absent API → honest not-recording default. Never invent armed.
 */
export function recordingReadiness({ recording } = {}) {
  const rec = obj(recording) || {};
  const apiPresent = rec.apiPresent === true;
  if (!apiPresent) {
    return item(
      'recording',
      'הקלטה',
      'off',
      'not_recording',
      'אין הקלטה. אין ממשק הקלטה ידנית.',
      { apiPresent: false, armed: false },
    );
  }
  if (rec.armed === true) {
    return item('recording', 'הקלטה', 'on', 'armed', 'הקלטה חמושה.', { apiPresent: true, armed: true });
  }
  return item(
    'recording',
    'הקלטה',
    'off',
    'not_recording',
    'אין הקלטה חמושה.',
    { apiPresent: true, armed: false },
  );
}

export function flightCommandReadiness() {
  return item(
    'flightCommands',
    'פקודות טיסה',
    'off',
    'gated',
    'פקודות טיסה חסומות. אין חימוש או נחיתה מהמסך.',
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
  const sensorIds = new Set(['jetson', 'fc', 'camera', 'plnd']);
  const sensorItems = items.filter((row) => sensorIds.has(row.id));
  const sensorsReady = sensorItems.every((row) => row.chip === 'on');
  const flight = items.find((row) => row.id === 'flightCommands');
  const experimentReady = sensorsReady && flight?.enabled === true;
  let answerHe;
  if (experimentReady) {
    answerHe = 'כן. אפשר להתחיל ניסוי.';
  } else if (sensorsReady) {
    answerHe = 'לא. החיישנים מוכנים. פקודות טיסה חסומות.';
  } else {
    const missing = sensorItems.filter((row) => row.chip !== 'on').map((row) => row.nameHe);
    answerHe = missing.length
      ? `לא. חסר ${missing.join(' · ')}.`
      : 'לא. חסרים תנאים.';
  }
  const overallChip = experimentReady ? 'on' : sensorsReady ? 'warn' : worstChip(items.map((r) => r.chip));
  return {
    ok: true,
    questionHe: VISION_LANDING_QUESTION_HE,
    answerHe,
    experimentReady: false,
    sensorsReady,
    overallChip,
    items,
    flightCommandsEnabled: false,
    humanGate: { id: 29, enabled: false },
  };
}

export function resolveManualRecordState(ctx = {}) {
  const rec = obj(ctx.manualRecord) || obj(ctx.recording);
  if (rec && rec.apiPresent === true) {
    return { apiPresent: true, armed: rec.armed === true };
  }
  return { apiPresent: MANUAL_RECORD_API_PRESENT, armed: false };
}
