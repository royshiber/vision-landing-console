/**
 * Deterministic spoken/typed flight-intent detection for AIRVIX Ask.
 * Hebrew + English. Does not invent telemetry.
 *
 * Roy 2026-09-13 voice_session_go:
 * ARM / DISARM always blocked (never send).
 * LAND / RTL / return-home and mode changes are session flight ops.
 * Param set is confirm-required (oral OK). Param get is a readback.
 */

import { isAskBlockedParamKey, isAskSessionFlightOpKind } from './ask-safety.mjs';
import { ARDUPILOT_PLANE_MODES } from '../arduplane-flight-modes.mjs';

const PARAM_KEY = '([A-Z][A-Z0-9_]{1,15})';
const PARAM_NUM = '(-?\\d+(?:\\.\\d+)?)';

const PARAM_PROPOSE_PATTERNS = [
  new RegExp(`\\b(?:set|change|write|update)\\s+(?:param(?:eter)?\\s+)?${PARAM_KEY}\\s*(?:to|=)\\s*${PARAM_NUM}\\b`, 'i'),
  new RegExp(`\\b${PARAM_KEY}\\s*=\\s*${PARAM_NUM}\\b`),
  new RegExp(`(?:שנה|קבע|הגדר|עדכן)\\s+${PARAM_KEY}\\s+(?:ל־|ל-|ל\\s+|=)\\s*${PARAM_NUM}`),
];

const PARAM_GET_PATTERNS = [
  new RegExp(`\\b(?:what(?:'s| is)|read|get|show)\\s+(?:param(?:eter)?\\s+)?${PARAM_KEY}\\b`),
  new RegExp(`(?:מה|קרא|הצג)\\s+${PARAM_KEY}`),
];

const HARD_BLOCKED_PATTERNS = [
  { re: /\bdisarm\b/i, kind: 'DISARM' },
  { re: /נטרול|לנטרל|נטרל(?:\s|$)/, kind: 'DISARM' },
  { re: /\b(please\s+)?arm(\s+the)?(\s+(aircraft|plane|vehicle|motors?))?\b/i, kind: 'ARM' },
  { re: /חימוש|לחמש|חמש(?:\s+את)?(?:\s+המטוס)?(?:\s|$)/, kind: 'ARM' },
  { re: /\b(ekf|nav(?:igation)?\s+source).{0,40}\b(switch|change|inject)\b/i, kind: 'NAV_SOURCE_SWITCH' },
  { re: /\b(switch|change|inject).{0,40}\b(ekf|nav(?:igation)?\s+source|optical\s+nav)\b/i, kind: 'NAV_SOURCE_SWITCH' },
  { re: /החלף מקור ניווט|הזרק(?:ת)? אופטי|מקור ניווט בבקר/, kind: 'NAV_SOURCE_SWITCH' },
  { re: /\b(deploy|rollback)\b/i, kind: 'DEPLOY' },
  { re: /\b(restart|reboot)\b.+\b(service|jetson|systemd)\b/i, kind: 'RESTART_SERVICE' },
  { re: /\b(shell|bash|powershell|cmd\.exe)\b/i, kind: 'SHELL' },
  { re: /\b(start\s+agent|run\s+cursor)\b/i, kind: 'CURSOR_AGENT_START' },
];

const MODE_NAME_RE = Object.values(ARDUPILOT_PLANE_MODES)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');

const MODE_CHANGE_PATTERNS = [
  new RegExp(`\\bmode\\s+(?:change\\s+)?(?:to\\s+)?(${MODE_NAME_RE})\\b`, 'i'),
  new RegExp(`(?:שנה|החלף)\\s+מצב(?:\\s+טיסה)?\\s+(?:ל־|ל-|ל\\s+)?(${MODE_NAME_RE})`, 'i'),
  new RegExp(`(?:שנה|החלף)\\s+מצב(?:\\s+טיסה)?\\s+(?:ל־|ל-|ל\\s+)?([A-Z][A-Z0-9]{1,15})`, 'i'),
];

const READBACK_PATTERNS = [
  { re: /מה הגובה|גובה כמה|what(?:'s| is) (?:the )?alt(?:itude)?|read (?:the )?alt/i, topic: 'altitude' },
  { re: /מה המהירות|מהירות כמה|what(?:'s| is) (?:the )?(?:air)?speed|groundspeed/i, topic: 'speed' },
  { re: /מה המוד|מה מצב הטיסה|what(?:'s| is) (?:the )?(?:flight )?mode/i, topic: 'mode' },
  { re: /מה הסוללה|כמה סוללה|מתח סוללה|what(?:'s| is) (?:the )?battery/i, topic: 'battery' },
  { re: /מה ה.?gps|מצב gps|כמה לוויינ|gps status|how many sats/i, topic: 'gps' },
  { re: /מה הקישור|מצב קישור|link status|\brssi\b/i, topic: 'link' },
  { re: /מה אני רואה|מה מוצג|what am i (?:seeing|looking at)|what(?:'s| is) (?:this|going on)/i, topic: 'seeing' },
];

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function blockedResult(kind, extraSlots = {}) {
  return {
    blocked: true,
    prohibited: true,
    prohibited_action: kind,
    blocked_kind: kind,
    intent: 'UNRESOLVED',
    confidence: 1,
    reason: `blocked early-flight action: ${kind}`,
    slots: extraSlots,
  };
}

function flightOpResult(kind, slots = {}) {
  return {
    blocked: false,
    intent: 'FLIGHT_OP',
    confidence: 0.94,
    slots: { action: 'SEND_FLIGHT_OP', kind, ...slots },
  };
}

export function parseAskParamProposal(rawText) {
  const text = normalize(rawText);
  if (!text) return null;
  for (const re of PARAM_PROPOSE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const key = String(m[1] || '').toUpperCase();
    const value = Number(m[2]);
    if (!key || !Number.isFinite(value)) continue;
    return { key, value };
  }
  return null;
}

export function parseAskParamGet(rawText) {
  const text = normalize(rawText);
  if (!text) return null;
  for (const re of PARAM_GET_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const key = String(m[1] || '').toUpperCase();
    if (!key) continue;
    return { key };
  }
  return null;
}

function isLandingConfidenceQuery(text) {
  return /ביטחון נחיתה|landing confidence/i.test(text);
}

function parseLandOrRtl(text) {
  if (isLandingConfidenceQuery(text)) return null;
  if (/\b(land\s+now|auto[\s-]*land|autoland)\b/i.test(text) || /נחיתה אוטומטית|נחת(?:י|ה)?\s+עכשיו|נחיתה עכשיו/.test(text) || /^(נחת|נחיתה)$/.test(text) || /\bland\b/i.test(text)) {
    if (/\brtl\b/i.test(text) || /חזור הביתה|חזרה הביתה/.test(text)) {
      return 'RTL';
    }
    return 'LAND';
  }
  if (/\brtl\b/i.test(text) || /חזור הביתה|חזרה הביתה/.test(text)) return 'RTL';
  return null;
}

function parseModeChange(text) {
  if (/שנה מצב טיסה|החלף מצב טיסה/.test(text) && !MODE_CHANGE_PATTERNS.some((re) => re.test(text))) {
    return { kind: 'MODE_CHANGE', mode: null };
  }
  for (const re of MODE_CHANGE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const mode = String(m[1] || '').toUpperCase();
    return { kind: 'MODE_CHANGE', mode: mode || null };
  }
  return null;
}

export function resolveAskFlightIntent(rawText) {
  const text = normalize(rawText);
  if (!text) return null;

  for (const p of HARD_BLOCKED_PATTERNS) {
    if (p.re.test(text)) {
      return blockedResult(p.kind);
    }
  }

  const landRtl = parseLandOrRtl(text);
  if (landRtl && isAskSessionFlightOpKind(landRtl)) {
    return flightOpResult(landRtl);
  }

  const mode = parseModeChange(text);
  if (mode) {
    return flightOpResult('MODE_CHANGE', { mode: mode.mode });
  }

  const parsed = parseAskParamProposal(text);
  if (parsed) {
    if (isAskBlockedParamKey(parsed.key)) {
      return blockedResult('NAV_SOURCE_SWITCH', { key: parsed.key, value: parsed.value });
    }
    return {
      blocked: false,
      intent: 'FLIGHT_PARAM',
      confidence: 0.94,
      slots: {
        action: 'PROPOSE_PARAM_CHANGE',
        key: parsed.key,
        value: parsed.value,
      },
    };
  }

  const got = parseAskParamGet(text);
  if (got) {
    if (isAskBlockedParamKey(got.key)) {
      return blockedResult('NAV_SOURCE_SWITCH', { key: got.key });
    }
    return {
      blocked: false,
      intent: 'QUESTION',
      confidence: 0.9,
      slots: { topic: 'param_get', key: got.key },
    };
  }

  for (const p of READBACK_PATTERNS) {
    if (p.re.test(text)) {
      return {
        blocked: false,
        intent: 'QUESTION',
        confidence: 0.92,
        slots: { topic: p.topic },
      };
    }
  }

  return null;
}

export function isAskProblemRaised(rawText) {
  const q = normalize(rawText).toLowerCase();
  if (!q) return false;
  return (
    /יש בעיה|מה קורה|חסר|לא עובד|מנותק|אין גובה|אין מצלמה|לא מקליט/.test(q)
    || /\b(problem|issue|wrong|missing|disconnect|disconnected|no alt|no camera|recording off)\b/i.test(q)
  );
}
