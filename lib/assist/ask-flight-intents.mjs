/**
 * Deterministic spoken/typed flight-intent detection for AIRVIX Ask.
 * Hebrew + English. Does not invent telemetry. Does not send FC commands.
 *
 * Roy 2026-09-12: SAFE param intents become confirm-required proposals.
 * ARM / LAND / RTL / auto-land / live nav switch stay blocked (Human Gate).
 */

import { isAskBlockedParamKey } from './ask-safety.mjs';

const PARAM_KEY = '([A-Z][A-Z0-9_]{1,15})';
const PARAM_NUM = '(-?\\d+(?:\\.\\d+)?)';

const PARAM_PROPOSE_PATTERNS = [
  new RegExp(`\\b(?:set|change|write|update)\\s+(?:param(?:eter)?\\s+)?${PARAM_KEY}\\s*(?:to|=)\\s*${PARAM_NUM}\\b`, 'i'),
  new RegExp(`\\b${PARAM_KEY}\\s*=\\s*${PARAM_NUM}\\b`),
  new RegExp(`(?:שנה|קבע|הגדר|עדכן)\\s+${PARAM_KEY}\\s+(?:ל־|ל-|ל\\s+|=)\\s*${PARAM_NUM}`),
];

const BLOCKED_PATTERNS = [
  { re: /\bdisarm\b/i, kind: 'DISARM' },
  { re: /\barm\b/i, kind: 'ARM' },
  { re: /חימוש|לחמש|חמש(?:\s|$)|נטרול|לנטרל|נטרל(?:\s|$)/, kind: 'ARM' },
  { re: /\b(land\s+now|auto[\s-]*land|autoland|rtl)\b/i, kind: 'LANDING_COMMAND' },
  { re: /נחיתה אוטומטית|נחת(?:י|ה)?\s+עכשיו|נחיתה עכשיו|חזור הביתה|חזרה הביתה/, kind: 'LANDING_COMMAND' },
  { re: /\bmode\s+(change|to)\b/i, kind: 'MODE_CHANGE' },
  { re: /שנה מצב טיסה|החלף מצב טיסה/, kind: 'MODE_CHANGE' },
  { re: /\b(ekf|nav(?:igation)?\s+source).{0,40}\b(switch|change|inject)\b/i, kind: 'NAV_SOURCE_SWITCH' },
  { re: /\b(switch|change|inject).{0,40}\b(ekf|nav(?:igation)?\s+source|optical\s+nav)\b/i, kind: 'NAV_SOURCE_SWITCH' },
  { re: /החלף מקור ניווט|הזרק(?:ת)? אופטי|מקור ניווט בבקר/, kind: 'NAV_SOURCE_SWITCH' },
  { re: /\b(deploy|rollback)\b/i, kind: 'DEPLOY' },
  { re: /\b(restart|reboot)\b.+\b(service|jetson|systemd)\b/i, kind: 'RESTART_SERVICE' },
  { re: /\b(shell|bash|powershell|cmd\.exe)\b/i, kind: 'SHELL' },
  { re: /\b(start\s+agent|run\s+cursor)\b/i, kind: 'CURSOR_AGENT_START' },
];

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
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

export function resolveAskFlightIntent(rawText) {
  const text = normalize(rawText);
  if (!text) return null;

  for (const p of BLOCKED_PATTERNS) {
    if (p.re.test(text)) {
      return {
        blocked: true,
        prohibited: true,
        prohibited_action: p.kind,
        blocked_kind: p.kind,
        intent: 'UNRESOLVED',
        confidence: 1,
        reason: `blocked early-flight action: ${p.kind}`,
        slots: {},
      };
    }
  }

  const parsed = parseAskParamProposal(text);
  if (parsed) {
    if (isAskBlockedParamKey(parsed.key)) {
      return {
        blocked: true,
        prohibited: true,
        prohibited_action: 'NAV_SOURCE_SWITCH',
        blocked_kind: 'NAV_SOURCE_SWITCH',
        intent: 'UNRESOLVED',
        confidence: 1,
        reason: `blocked param key: ${parsed.key}`,
        slots: { key: parsed.key, value: parsed.value },
      };
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
