/**
 * Local allowlist for spoken flight phrases.
 * One matcher for the voice-flight pipeline and the console (phrase field + Ask).
 * ARM / DISARM never send. ACRO is recognized and refused. LAND is not a phrase send.
 * Playback is not done here. The client speaks talkback.text.
 */

export const VOICE_SEND_MODES = new Set([
  'MANUAL', 'STABILIZE', 'FBWA', 'FBWB', 'CRUISE', 'AUTOTUNE', 'AUTO',
  'RTL', 'LOITER', 'CIRCLE', 'GUIDED', 'TAKEOFF',
  'QSTABILIZE', 'QHOVER', 'QLOITER', 'QRTL',
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
  autotune: 'AUTOTUNE',
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
  qstabilize: 'QSTABILIZE',
  qhover: 'QHOVER',
  qloiter: 'QLOITER',
  qrtl: 'QRTL',
  acro: 'ACRO',
  אקרו: 'ACRO',
  rtl: 'RTL',
  חזרה: 'RTL',
});

const BLOCKED_PATTERNS = [
  { re: /\bdisarm\b/i, kind: 'DISARM' },
  { re: /נטרול|לנטרל|נטרל(?:\s|$)/, kind: 'DISARM' },
  { re: /תכבה(?:י)? את המנועים|כבה מנועים/, kind: 'DISARM' },
  { re: /\b(turn|shut|kill|cut)\s+(the\s+)?motors?\s+off\b/i, kind: 'DISARM' },
  { re: /\bmotors?\s+off\b/i, kind: 'DISARM' },
  { re: /\b(please\s+)?arm(\s+the)?(\s+(aircraft|plane|vehicle|motors?))?\b/i, kind: 'ARM' },
  { re: /חימוש|לחמש|חמש(?:\s+את)?(?:\s+המטוס)?(?:\s|$)/, kind: 'ARM' },
  { re: /תחמש|תן(?:י)?(?: לי)? חימוש|תפעיל(?:י)?(?: לי)? את המנועים|הפעל מנועים|הפעילו מנוע|הפעל מנוע|תדליק(?:י)?(?: לי)? (?:את )?המנועים/, kind: 'ARM' },
  { re: /\b(turn|spin)\s+(the\s+)?motors?\s+on\b/i, kind: 'ARM' },
  { re: /\b(enable|start)\s+(the\s+)?motors?\b/i, kind: 'ARM' },
  { re: /\bmotors?\s+on\b/i, kind: 'ARM' },
];

const LATIN_MODE_RE = /\b(qstabilize|qhover|qloiter|qrtl|autotune|manual|stabilize|fbwa|fbwb|cruise|auto|loiter|circle|guided|takeoff|acro|rtl)\b/;

export function normalizeVoiceTranscript(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function modeFromTail(tail) {
  const token = String(tail || '').trim().toLowerCase();
  if (!token) return '';
  if (Object.prototype.hasOwnProperty.call(MODE_WORDS, token)) return MODE_WORDS[token];
  const first = token.split(' ')[0];
  if (Object.prototype.hasOwnProperty.call(MODE_WORDS, first)) return MODE_WORDS[first];
  return '';
}

function resultForMode(mode) {
  if (!mode) return null;
  if (mode === 'RTL') return { blocked: false, kind: 'RTL', mode: 'RTL', sendable: true };
  return {
    blocked: false,
    kind: 'MODE_CHANGE',
    mode,
    sendable: VOICE_SEND_MODES.has(mode),
  };
}

/**
 * @returns {{ blocked: boolean, kind: string, mode: string|null, sendable: boolean }|null}
 */
export function matchVoiceFlightPhrase(text) {
  const q = normalizeVoiceTranscript(text);
  if (!q) return null;
  for (const row of BLOCKED_PATTERNS) {
    if (row.re.test(q)) {
      return { blocked: true, kind: row.kind, mode: null, sendable: false };
    }
  }
  const led = q.match(/^(?:ת?עבורו?|עברו|לעבור)\s+למצב(?:\s+טיסה)?\s+(.+)$/);
  if (led) {
    const ledMode = resultForMode(modeFromTail(led[1]));
    if (ledMode) return ledMode;
  }
  const named = q.match(/^מצב(?:\s+טיסה)?\s+(.+)$/);
  if (named) {
    const namedMode = resultForMode(modeFromTail(named[1]));
    if (namedMode) return namedMode;
  }
  const english = q.match(/^(?:mode|switch to|go to|set mode)\s+(.+)$/);
  if (english) {
    const englishMode = resultForMode(modeFromTail(english[1]));
    if (englishMode) return englishMode;
  }
  if (/^(?:בבקשה\s+)?(?:תמריא|תמריאו|המריאו|המראה)$/.test(q) || /\btakeoff\b/.test(q)) {
    return resultForMode('TAKEOFF');
  }
  if (/(\brtl\b|חזרה הביתה|חזרו הביתה|חזור הביתה|תחזור הביתה|\breturn home\b|\bgo home\b|\bcome home\b)/.test(q)) {
    return resultForMode('RTL');
  }
  if (Object.prototype.hasOwnProperty.call(MODE_WORDS, q)) return resultForMode(MODE_WORDS[q]);
  const latin = q.match(LATIN_MODE_RE);
  if (latin) return resultForMode(MODE_WORDS[latin[1]] || '');
  return null;
}

if (typeof window !== 'undefined') {
  window.__vlcMatchVoiceFlightPhrase = matchVoiceFlightPhrase;
}
