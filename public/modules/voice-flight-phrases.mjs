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

function modeQuestion(askedMode) {
  return {
    blocked: false, negated: false, flightShaped: false, question: true, readback: 'mode', passToAsk: false,
    askedMode: askedMode || null,
    kind: null, mode: null, sendable: false,
  };
}

function passToAsk() {
  return {
    blocked: false, negated: false, flightShaped: false, question: false, passToAsk: true,
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

function spokenModeName(token) {
  const key = String(token || '').trim().toLowerCase();
  if (key === 'ידנית') return 'MANUAL';
  const mode = MODE_WORDS[key];
  if (mode && VOICE_SEND_MODES.has(mode)) return mode;
  return '';
}

function spokenModeInText(q) {
  const keys = Object.keys(MODE_WORDS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (!VOICE_SEND_MODES.has(MODE_WORDS[key])) continue;
    if (hasToken(q, key, true)) return MODE_WORDS[key];
  }
  if (hasToken(q, 'ידנית', true)) return 'MANUAL';
  return '';
}

/** Status questions about the cameras. Not a flight phrase and not a workspace question. */
export function isSpokenCameraStatusQuestion(text) {
  const q = normalizeVoiceTranscript(text).replace(/[?؟]+$/g, '').trim();
  if (!q) return false;
  if (/מה אני רואה|מה (?:ה)?מצלמות רואות|מה רואות המצלמות|מה עם המצלמות/.test(q)) return false;
  if (/האם יש וידאו|זרם הווידאו|\bstreaming\b/.test(q)) return true;
  if (/מצב (?:ה)?מצלמ/.test(q)) return true;
  if (/מה קורה עם (?:ה)?מצלמ/.test(q)) return true;
  if (/(?:האם )?(?:ה)?מצלמ\S* משדר/.test(q)) return true;
  return false;
}

function bareFlightModeQuestion(q) {
  const bare = String(q || '').replace(/[?？]+$/, '').trim();
  if (/^(?:באיזה מצב|איזה מצב)(?:\s+אנחנו|\s+עכשיו)?$/.test(bare)) return true;
  if (/^מה המצב(?:\s+עכשיו|\s+הטיסה|\s+של הטיסה|\s+שלנו)?$/.test(bare)) return true;
  if (/^מה מצב(?:\s+הטיסה)?$/.test(bare)) return true;
  return false;
}

function isModeQuestion(q) {
  if (bareFlightModeQuestion(q)) return true;
  if (/^האם(?:\s|$)/.test(q) && spokenModeInText(q)) return true;
  if (/\bare we in\b/.test(q) && spokenModeInText(q)) return true;
  if (/\b(?:what(?:'s| is) (?:the |our )?(?:flight )?mode|which mode|current mode)\b/.test(q)) return true;
  return false;
}

function isSpokenModeNegation(q) {
  const rest = q.replace(/^(?:לא|not|don't|dont|do not|never)\s+/, '').trim();
  if (!rest || rest === q || /\s/.test(rest)) return false;
  return Boolean(spokenModeName(rest));
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
  if (isModeQuestion(q)) {
    const asked = bareFlightModeQuestion(q) ? '' : spokenModeInText(q);
    return modeQuestion(asked);
  }
  if (isSpokenModeNegation(q)) return passToAsk();
  const peeled = peelFillers(q);
  const withoutNegation = stripNegation(peeled);
  if (withoutNegation && positiveCommand(withoutNegation)) return negated();
  const command = positiveCommand(peeled);
  if (command) return command;
  if (mentionsFlight(q)) return shapedOnly();
  return null;
}

function hasVisionClause(q) {
  if (/(?:שחררו|שחרר|שחררי|בטלו|בטל|בטלי)\s+(?:את\s+)?(?:ה)?נעילה/.test(q)) return true;
  if (/(?:תעברו|עברו|עבורו)\s+ל(?:אובייקט|עצם)\s+הבא/.test(q)) return true;
  if (/(?:לאובייקט|לעצם|האובייקט|העצם)\s+הבא/.test(q) || /\bnext object\b/.test(q)) return true;
  if (/כמה\s+(?:אנשים|אדם|מכוניות|רכבים|מכונית|רכב|כלבים|כלב|משאיות|משאית|אוטובוסים|אוטובוס)/.test(q)) return true;
  if (/מעקב|עקבו|תעקבו|לעקוב|תעקוב/.test(q)) return true;
  if (/מה אתה מזהה|מה אתם מזהים|מה את מזהה/.test(q)) return true;
  if (/\block\b/.test(q) || /נעל את|נעל על/.test(q)) return true;
  if (/(?:^|\s)(?:תנעל|תנעלו|נעלו|לנעול|נעל)(?:\s|$)/.test(q)) return true;
  return /נעילה/.test(q);
}

/** A vision clause plus a flight clause. The server keeps the safe part and refuses the flight part. */
export function isVisionFlightCompound(text) {
  const q = normalizeVoiceTranscript(text);
  if (!q || !hasVisionClause(q)) return false;
  const flight = matchVoiceFlightPhrase(q);
  if (!flight || flight.sendable || flight.blocked || flight.negated || flight.question || flight.passToAsk) return false;
  return flight.flightShaped === true;
}

if (typeof window !== 'undefined') {
  window.__vlcMatchVoiceFlightPhrase = matchVoiceFlightPhrase;
  window.__vlcPilotModeWord = pilotModeWord;
  window.__vlcCameraStatusQuestion = isSpokenCameraStatusQuestion;
  window.__vlcVisionFlightCompound = isVisionFlightCompound;
}
