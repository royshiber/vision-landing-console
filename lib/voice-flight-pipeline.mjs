/**
 * Hebrew transcript → Gemini (or mock) → existing Ask voice allowlist →
 * MAVLink only on a local simulator → Hebrew talk-back.
 * ARM / DISARM and anything outside LAND / RTL / MODE_CHANGE never send.
 * A real vehicle link never sends from this path.
 */

import { sanitizeLlmIntent, classifyAskIntentWithGemini } from './assist/ask-llm-intent.mjs';
import { isAskSessionFlightOpKind, ASK_BLOCKED_FLIGHT_KINDS } from './assist/ask-safety.mjs';
import { streamTts } from './flight-engineer.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const MODE_WORDS = Object.freeze({
  manual: 'MANUAL',
  ידני: 'MANUAL',
  stabilize: 'STABILIZE',
  fbwa: 'FBWA',
  fbwb: 'FBWB',
  cruise: 'CRUISE',
  auto: 'AUTO',
  loiter: 'LOITER',
  circle: 'CIRCLE',
  guided: 'GUIDED',
  takeoff: 'TAKEOFF',
  acro: 'ACRO',
  rtl: 'RTL',
});

export function normalizeVoiceTranscript(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Stand-in for Gemini when GEMINI_API_KEY is absent.
 * Returns the raw JSON shape the classifier prompt asks for.
 * sanitizeLlmIntent is still the allowlist gate.
 */
export function mockGeminiRawIntent(text) {
  const q = normalizeVoiceTranscript(text);
  if (!q) return { intent: 'UNRESOLVED', confidence: 0 };
  if (/(חמש|חימוש|\barm\b|הפעילו מנוע|הפעל מנוע)/.test(q)) {
    return { intent: 'BLOCKED', blocked_kind: 'ARM', confidence: 0.95 };
  }
  if (/(נטרל|נטרול|\bdisarm\b)/.test(q)) {
    return { intent: 'BLOCKED', blocked_kind: 'DISARM', confidence: 0.95 };
  }
  if (/(נחית|נחת|\bland\b)/.test(q)) {
    return { intent: 'FLIGHT_OP', kind: 'LAND', confidence: 0.9 };
  }
  if (/(\brtl\b|חזרה הביתה|חזרו הביתה|חזור הביתה)/.test(q)) {
    return { intent: 'FLIGHT_OP', kind: 'RTL', confidence: 0.9 };
  }
  const modeHit = q.match(/\b(manual|stabilize|fbwa|fbwb|cruise|auto|loiter|circle|guided|takeoff|acro|rtl)\b|ידני/);
  if (modeHit) {
    const token = modeHit[1] || 'ידני';
    const mode = MODE_WORDS[token] || null;
    if (mode === 'RTL') return { intent: 'FLIGHT_OP', kind: 'RTL', confidence: 0.9 };
    if (mode) return { intent: 'FLIGHT_OP', kind: 'MODE_CHANGE', mode, confidence: 0.9 };
  }
  return { intent: 'UNRESOLVED', confidence: 0.2 };
}

export async function resolveVoiceFlightIntent(text, { classify } = {}) {
  if (typeof classify === 'function') {
    const raw = await classify(text);
    const intent = raw?.resolver === 'llm' || raw?.slots ? (sanitizeLlmIntent(raw) || raw) : sanitizeLlmIntent(raw);
    return { intent: intent || null, resolver: 'inject' };
  }
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (key) {
    const llm = await classifyAskIntentWithGemini(text);
    return { intent: llm || null, resolver: 'gemini' };
  }
  return { intent: sanitizeLlmIntent(mockGeminiRawIntent(text)), resolver: 'mock-gemini' };
}

/** Send only when the live link is a detected simulator on loopback TCP or a local pty. */
export function voiceFlightLinkAllowsSend(mavConn) {
  if (!mavConn || mavConn.connected !== true) return false;
  const detected = typeof mavConn.simulatorDetection === 'function'
    ? mavConn.simulatorDetection()
    : null;
  const simulator = detected?.simulator === true || mavConn.simulator === true;
  if (!simulator) return false;
  const type = String(mavConn.type || '').toLowerCase();
  if (type === 'tcp') {
    return LOOPBACK.has(String(mavConn.host || '').trim().toLowerCase());
  }
  if (type === 'serial' || type === 'telemetry') {
    const port = String(mavConn.serialPort || '');
    return port.includes('/dev/pts/') || port.includes('sitl-pty');
  }
  return false;
}

export function voiceFlightTalkback({ decision, kind, mode }) {
  const k = String(kind || '').toUpperCase();
  if (decision === 'sent') {
    if (k === 'RTL') return 'אושר. מצב RTL נשלח לסימולטור.';
    if (k === 'LAND') return 'אושר. פקודת הנחיתה נשלחה לסימולטור.';
    if (k === 'MODE_CHANGE' && mode) return `אושר. מצב ${mode} נשלח לסימולטור.`;
    return 'אושר. הפקודה נשלחה לסימולטור.';
  }
  if (decision === 'blocked') return 'נדחה. חימוש ונטרול חסומים. לא נשלח דבר.';
  if (decision === 'not_allowlisted') return 'נדחה. הפקודה אינה ברשימה המותרת. לא נשלח דבר.';
  if (decision === 'no_go') return 'נדחה. שיחת הקול סגורה. לא נשלח דבר.';
  if (decision === 'not_simulator') return 'נדחה. הקישור אינו סימולטור מקומי. לא נשלח דבר.';
  return 'נדחה. לא נשלח דבר.';
}

export async function speakVoiceFlightTalkback(text, speak) {
  if (typeof speak === 'function') return speak(text);
  const key = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return { provider: 'mock', spoken: false, text };
  try {
    const stream = await streamTts(text, 'he');
    if (!stream) return { provider: 'elevenlabs', spoken: false, text };
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk?.length || 0;
    return { provider: 'elevenlabs', spoken: bytes > 0, text };
  } catch {
    return { provider: 'elevenlabs', spoken: false, text };
  }
}

function flightKind(intent) {
  return String(intent?.slots?.kind || intent?.kind || intent?.blocked_kind || '').toUpperCase();
}

/**
 * @param {{ text: string, goActive?: boolean, mavConn?: object|null, applyFlightOp?: Function, classify?: Function, speak?: Function }} args
 */
export async function runVoiceFlightTranscript({
  text,
  goActive = false,
  mavConn = null,
  applyFlightOp = null,
  classify,
  speak,
} = {}) {
  const transcript = String(text || '').trim();
  const { intent, resolver } = await resolveVoiceFlightIntent(transcript, { classify });
  const kind = flightKind(intent);
  const mode = intent?.slots?.mode || intent?.mode || null;
  const blockedKind = String(intent?.blocked_kind || intent?.prohibited_action || '').toUpperCase();
  const blocked = intent?.blocked === true
    || intent?.prohibited === true
    || ASK_BLOCKED_FLIGHT_KINDS.includes(kind)
    || ASK_BLOCKED_FLIGHT_KINDS.includes(blockedKind);
  const allowlisted = intent?.intent === 'FLIGHT_OP' && isAskSessionFlightOpKind(kind) && !blocked;

  let decision = 'not_allowlisted';
  let applied = null;
  if (!transcript) decision = 'not_allowlisted';
  else if (blocked || kind === 'ARM' || kind === 'DISARM') decision = 'blocked';
  else if (!allowlisted) decision = 'not_allowlisted';
  else if (goActive !== true) decision = 'no_go';
  else if (!voiceFlightLinkAllowsSend(mavConn)) decision = 'not_simulator';
  else if (typeof applyFlightOp === 'function') {
    applied = await applyFlightOp({ kind, mode, reason: transcript.slice(0, 200) });
    if (applied?.blocked === true || applied?.sent !== true) decision = applied?.blocked ? 'blocked' : 'refused';
    else decision = 'sent';
  } else {
    decision = 'refused';
  }

  const talkText = voiceFlightTalkback({ decision, kind, mode });
  const talkback = await speakVoiceFlightTalkback(talkText, speak);
  const flightMode = Number.isFinite(mavConn?.lastCustomMode) ? mavConn.lastCustomMode : null;
  return {
    ok: decision === 'sent' || decision === 'blocked' || decision === 'not_allowlisted' || decision === 'no_go' || decision === 'not_simulator' || decision === 'refused',
    sent: decision === 'sent',
    blocked: decision === 'blocked',
    decision,
    kind: kind || blockedKind || null,
    mode: mode || null,
    customMode: applied?.customMode ?? null,
    flightMode,
    simulator: voiceFlightLinkAllowsSend(mavConn),
    resolver,
    note: applied?.note || null,
    talkback: {
      provider: talkback?.provider || 'mock',
      spoken: talkback?.spoken === true,
      text: talkback?.text || talkText,
    },
  };
}
