/**
 * Deterministic AIRVIX Ask answers for live status questions.
 * Uses only telemetry already on the Assist context. Never calls Gemini.
 * Never sends a flight command.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiModelChain } from '../gemini-model.mjs';
import { hebrewGpsAnswer } from './assist-hebrew.mjs';
import { CAMERA_NAME_HE } from '../../public/modules/camera-names.mjs';
import { askRemotePaused } from '../qa-mode.mjs';

export const ASK_NO_GEMINI_HE = 'אין מפתח Gemini במחשב הזה, אני עונה רק על שאלות מצב בסיסיות';

const FSI = '\u2068';
const PDI = '\u2069';

const STATUS_TOPICS = Object.freeze([
  'prearm',
  'cameras',
  'jetson',
  'armed',
  'battery',
  'link_quality',
  'gps_ekf',
  'mode',
  'fc_link',
]);

function norm(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNum(value, digits = 1) {
  const n = finite(value);
  if (n == null) return null;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

function ltr(token) {
  const s = String(token || '').trim();
  if (!s) return '';
  return `${FSI}${s}${PDI}`;
}

/**
 * @returns {'prearm'|'cameras'|'jetson'|'armed'|'battery'|'link_quality'|'gps_ekf'|'mode'|'fc_link'|null}
 */
export function classifyAskStatusQuestion(text) {
  const q = norm(text);
  if (!q) return null;
  if (/לא ניתן לחמש|אי אפשר לחמש|למה(?:\s+\S+){0,6}\s*חמש|pre-?arm|why can.?t i arm|why am i not arm/.test(q)) {
    return 'prearm';
  }
  if (/מצלמ|cam0|cam1|זרם הווידאו|streaming|האם יש וידאו/.test(q)) return 'cameras';
  if (/jetson|מחשב משימה|מחשב המשימה|\bcompanion\b/.test(q)) return 'jetson';
  if (/חמוש|\barmed\b|מצב חימוש/.test(q)) return 'armed';
  if (/סוללה|\bbattery\b|מתח הסוללה/.test(q)) return 'battery';
  if (/איכות הקישור|איכות קישור|איכות הקשר|מצב הקישור|link quality|\brssi\b|כמה (?:חזק|טוב) הקישור/.test(q)) {
    return 'link_quality';
  }
  if (/\bgps\b|אקף|\bekf\b|לוויין/.test(q)) return 'gps_ekf';
  if (/מצב הטיסה|מצב טיסה|flight mode|באיזה מצב|מה המוד|איזה מוד|\bmode\b/.test(q)) return 'mode';
  if (/מחובר|חיבור|לבקר|הבקר|בקר הטיסה|flight controller|\bfc\b|\bconnected\b/.test(q)) return 'fc_link';
  return null;
}

export function isAskStatusTopic(topic) {
  return STATUS_TOPICS.includes(topic);
}

function linkPathHe(path) {
  const p = String(path || '').trim().toLowerCase();
  if (p === 'cellular' || p === 'cell' || p === 'lte') return 'סלולר';
  if (p === 'rf' || p === 'radio' || p === 'serial') return 'RF';
  if (p === 'usb') return 'USB';
  if (p === 'sitl' || p === 'sim' || p === 'simulator') return 'סימולטור';
  return null;
}

function loopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** Same words as the header pill: a SITL TCP 5760 link is סימולטור, not RF. */
export function fcLinkPhrase(ac) {
  if (!ac || ac.connected === false) return null;
  if (ac.simulator === true) return 'סימולטור';
  const port = Number(ac.link_port ?? ac.port);
  const type = String(ac.link_type || ac.type || '').toLowerCase();
  const host = ac.link_host || ac.host || '';
  if (port === 5760 && loopbackHost(host) && (type === 'tcp' || type === 'udp' || type === '')) {
    return 'סימולטור';
  }
  return linkPathHe(ac.link_path);
}

function answerFcLink(ac) {
  if (ac?.connected !== true) return 'בקר הטיסה אינו מחובר.';
  const path = fcLinkPhrase(ac);
  if (path) return `בקר הטיסה מחובר דרך ${path}.`;
  return 'בקר הטיסה מחובר. אין נתון על המסלול.';
}

function answerMode(ac) {
  if (ac?.connected !== true) return 'אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.';
  const mode = String(ac?.flight_mode || '').trim();
  if (!mode) return 'אין מצב טיסה.';
  return `מצב הטיסה הוא ${ltr(mode)}.`;
}

function answerArmed(ac) {
  if (ac?.armed === true) return 'בקר הטיסה חמוש.';
  if (ac?.armed === false) return 'בקר הטיסה אינו חמוש.';
  return 'אין נתון על חימוש.';
}

function answerBattery(ac) {
  const v = formatNum(ac?.battery_v, 1);
  const pct = finite(ac?.battery_pct);
  if (v == null && pct == null) return 'אין נתון סוללה.';
  if (v != null && pct != null) return `הסוללה ${v} וולט, ${Math.round(pct)} אחוז.`;
  if (v != null) return `הסוללה ${v} וולט.`;
  return `הסוללה ${Math.round(pct)} אחוז.`;
}

function answerLinkQuality(ac) {
  const q = finite(ac?.link_quality);
  if (q != null) return `איכות הקישור ${Math.round(q)} אחוז.`;
  const label = String(ac?.link_label || '').trim();
  if (label) return `איכות הקישור ${ltr(label)}.`;
  return 'אין נתון על איכות הקישור.';
}

/** Keep aligned with translateFcStatusText in public/app.js. EKF3 before a generic GPS wait. */
const STATUS_RULES = [
  [/ekf3 waiting for gps config/i, 'EKF3 ממתינים להגדרת GPS'],
  [/ahrs:.*waiting for home|waiting for home/i, 'ממתינים לנקודת בית'],
  [/waiting for rc/i, 'נדרש שלט RC'],
  [/imu\d*.*using gps|is using gps/i, 'EKF משתמש ב-GPS'],
  [/ekf variance/i, 'סטיית EKF גבוהה'],
  [/gps\s*\d*\s*:\s*not healthy/i, 'GPS לא תקין'],
  [/battery failsafe/i, 'כשל סוללה'],
  [/waiting for gps/i, 'ממתינים ל-GPS'],
  [/compass not healthy/i, 'המצפן לא תקין'],
  [/3d accel calibration needed/i, 'נדרש כיול מד תאוצה'],
  [/gps speed error/i, 'שגיאת מהירות GPS'],
  [/need 3d fix|need gps/i, 'נדרש מיקום GPS'],
  [/waiting for navigation/i, 'ממתינים לבדיקות ניווט'],
  [/rc not (calibrated|found)/i, 'נדרש כיול שלט'],
  [/throttle/i, 'המצערת לא במצב נמוך'],
  [/safety switch/i, 'מתג הבטיחות פתוח'],
  [/gyro/i, 'נדרש כיול גירוסקופ'],
  [/accel/i, 'נדרש כיול מד תאוצה'],
  [/compass|mag field/i, 'נדרש כיול מצפן'],
  [/ahrs not healthy/i, 'מערכת הייחוס לא תקינה'],
  [/battery/i, 'הסוללה לא תקינה'],
  [/radio failsafe/i, 'אבד קשר RF'],
  [/logging failed/i, 'הרישום נכשל'],
  [/ekf/i, 'EKF לא תקין'],
  [/baro/i, 'מד הגובה לא תקין'],
  [/fence/i, 'נדרש מיקום לגדר'],
];

export function isArmBlockerText(raw) {
  const line = String(raw || '');
  return /pre-?arm|ekf3 waiting|waiting for home|waiting for rc|not healthy|calibration needed|need 3d fix|need gps|safety switch|rc not|ekf variance/i.test(line);
}

export function translateAskStatusLine(raw) {
  const line = String(raw || '').trim();
  if (!line) return '';
  const prearm = /^prearm\s*:/i.test(line);
  let he = '';
  for (const [re, text] of STATUS_RULES) {
    if (re.test(line)) {
      he = text;
      break;
    }
  }
  if (!he) he = line;
  if ((prearm || isArmBlockerText(line)) && !he.startsWith('לא ניתן לחמש')) {
    return `לא ניתן לחמש: ${he}`;
  }
  return he;
}

function statusTextList(ac) {
  const raw = Array.isArray(ac?.status_texts) ? ac.status_texts : [];
  return raw.map((row) => (typeof row === 'string' ? row : row?.text)).filter(Boolean);
}

function answerPrearm(ac) {
  const seen = new Set();
  const parts = [];
  for (const raw of statusTextList(ac)) {
    if (!isArmBlockerText(raw)) continue;
    const he = translateAskStatusLine(raw).replace(/\.$/, '');
    if (!he || seen.has(he)) continue;
    seen.add(he);
    parts.push(he);
    if (parts.length >= 6) break;
  }
  if (!parts.length) return 'אין הודעות שחוסמות חימוש.';
  return `${parts.join('. ')}.`;
}

function answerGpsEkf(ac) {
  const sats = finite(ac?.gps_sats);
  const ekf = ac?.ekf_ok;
  const blocker = statusTextList(ac).map(translateAskStatusLine).find((line) => /EKF/.test(line));
  const hasRich = sats != null || typeof ekf === 'boolean' || Boolean(blocker);
  if (!hasRich) return hebrewGpsAnswer(ac?.gps_ok);
  const bits = [];
  if (ac?.gps_ok === true) bits.push(sats != null ? `GPS תקין, ${Math.round(sats)} לוויינים` : 'GPS תקין');
  else if (ac?.gps_ok === false) bits.push(sats != null ? `GPS אינו תקין, ${Math.round(sats)} לוויינים` : 'GPS אינו תקין');
  else if (sats != null) bits.push(`${Math.round(sats)} לוויינים`);
  else bits.push('אין נתון GPS');
  if (ekf === true) bits.push('EKF תקין');
  else if (ekf === false) bits.push('EKF אינו תקין');
  else if (blocker) bits.push(blocker.replace(/^לא ניתן לחמש:\s*/, ''));
  return `${bits.join('. ')}.`;
}

export function cameraQuestionFocus(text) {
  const q = norm(text);
  if (!q || /מצלמות/.test(q)) return null;
  if (/גימבל|\bcam3\b/.test(q)) return 'cam3';
  return null;
}

const SPOKEN_CAMERA = Object.freeze({
  cam0: { on: 'מצלמה קדמית משדרת', off: 'מצלמה קדמית אינה משדרת', unknown: 'אין נתון על הקדמית' },
  cam1: { on: 'מצלמת מטה משדרת', off: 'מצלמת מטה אינה משדרת', unknown: 'אין נתון על המטה' },
  cam3: { on: 'מצלמת הגימבל משדרת', off: 'מצלמת הגימבל אינה משדרת', unknown: 'אין נתון על זרם מצלמת הגימבל' },
});

function cameraStreamBit(id, value) {
  const row = SPOKEN_CAMERA[id];
  if (!row || !CAMERA_NAME_HE[id]) return null;
  if (value === true) return row.on;
  if (value === false) return row.off;
  return row.unknown;
}

function answerCameras(ops, text) {
  const focus = cameraQuestionFocus(text);
  const ids = focus === 'cam3' ? ['cam3'] : ['cam0', 'cam1', 'cam3'];
  const cams = ops?.cameras;
  const known = ids.some((id) => cams?.[id] === true || cams?.[id] === false);
  if (!known) return focus === 'cam3' ? 'אין נתון על זרם מצלמת הגימבל.' : 'אין נתון על זרם המצלמות.';
  const parts = ids.map((id) => cameraStreamBit(id, cams?.[id])).filter(Boolean);
  if (!parts.length) return 'אין נתון על זרם המצלמות.';
  return `${parts.join('. ')}.`;
}

function answerJetson(ops) {
  const state = String(ops?.jetson || '').trim();
  if (state === 'reachable') return 'מחשב משימה (Jetson) מחובר.';
  if (state === 'unreachable') return 'מחשב משימה (Jetson) אינו מגיב.';
  if (state === 'off') return 'מחשב משימה (Jetson) כבוי.';
  if (state === 'mock') return 'מחשב משימה (Jetson) במצב הדמיה.';
  return 'אין נתון על מחשב משימה (Jetson).';
}

export function answerAskStatus(topic, ctx, text) {
  const ac = ctx?.aircraft_state || null;
  const ops = ctx?.ops_signals || null;
  if (topic === 'fc_link') return answerFcLink(ac);
  if (topic === 'mode') return answerMode(ac);
  if (topic === 'armed') return answerArmed(ac);
  if (topic === 'battery') return answerBattery(ac);
  if (topic === 'link_quality') return answerLinkQuality(ac);
  if (topic === 'prearm') return answerPrearm(ac);
  if (topic === 'gps_ekf') return answerGpsEkf(ac);
  if (topic === 'cameras') return answerCameras(ops, text);
  if (topic === 'jetson') return answerJetson(ops);
  return null;
}

export function askStatusFacts(ctx) {
  const ac = ctx?.aircraft_state || {};
  const ops = ctx?.ops_signals || {};
  const prearm = [];
  const seen = new Set();
  for (const raw of statusTextList(ac)) {
    if (!isArmBlockerText(raw)) continue;
    const he = translateAskStatusLine(raw);
    if (!he || seen.has(he)) continue;
    seen.add(he);
    prearm.push(he);
    if (prearm.length >= 6) break;
  }
  const cameras = ops.cameras && typeof ops.cameras === 'object'
    ? {
      cam0: typeof ops.cameras.cam0 === 'boolean' ? ops.cameras.cam0 : null,
      cam1: typeof ops.cameras.cam1 === 'boolean' ? ops.cameras.cam1 : null,
      ...(typeof ops.cameras.cam3 === 'boolean' ? { cam3: ops.cameras.cam3 } : {}),
    }
    : null;
  return {
    fc_connected: ac.connected === true,
    link_path: ac.link_path || null,
    simulator: ac.simulator === true,
    link_port: Number.isFinite(Number(ac.link_port)) ? Number(ac.link_port) : null,
    link_host: ac.link_host || null,
    link_type: ac.link_type || null,
    flight_mode: ac.flight_mode || null,
    armed: typeof ac.armed === 'boolean' ? ac.armed : null,
    gps_ok: typeof ac.gps_ok === 'boolean' ? ac.gps_ok : null,
    gps_sats: finite(ac.gps_sats),
    ekf_ok: typeof ac.ekf_ok === 'boolean' ? ac.ekf_ok : null,
    battery_v: finite(ac.battery_v),
    battery_pct: finite(ac.battery_pct),
    link_quality: finite(ac.link_quality),
    link_label: ac.link_label || null,
    prearm,
    cameras,
    jetson: ops.jetson || null,
  };
}

const GEMINI_STATUS_SYSTEM = [
  'You are AIRVIX Ask. Answer the operator in Hebrew.',
  'Use only the telemetry JSON. Do not invent numbers, satellite counts, or connection state.',
  'Call the flight controller בקר הטיסה. Never call it המטוס or הרחפן.',
  'Keep GPS, EKF, RF, Jetson, CAM0, and CAM1 in English.',
  'One or two short sentences. Do not send flight commands. Do not suggest arming or disarming.',
  'If the JSON lacks the fact, say אין נתון.',
].join('\n');

/**
 * Open questions only. Status questions stay on answerAskStatus.
 * Returns null when there is no key, under Vitest, or the call fails.
 * Tests inject their own function and must not reach the network.
 */
export async function answerAskWithGemini({ question, facts } = {}) {
  if (askRemotePaused()) return null;
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  const q = String(question || '').trim();
  if (!q) return null;
  const payload = JSON.stringify(facts && typeof facts === 'object' ? facts : {});
  const genAI = new GoogleGenerativeAI(apiKey);
  for (const modelId of getGeminiModelChain()) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        systemInstruction: GEMINI_STATUS_SYSTEM,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 180,
        },
      });
      const result = await model.generateContent(`Telemetry JSON:\n${payload}\n\nQuestion:\n${q}`);
      const text = String(result?.response?.text?.() || '').trim();
      if (text) return text;
    } catch {
      /* try next model */
    }
  }
  return null;
}
