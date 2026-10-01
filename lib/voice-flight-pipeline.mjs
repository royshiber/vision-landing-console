/**
 * Hebrew transcript → local allowlist (Gemini only if that misses) →
 * MAVLink only on a local simulator → Hebrew talk-back text.
 * The client speaks talkback.text. This path does not play audio.
 * ARM / DISARM and anything outside LAND / RTL / MODE_CHANGE never send.
 * A real vehicle link never sends from this path.
 */

import { sanitizeLlmIntent, classifyAskIntentWithGemini } from './assist/ask-llm-intent.mjs';
import { isAskSessionFlightOpKind, ASK_BLOCKED_FLIGHT_KINDS } from './assist/ask-safety.mjs';
import {
  matchVoiceFlightPhrase,
  normalizeVoiceTranscript,
  VOICE_SEND_MODES,
} from '../public/modules/voice-flight-phrases.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** Modes the dock and the flight voice box may send. ACRO stays off this list. */
export { VOICE_SEND_MODES, normalizeVoiceTranscript, matchVoiceFlightPhrase };

/**
 * Stand-in for Gemini when GEMINI_API_KEY is absent.
 * Returns the raw JSON shape the classifier prompt asks for.
 * sanitizeLlmIntent is still the allowlist gate.
 */
function intentFromMatch(matched) {
  if (!matched) return null;
  if (matched.blocked) {
    return { intent: 'BLOCKED', blocked_kind: matched.kind, confidence: 0.95 };
  }
  if (matched.kind === 'RTL') return { intent: 'FLIGHT_OP', kind: 'RTL', confidence: 0.9 };
  if (matched.kind === 'MODE_CHANGE' && matched.mode) {
    return { intent: 'FLIGHT_OP', kind: 'MODE_CHANGE', mode: matched.mode, confidence: 0.9 };
  }
  return null;
}

export function mockGeminiRawIntent(text) {
  const q = normalizeVoiceTranscript(text);
  if (!q) return { intent: 'UNRESOLVED', confidence: 0 };
  const matched = intentFromMatch(matchVoiceFlightPhrase(text));
  if (matched) return matched;
  if (/(נחית|נחת|\bland\b)/.test(q) && !/ביטחון נחיתה|landing confidence/i.test(q)) {
    return { intent: 'FLIGHT_OP', kind: 'LAND', confidence: 0.9 };
  }
  return { intent: 'UNRESOLVED', confidence: 0.2 };
}

function intentForRequestedMode(mode) {
  const name = String(mode || '').trim().toUpperCase();
  if (!name) return null;
  if (name === 'ARM' || name === 'DISARM') {
    return sanitizeLlmIntent({ intent: 'BLOCKED', blocked_kind: name, confidence: 1 });
  }
  if (name === 'RTL') return sanitizeLlmIntent({ intent: 'FLIGHT_OP', kind: 'RTL', confidence: 1 });
  if (VOICE_SEND_MODES.has(name)) {
    return sanitizeLlmIntent({ intent: 'FLIGHT_OP', kind: 'MODE_CHANGE', mode: name, confidence: 1 });
  }
  return null;
}

export async function resolveVoiceFlightIntent(text, { classify } = {}) {
  if (typeof classify === 'function') {
    const raw = await classify(text);
    const intent = raw?.resolver === 'llm' || raw?.slots ? (sanitizeLlmIntent(raw) || raw) : sanitizeLlmIntent(raw);
    return { intent: intent || null, resolver: 'inject' };
  }
  const raw = mockGeminiRawIntent(text);
  const recognized = raw?.intent === 'FLIGHT_OP' || raw?.intent === 'BLOCKED';
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (recognized || !key) {
    return { intent: sanitizeLlmIntent(raw), resolver: 'mock-gemini' };
  }
  const llm = await classifyAskIntentWithGemini(text);
  return { intent: llm || null, resolver: 'gemini' };
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

export function voiceFlightTalkback({ decision, kind, mode, note }) {
  const k = String(kind || '').toUpperCase();
  if (decision === 'sent') {
    if (k === 'RTL') return 'אושר. מצב RTL נשלח לסימולטור.';
    if (k === 'LAND') return 'אושר. פקודת הנחיתה נשלחה לסימולטור.';
    if (k === 'MODE_CHANGE' && mode) return `אושר. מצב ${mode} נשלח לסימולטור.`;
    return 'אושר. הפקודה נשלחה לסימולטור.';
  }
  if (decision === 'blocked') return 'נדחה. חימוש ונטרול חסומים. לא נשלח דבר.';
  if (decision === 'not_allowlisted' && mode) return 'המצב הזה אינו ברשימה. לא נשלח דבר.';
  if (decision === 'not_allowlisted') return 'נדחה. הפקודה אינה ברשימה המותרת. לא נשלח דבר.';
  if (decision === 'no_go') return 'נדחה. שיחת הקול סגורה. לא נשלח דבר.';
  if (decision === 'not_simulator') return 'נדחה. הקישור אינו סימולטור מקומי. לא נשלח דבר.';
  const refused = String(note || '').trim();
  if (refused) return refused;
  return 'הבקר סירב. לא נשלח דבר.';
}

/**
 * The HTTP client speaks talkback.text through __vlcSpeakAnswer.
 * spoken stays false: this function does not play audio and does not call ElevenLabs.
 * An injected speak() is for tests only. The voice-flight route does not pass one.
 */
export async function speakVoiceFlightTalkback(text, speak) {
  if (typeof speak === 'function') return speak(text);
  return { provider: 'client', spoken: false, text };
}

function flightKind(intent) {
  return String(intent?.slots?.kind || intent?.kind || intent?.blocked_kind || '').toUpperCase();
}

/**
 * operatorConfirmed is the flight-dock button after its own confirm.
 * It does not open a voice session and does not skip the allowlist.
 * requestedMode is the dock menu. It does not go through phrase parsing.
 * @param {{ text: string, requestedMode?: string, goActive?: boolean, operatorConfirmed?: boolean, mavConn?: object|null, applyFlightOp?: Function, classify?: Function, speak?: Function }} args
 */
export async function runVoiceFlightTranscript({
  text,
  requestedMode = '',
  goActive = false,
  operatorConfirmed = false,
  mavConn = null,
  applyFlightOp = null,
  classify,
  speak,
} = {}) {
  const transcript = String(text || '').trim();
  const forced = String(requestedMode || '').trim().toUpperCase();
  let intent;
  let resolver;
  if (forced) {
    intent = intentForRequestedMode(forced);
    resolver = 'mode';
  } else {
    ({ intent, resolver } = await resolveVoiceFlightIntent(transcript, { classify }));
  }
  const kind = flightKind(intent);
  const mode = forced || intent?.slots?.mode || intent?.mode || null;
  const blockedKind = String(intent?.blocked_kind || intent?.prohibited_action || '').toUpperCase();
  const blocked = intent?.blocked === true
    || intent?.prohibited === true
    || ASK_BLOCKED_FLIGHT_KINDS.includes(kind)
    || ASK_BLOCKED_FLIGHT_KINDS.includes(blockedKind);
  const modeName = String(mode || '').toUpperCase();
  const modeSendable = kind !== 'MODE_CHANGE' || VOICE_SEND_MODES.has(modeName);
  const allowlisted = intent?.intent === 'FLIGHT_OP' && isAskSessionFlightOpKind(kind) && !blocked && modeSendable;

  let decision = 'not_allowlisted';
  let applied = null;
  if (!transcript && !forced) decision = 'not_allowlisted';
  else if (blocked || kind === 'ARM' || kind === 'DISARM') decision = 'blocked';
  else if (!allowlisted) decision = 'not_allowlisted';
  else if (goActive !== true && operatorConfirmed !== true) decision = 'no_go';
  else if (!voiceFlightLinkAllowsSend(mavConn)) decision = 'not_simulator';
  else if (typeof applyFlightOp === 'function') {
    applied = await applyFlightOp({ kind, mode: modeName || mode, reason: (transcript || modeName).slice(0, 200) });
    if (applied?.blocked === true || applied?.sent !== true) decision = applied?.blocked ? 'blocked' : 'refused';
    else decision = 'sent';
  } else {
    decision = 'refused';
  }

  const talkText = voiceFlightTalkback({
    decision,
    kind,
    mode,
    note: String(applied?.note || '').trim(),
  });
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
