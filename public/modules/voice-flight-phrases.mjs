/**
 * Anchored allowlist for spoken flight phrases.
 * A mode is sent only when the phrase is that command, plus a polite word or "עכשיו".
 * Negation wins. A mode word inside an unrelated sentence is not a command.
 * A question about the current mode is a readback, never a send.
 * Status such as "לא יציב" is not a command. Ask answers it.
 * ARM / DISARM never send. ACRO is recognized and refused.
 * AUTOTUNE and the Q modes are not spoken commands.
 * Playback is not done here. The client speaks talkback.text.
 */

export const VOICE_SEND_MODES = new Set([
  'MANUAL', 'STABILIZE', 'FBWA', 'FBWB', 'CRUISE', 'AUTO',
  'RTL', 'LOITER', 'CIRCLE', 'GUIDED', 'TAKEOFF',
]);

const MODE_WORDS = Object.freeze({
  manual: 'MANUAL',
  ידני: 'MANUAL',
  stabilize: 'STABILIZE',
  יציב: 'STABILIZE',
  יציבה: 'STABILIZE',
  fbwa: 'FBWA',
  fbwb: 'FBWB',
  cruise: 'CRUISE',
  שיוט: 'CRUISE',
  auto: 'AUTO',
  אוטו: 'AUTO',
  אוטומטי: 'AUTO',
  loiter: 'LOITER',
  circle: 'CIRCLE',
  מעגל: 'CIRCLE',
  guided: 'GUIDED',
  מונחה: 'GUIDED',
  takeoff: 'TAKEOFF',
  המראה: 'TAKEOFF',
  תמריא: 'TAKEOFF',
  תמריאו: 'TAKEOFF',
  המריאו: 'TAKEOFF',
  acro: 'ACRO',
  אקרו: 'ACRO',
  autotune: 'AUTOTUNE',
  qstabilize: 'QSTABILIZE',
  qhover: 'QHOVER',
  qloiter: 'QLOITER',
  qrtl: 'QRTL',
  rtl: 'RTL',
  חזרה: 'RTL',
});

const EXACT_RTL = new Set([
  'rtl',
  'חזרה',
  'חזרה הביתה',
  'חזרו הביתה',
  'חזור הביתה',
  'תחזור הביתה',
  'return home',
  'go home',
  'come home',
]);

const EXACT_TAKEOFF = new Set(['תמריא', 'תמריאו', 'המריאו', 'המראה', 'takeoff']);

const EXACT_ARM = new Set([
  'חמש',
  'חמש את המטוס',
  'חימוש',
  'לחמש',
  'תחמש',
  'arm',
  'please arm',
  'arm the aircraft',
  'arm the plane',
]);

const EXACT_DISARM = new Set([
  'נטרול',
  'נטרל',
  'לנטרל',
  'disarm',
  'please disarm',
]);

const HEBREW_TOKENS = [
  'ידני', 'יציב', 'יציבה', 'שיוט', 'אוטומטי', 'אוטו', 'מעגל', 'מונחה',
  'המראה', 'תמריא', 'תמריאו', 'המריאו', 'חזרה', 'חמש', 'חימוש', 'נטרול', 'נטרל', 'אקרו',
];

/** Words a pilot says for the spoken modes. */
const PILOT_MODE_WORD = Object.freeze({
  MANUAL: 'ידני',
  STABILIZE: 'יציב',
  FBWA: 'FBWA',
  FBWB: 'FBWB',
  CRUISE: 'שיוט',
  AUTO: 'אוטו',
  RTL: 'חזרה',
  LOITER: 'לויטר',
  CIRCLE: 'מעגל',
  GUIDED: 'מונחה',
  TAKEOFF: 'המראה',
});

export function pilotModeWord(mode) {
  return PILOT_MODE_WORD[String(mode || '').trim().toUpperCase()] || '';
}

export function normalizeVoiceTranscript(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLetter(ch) {
  return Boolean(ch) && /\p{L}/u.test(ch);
}

function hasToken(text, token, allowPrefix = false) {
  const t = String(text || '');
  const tok = String(token || '');
  if (!tok) return false;
  let from = 0;
  while (from <= t.length - tok.length) {
    const idx = t.indexOf(tok, from);
    if (idx < 0) return false;
    const prev = idx > 0 ? t.charAt(idx - 1) : '';
    const before = idx === 0 || !isLetter(prev);
    const clitic = allowPrefix
      && idx > 0
      && /[בלמהושכ]/.test(prev)
      && (idx === 1 || !isLetter(t.charAt(idx - 2)));
    const after = idx + tok.length >= t.length || !isLetter(t.charAt(idx + tok.length));
    if ((before || clitic) && after) return true;
    from = idx + 1;
  }
  return false;
}

function mentionsFlight(q) {
  if (/(חזרה הביתה|חזרו הביתה|חזור הביתה|תחזור הביתה)/.test(q)) return true;
  if (/\b(manual|stabilize|fbwa|fbwb|cruise|autotune|qstabilize|qhover|qloiter|qrtl|auto|loiter|circle|guided|takeoff|acro|rtl|arm|disarm)\b/.test(q)) {
    return true;
  }
  return HEBREW_TOKENS.some((word) => hasToken(q, word, true));
}

function modeFromTail(tail) {
  const token = String(tail || '').trim().toLowerCase();
  if (!token) return '';
  if (Object.prototype.hasOwnProperty.call(MODE_WORDS, token)) return MODE_WORDS[token];
  return '';
}

function resultForMode(mode) {
  if (!mode) return null;
  if (mode === 'RTL') {
    return {
      blocked: false, negated: false, flightShaped: true, question: false, passToAsk: false,
      kind: 'RTL', mode: 'RTL', sendable: true,
    };
  }
  return {
    blocked: false,
    negated: false,
    flightShaped: true,
    question: false,
    passToAsk: false,
    kind: 'MODE_CHANGE',
    mode,
    sendable: VOICE_SEND_MODES.has(mode),
  };
}

function blocked(kind) {
  return {
    blocked: true, negated: false, flightShaped: true, question: false, passToAsk: false,
    kind, mode: null, sendable: false,
  };
}

function negated() {
  return {
    blocked: false, negated: true, flightShaped: true, question: false, passToAsk: false,
    kind: null, mode: null, sendable: false,
  };
}

function shapedOnly() {
  return {
    blocked: false, negated: false, flightShaped: true, question: false, passToAsk: false,
    kind: null, mode: null, sendable: false,
  };
}

function modeQuestion() {
  return {
    blocked: false, negated: false, flightShaped: false, question: true, readback: 'mode', passToAsk: false,
    kind: null, mode: null, sendable: false,
  };
}

function positiveCommand(q) {
  if (EXACT_ARM.has(q)) return blocked('ARM');
  if (EXACT_DISARM.has(q)) return blocked('DISARM');
  if (EXACT_TAKEOFF.has(q)) return resultForMode('TAKEOFF');
  if (EXACT_RTL.has(q)) return resultForMode('RTL');
  const led = q.match(/^(?:תעבור|עבורו?|עברו|לעבור)\s+למצב(?:\s+טיסה)?\s+(.+)$/);
  if (led) return resultForMode(modeFromTail(led[1]));
  const named = q.match(/^מצב(?:\s+טיסה)?\s+(.+)$/);
  if (named) return resultForMode(modeFromTail(named[1]));
  const english = q.match(/^(?:mode|switch to|go to|set mode)\s+(.+)$/);
  if (english) return resultForMode(modeFromTail(english[1]));
  if (Object.prototype.hasOwnProperty.call(MODE_WORDS, q)) return resultForMode(MODE_WORDS[q]);
  return null;
}

function peelFillers(q) {
  let s = String(q || '').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = s
      .replace(/^(?:בבקשה|נא|please|kindly)\s+/, '')
      .replace(/\s+(?:עכשיו|now|בבקשה|please|נא)$/, '')
      .trim();
    if (!next || next === s) break;
    s = next;
  }
  return s;
}

function isModeQuestion(q) {
  if (/^(?:באיזה מצב|איזה מצב|מה המצב|מה מצב)(?:\s|$)/.test(q)) return true;
  if (/^האם(?:\s|$)/.test(q) && mentionsMode(q)) return true;
  if (/\b(?:are we in|what(?:'s| is) (?:the |our )?(?:flight )?mode|which mode|current mode)\b/.test(q)) return true;
  if (/[?？]$/.test(q) && mentionsMode(q)) return true;
  return false;
}

function isStatusAside(q) {
  return /^לא\s+(?:יציב|יציבה|ידני|ידנית)$/.test(q);
}

function mentionsMode(q) {
  if (/\b(manual|stabilize|fbwa|fbwb|cruise|autotune|qstabilize|qhover|qloiter|qrtl|auto|loiter|circle|guided|takeoff|acro|rtl)\b/.test(q)) {
    return true;
  }
  return ['ידני', 'יציב', 'יציבה', 'שיוט', 'אוטומטי', 'אוטו', 'מעגל', 'מונחה', 'המראה', 'תמריא', 'תמריאו', 'המריאו', 'חזרה', 'אקרו']
    .some((word) => hasToken(q, word, true));
}

function stripNegation(q) {
  const patterns = [
    /^אל\s+/,
    /^לא\s+ל/,
    /^(?:please\s+)?(?:do not|don't|dont|never)\s+/,
    /^not\s+/,
  ];
  for (const re of patterns) {
    if (!re.test(q)) continue;
    const rest = q.replace(re, '').trim();
    if (rest && rest !== q) return rest;
  }
  return '';
}

/**
 * @returns {{ blocked: boolean, negated: boolean, flightShaped: boolean, question?: boolean, passToAsk?: boolean, readback?: string, kind: string|null, mode: string|null, sendable: boolean }|null}
 * null means the sentence is not a flight phrase. Ask may handle it as a normal question.
 * passToAsk is status, not a command. Ask answers it. A question is a mode readback.
 */
export function matchVoiceFlightPhrase(text) {
  const q = normalizeVoiceTranscript(text);
  if (!q) return null;
  if (isModeQuestion(q)) return modeQuestion();
  if (isStatusAside(q)) {
    return {
      blocked: false, negated: false, flightShaped: false, question: false, passToAsk: true,
      kind: null, mode: null, sendable: false,
    };
  }
  const peeled = peelFillers(q);
  const withoutNegation = stripNegation(peeled);
  if (withoutNegation && positiveCommand(withoutNegation)) return negated();
  const command = positiveCommand(peeled);
  if (command) return command;
  if (mentionsFlight(q)) return shapedOnly();
  return null;
}

if (typeof window !== 'undefined') {
  window.__vlcMatchVoiceFlightPhrase = matchVoiceFlightPhrase;
  window.__vlcPilotModeWord = pilotModeWord;
}
