import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.mjs';
import { resolveGeminiModelName } from './gemini-model.mjs';
import { listParamCenterSmartSearchKeys } from './param-schema.mjs';

/** Why: browsers/OSes insert invisible chars; what: stable matching for Hebrew smart search. */
function normalizeSearchQuery(q) {
  return String(q || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .normalize('NFC')
    .trim();
}

/** Sofit → medial so "נחיתה↔נחיתה" and typos on finals align with needles. */
function hebrewCollapseSofiot(s) {
  return String(s || '')
    .replace(/ך/g, 'כ')
    .replace(/ם/g, 'מ')
    .replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ')
    .replace(/ץ/g, 'צ');
}

function normalizeFuzzyForm(s) {
  return hebrewCollapseSofiot(normalizeSearchQuery(s));
}

/** Max edits allowed by length — tuned to feel closer to web Gemini typo tolerance. */
function editAllowanceForLength(len) {
  if (len <= 2) return len === 2 ? 1 : 0;
  if (len <= 5) return 2;
  if (len <= 10) return 3;
  return Math.min(5, Math.floor(len * 0.34));
}

const FUZZY_MAX_STRLEN = 52;
function clipForEdit(s) {
  if (s.length <= FUZZY_MAX_STRLEN) return s;
  return s.slice(0, FUZZY_MAX_STRLEN);
}

/** UTF-16 code units; good enough for Hebrew + ASCII param search. */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  /** @type {number[]} */
  let prev = new Array(n + 1);
  /** @type {number[]} */
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n];
}

/** OSA distance: adjacent transposition counts as one (common mobile typos). */
function optimalStringAlignmentDistance(a0, b0) {
  const a = clipForEdit(a0);
  const b = clipForEdit(b0);
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) d[i][0] = i;
  for (let j = 0; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (
        i > 1
        && j > 1
        && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
        && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
    }
  }
  return d[m][n];
}

function editDistBest(a, b) {
  return Math.min(levenshtein(a, b), optimalStringAlignmentDistance(a, b));
}

/**
 * Whether two tokens are the same up to several typos (Hebrew + ASCII), Gemini-like.
 * @param {string} a
 * @param {string} b
 */
export function stringsTypoClose(a0, b0) {
  const a = normalizeFuzzyForm(a0);
  const b = normalizeFuzzyForm(b0);
  if (!a || !b) return a === b;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 4 && l.includes(s)) return true;
  const L = Math.max(a.length, b.length);
  const dist = editDistBest(a, b);
  const allow = editAllowanceForLength(L);
  if (dist <= allow) return true;
  return L >= 6 && dist / L <= 0.33;
}

function tokenizeQueryChunks(q) {
  const norm = normalizeFuzzyForm(q);
  const parts = norm.split(/[\s\u200f\u200e,.;:!?\-_/]+/).filter(Boolean);
  return [...new Set([norm, ...parts])];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Typo-tolerant match: substring for Hebrew; ASCII uses word-boundary for short needles.
 * @param {string} needle
 * @param {string} chunk
 * @param {number} maxDist
 */
function needleMatchesChunk(needle, chunk, rowMaxDist) {
  if (!needle || !chunk) return false;
  const ascii = /^[a-z0-9._-]+$/i.test(needle);
  if (ascii) {
    const n = needle.toLowerCase();
    const c = chunk.toLowerCase();
    if (c === n) return true;
    try {
      if (new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(chunk)) return true;
    } catch {
      /* ignore */
    }
    if (n.length >= 6 && c.includes(n)) return true;
    const allow = Math.max(rowMaxDist ?? 1, editAllowanceForLength(Math.max(n.length, c.length)));
    const dist = editDistBest(n, c);
    if (dist <= allow) return true;
    const L = Math.max(n.length, c.length);
    return L >= 6 && dist / L <= 0.34;
  }
  return stringsTypoClose(needle, chunk);
}

/**
 * Curated needles → param keys; Levenshtein / substring per word (handles spelling mistakes).
 * @type {{ keys: string[], needles: string[], maxDist?: number }[]}
 */
const APPROX_SYNONYMS = [
  {
    keys: ['companion_sr_bucket'],
    needles: ['קצב', 'קצבים', 'כצב', 'תדירות', 'תדר', 'הזרמה', 'rate', 'rates', 'stream', 'streaming', 'telemetry'],
    maxDist: 2,
  },
  {
    keys: ['companion_serial_port'],
    needles: ['סריאל', 'סיריאל', 'פורט', 'חיבור', 'serial', 'baud', 'באוד', 'מודם', 'usb'],
    maxDist: 2,
  },
  {
    keys: ['LAND_SPEED', 'LAND_SPEED_HIGH'],
    needles: ['נחיתה', 'מהירות', 'שקיעה', 'sink', 'landing', 'speed'],
    maxDist: 2,
  },
  {
    keys: ['PLND_ENABLED', 'PLND_TYPE', 'PLND_XY_DIST_MAX'],
    needles: ['פריסיזן', 'פרסיזן', 'מדוייקת', 'מדויקת', 'ראייה', 'vision', 'precision', 'plnd'],
    maxDist: 2,
  },
  {
    keys: ['LOG_BITMASK', 'LOG_DISARMED', 'LOG_REPLAY'],
    needles: ['לוג', 'רישום', 'הקלטה', 'log', 'logging', 'blackbox'],
    maxDist: 2,
  },
  {
    keys: ['EK3_ENABLE', 'AHRS_EKF_TYPE', 'EK3_GPS_TYPE', 'EK3_ALT_SOURCE'],
    needles: ['ekf', 'אייקייאף', 'מסנן', 'קלמן', 'gps', 'ג׳י פי אס', 'גי פי אס', 'altitude', 'גובה'],
    maxDist: 2,
  },
];

/**
 * @param {string} q
 * @param {Set<string>} whitelist
 * @returns {string[]}
 */
export function resolveParamSmartSearchApprox(q, whitelist) {
  const norm = normalizeSearchQuery(q);
  if (!norm) return [];
  const parts = norm.split(/[\s\u200f\u200e,.;:!?\-_/]+/).filter(Boolean);
  const chunks = [...new Set([norm, ...parts])];
  const out = [];
  for (const row of getApproxAndLabelRows()) {
    const md = row.maxDist ?? 2;
    for (const needle of row.needles) {
      for (const chunk of chunks) {
        if (needle.length <= 2) {
          if (chunk.toLowerCase() === needle.toLowerCase()) {
            row.keys.forEach((k) => {
              if (whitelist.has(k)) out.push(k);
            });
          }
          continue;
        }
        if (!needleMatchesChunk(needle, chunk, md)) continue;
        row.keys.forEach((k) => {
          if (whitelist.has(k)) out.push(k);
        });
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Last-resort substring match (Hebrew / English) when regex misses.
 * @param {string} q
 * @param {Set<string>} whitelist
 */
export function resolveParamSmartSearchFuzzy(q, whitelist) {
  const n = normalizeSearchQuery(q);
  if (!n) return [];
  const chunks = tokenizeQueryChunks(n);
  const low = n.toLowerCase();
  const hasEn = (s) => low.includes(s);
  const hit = (tok) => chunks.some((c) => stringsTypoClose(tok, c));
  const out = [];

  if (
    (hit('זווית') && (hit('אף') || hit('פיץ')))
    || hasEn('pitch')
    || (hasEn('max') && hasEn('pitch'))
    || ((hit('מקסימאלית') || hit('מסימאלית') || hit('מקסימלית')) && (hit('אף') || hit('פיץ') || hit('זווית')))
  ) {
    if (whitelist.has('LIM_PITCH_CD')) out.push('LIM_PITCH_CD');
  }
  if ((hit('גלגול') || hit('רול') || hit('גלגל')) && (hit('מקס') || hasEn('roll'))) {
    if (whitelist.has('LIM_ROLL_CD')) out.push('LIM_ROLL_CD');
  }
  if (
    (hit('קצב') || hit('מהירות') || hasEn('rate'))
    && (hit('גלגול') || hit('רול') || hasEn('roll'))
  ) {
    if (whitelist.has('RLL2SRV_RMAX')) out.push('RLL2SRV_RMAX');
  }
  if ((hit('נחיתה') || hit('נחיתא')) && (hit('מהירות') || (hasEn('land') && hasEn('speed')))) {
    if (whitelist.has('LAND_SPEED')) out.push('LAND_SPEED');
  }
  return [...new Set(out)];
}

const LOCAL_RULES = [
  {
    keys: ['LIM_PITCH_CD'],
    patterns: [
      /lim[_\s-]*pitch/i,
      /max.*pitch/i,
      /pitch.*up/i,
      /pitch.*limit/i,
      /pitch.*angle/i,
      /פיץ/,
      /זווית.*אף/,
      /אף.*חיובית/,
      /חיובית.*מקסימלית/,
      /חיובית.*מקסימאלית/,
      /מקסימאלית.*חיובית/,
      /זווית.*פיץ/,
      /אף.*מקס/,
      /אף.*מקסימל/,
      /גובה.*מקס.*אפ/,
      /זווית אף/,
      /נוט.*אף/,
    ],
  },
  {
    keys: ['LIM_ROLL_CD'],
    patterns: [/lim[_\s-]*roll/i, /roll.*limit/i, /max.*roll/i, /גלגול/, /רול/],
  },
  {
    keys: ['RLL2SRV_RMAX'],
    patterns: [
      /rll2srv[_\s-]*rmax/i,
      /roll.*rate/i,
      /rate.*roll/i,
      /קצב.*גלגול/,
      /מהירות.*גלגול/,
      /רול.*לשניה/,
    ],
  },
  {
    keys: ['LAND_SPEED'],
    patterns: [/land[_\s-]*speed/i, /מהירות.*נחיתה/, /נחיתה.*מהירות/, /sink.*final/i],
  },
  {
    keys: ['LAND_SPEED', 'LIM_PITCH_CD'],
    patterns: [/land.*pitch/i, /נחיתה.*פיץ/],
  },
  {
    keys: ['LAND_FLARE_ALT'],
    patterns: [/flare.*alt/i, /הצפה.*גובה/, /גובה.*הצפה/],
  },
  {
    keys: ['FS_THR_ENABLE', 'FS_THR_VALUE'],
    patterns: [/fail.?safe/i, /פייל.?סייף/, /אובדן.*throttle/i],
  },
  {
    keys: ['companion_sr_bucket'],
    patterns: [/קצב/, /קצבים/, /תדירות/, /stream.*rate/i, /\bsr[1-8]_/i, /telemetry.*rate/i],
  },
  {
    keys: ['companion_serial_port'],
    patterns: [/סריאל/, /סיריאל/, /serial\s*\d/i, /\bCOMPANION\b/i],
  },
];

/** Short bilingual blurbs when Gemini is off or did not return a row. */
const STATIC_MATCH_LINES = {
  LIM_PITCH_CD: {
    label_he: 'מגבלת זווית אף מקסימלית — כמה מעלות האף מורשה לעלות (ביחידות של מאית מעלה; למשל 3000 ≈ 30°).',
    label_en: 'LIM_PITCH_CD — maximum nose-up pitch (centidegrees)',
  },
  LIM_ROLL_CD: {
    label_he: 'מגבלת זווית גלגול מקסימלית (סנטי־מעלות).',
    label_en: 'LIM_ROLL_CD — maximum roll (centidegrees)',
  },
  RLL2SRV_RMAX: {
    label_he: 'קצב גלגול מקסימלי במעלות לשנייה (rate), לא זווית גלגול יעד.',
    label_en: 'RLL2SRV_RMAX — maximum roll rate (deg/s)',
  },
  LAND_SPEED: {
    label_he: 'מהירות שקיעה סופית בנחיתה (ס״מ/ש).',
    label_en: 'LAND_SPEED — final landing sink rate (cm/s)',
  },
  LAND_SPEED_HIGH: {
    label_he: 'מהירות נחיתה בשלב גבוה יותר.',
    label_en: 'LAND_SPEED_HIGH',
  },
  LAND_ALT_LOW: {
    label_he: 'גובה מעבר לשלב נחיתה נמוך (ס״מ).',
    label_en: 'LAND_ALT_LOW',
  },
  LAND_ABORT_PWM: {
    label_he: 'ערוץ/ערך PWM ללוגיקת ביטול נחיתה.',
    label_en: 'LAND_ABORT_PWM',
  },
  FS_THR_ENABLE: {
    label_he: 'הפעלת failsafe על אובדן throttle / RC.',
    label_en: 'FS_THR_ENABLE — throttle failsafe mode',
  },
  FS_THR_VALUE: {
    label_he: 'ערך PWM שמתחתיו נחשב אובדן throttle.',
    label_en: 'FS_THR_VALUE — PWM threshold for throttle failsafe',
  },
  ARMING_CHECK: {
    label_he: 'מסכת בדיקות לפני ARM.',
    label_en: 'ARMING_CHECK — pre-arm check bitmask',
  },
  companion_serial_port: {
    label_he: 'איזה יציאת SERIAL בבקר מחוברת ל‑Companion (פרוטוקול ובאוד).',
    label_en: 'companion_serial_port — which SERIAL port is wired to the companion',
  },
  companion_sr_bucket: {
    label_he: 'מאיזה ערוץ SRx נשלחים קצבי הטלמטריה (Hz) ל‑Companion — קשור לרענון המסך והלוגים.',
    label_en: 'companion_sr_bucket — which SRn_* group carries stream rates to the companion',
  },
};

/** ArduPilot params not yet exposed in current Param Center UI (suggest-only). */
const ARDUPILOT_EXTRA_CATALOG = [
  {
    param_key: 'AUTOTUNE_LEVEL',
    label_he: 'רמת אוטוטיון (AutoTune) לבקרת היגוי/ייצוב. פרמטר ArduPilot קלאסי.',
    label_en: 'AUTOTUNE_LEVEL — autotune aggressiveness level',
    needles: ['autotune', 'auto tune', 'אוטוטיון', 'אוטו טיון', 'כיוון אוטומטי', 'טיונינג אוטומטי'],
  },
  {
    param_key: 'AUTOTUNE_AXES',
    label_he: 'בחירת צירים לתהליך AutoTune (אילו צירים לכייל אוטומטית).',
    label_en: 'AUTOTUNE_AXES — bitmask of axes included in autotune',
    needles: ['autotune axes', 'צירי אוטוטיון', 'אילו צירים autotune', 'axes tune'],
  },
  {
    param_key: 'PTCH2SRV_RMAX',
    label_he: 'קצב פיץ׳ מקסימלי (מעלות/שנייה) — פרמטר קצב, לא זווית יעד.',
    label_en: 'PTCH2SRV_RMAX — maximum pitch rate (deg/s)',
    needles: ['קצב פיץ', 'pitch rate', 'קצב אף', 'מהירות פיץ'],
  },
  {
    param_key: 'RLL2SRV_TCONST',
    label_he: 'קבוע זמן של בקרת גלגול (Roll). ערך נמוך = תגובה מהירה יותר.',
    label_en: 'RLL2SRV_TCONST — roll controller time constant',
    needles: ['roll tconst', 'קבוע זמן גלגול', 'תגובה גלגול'],
  },
  {
    param_key: 'PTCH2SRV_TCONST',
    label_he: 'קבוע זמן בקרת פיץ׳. משפיע על מהירות תגובת האף לשינויי יעד.',
    label_en: 'PTCH2SRV_TCONST — pitch controller time constant',
    needles: ['pitch tconst', 'קבוע זמן פיץ', 'תגובה אף'],
  },
  {
    param_key: 'NAVL1_PERIOD',
    label_he: 'פרמטר ליבה לניווט L1; משנה אגרסיביות פניות ותגובה למסלול.',
    label_en: 'NAVL1_PERIOD — L1 guidance period',
    needles: ['l1', 'navl1', 'ניווט l1', 'אגרסיביות פניה'],
  },
  {
    param_key: 'NAVL1_DAMPING',
    label_he: 'שיכוך בקרת L1; גבוה יותר מפחית תנודות במסלול.',
    label_en: 'NAVL1_DAMPING — L1 guidance damping',
    needles: ['l1 damping', 'שיכוך l1', 'תנודות ניווט'],
  },
  {
    param_key: 'TECS_SPDWEIGHT',
    label_he: 'איזון TECS בין שמירת מהירות לשמירת גובה.',
    label_en: 'TECS_SPDWEIGHT — TECS speed-vs-altitude weighting',
    needles: ['tecs', 'מהירות מול גובה', 'spdweight', 'גישה'],
  },
];

function staticMatch(key) {
  const s = STATIC_MATCH_LINES[key];
  return {
    param_key: key,
    label_he: s?.label_he || `פרמטר מטרה בבקר: ${key}`,
    label_en: s?.label_en || key,
  };
}

/** Hebrew ≥5 / English ≥5 chars from static blurbs → typo-tolerant needles (Gemini-like recall). */
function buildLabelNeedleRows() {
  const STOP_HE = new Set(['שלבים', 'שלב', 'יותר', 'נמוך', 'גבוה', 'סופית', 'יחידות', 'מאית', 'לפני']);
  const rows = [];
  for (const [key, { label_he, label_en }] of Object.entries(STATIC_MATCH_LINES)) {
    const he = (label_he || '').match(/[\u0590-\u05FF]{5,}/g) || [];
    const en = (label_en || '').match(/[a-zA-Z]{5,}/g) || [];
    const needles = [
      ...new Set([
        ...he.filter((w) => !STOP_HE.has(w)),
        ...en.map((w) => w.toLowerCase()),
      ]),
    ];
    if (needles.length) rows.push({ keys: [key], needles, maxDist: 2 });
  }
  return rows;
}

let approxLabelRowsCache = null;
function getApproxAndLabelRows() {
  if (!approxLabelRowsCache) approxLabelRowsCache = [...APPROX_SYNONYMS, ...buildLabelNeedleRows()];
  return approxLabelRowsCache;
}

/**
 * @param {string} q
 * @returns {string[]}
 */
export function resolveParamSmartSearchLocal(q) {
  const s = normalizeSearchQuery(q);
  if (!s) return [];
  const whitelist = new Set(listParamCenterSmartSearchKeys());
  const found = new Set();
  for (const rule of LOCAL_RULES) {
    if (rule.patterns.some((re) => re.test(s))) {
      rule.keys.forEach((k) => {
        if (whitelist.has(k)) found.add(k);
      });
    }
  }
  for (const k of resolveParamSmartSearchFuzzy(s, whitelist)) {
    found.add(k);
  }
  for (const k of resolveParamSmartSearchApprox(s, whitelist)) {
    found.add(k);
  }
  return [...found];
}

function resolveParamSmartSearchLocalStrict(q, whitelist) {
  const s = normalizeSearchQuery(q);
  if (!s) return [];
  const found = new Set();
  for (const rule of LOCAL_RULES) {
    if (rule.patterns.some((re) => re.test(s))) {
      rule.keys.forEach((k) => {
        if (whitelist.has(k)) found.add(k);
      });
    }
  }
  for (const k of resolveParamSmartSearchFuzzy(s, whitelist)) found.add(k);
  return [...found];
}

function tokenizeSearchTerms(s) {
  return tokenizeQueryChunks(s).map((x) => String(x || '').toLowerCase());
}

function keyTokenMatchScore(searchTerms, key) {
  const kt = String(key || '').toLowerCase().split(/[_-]+/).filter((x) => x.length >= 2);
  let score = 0;
  for (const t of searchTerms) {
    if (!t || t.length < 2) continue;
    if (kt.some((k) => k === t)) score += 4;
    else if (kt.some((k) => stringsTypoClose(k, t))) score += 3;
  }
  return score;
}

function labelTokenMatchScore(searchTerms, key) {
  const s = staticMatch(key);
  const he = (s.label_he || '').match(/[\u0590-\u05FF]{3,}/g) || [];
  const en = (s.label_en || '').match(/[a-zA-Z]{3,}/g) || [];
  const labelTokens = [...new Set([...he, ...en.map((x) => x.toLowerCase())])];
  let score = 0;
  for (const t of searchTerms) {
    if (!t || t.length < 3) continue;
    if (labelTokens.some((w) => stringsTypoClose(w, t))) score += 2;
  }
  return score;
}

function scoreCandidateKey(qNorm, key, flags) {
  const searchTerms = tokenizeSearchTerms(qNorm);
  let score = 0;
  if (flags.fromGemini) score += 2;
  if (flags.fromStrict) score += 3;
  if (flags.fromApprox) score += 1;
  score += keyTokenMatchScore(searchTerms, key);
  score += labelTokenMatchScore(searchTerms, key);
  const qLow = String(qNorm || '').toLowerCase();
  const companionIntent = /companion|serial|sr\d|telemetry|baud|סיריאל|סריאל|תקשורת|קצב|טלמטרי/.test(qLow);
  if ((key === 'companion_serial_port' || key === 'companion_sr_bucket') && !companionIntent) score -= 7;
  return score;
}

function detectSearchIntent(qNorm) {
  const qLow = String(qNorm || '').toLowerCase();
  const terms = tokenizeSearchTerms(qNorm);
  const hasTermCloseTo = (...needles) => terms.some((t) => needles.some((n) => stringsTypoClose(t, n)));
  const hasRateWord = hasTermCloseTo('קצב', 'מהירות', 'rate', 'rates');
  const hasRollWord = hasTermCloseTo('גלגול', 'רול', 'roll');
  const hasPitchWord = hasTermCloseTo('פיץ', 'אף', 'pitch', 'nose');
  const hasLandingWord = hasTermCloseTo('נחיתה', 'הצפה', 'land', 'landing', 'flare', 'sink');
  const hasCompanionWord = hasTermCloseTo('companion', 'serial', 'baud', 'telemetry', 'סריאל', 'סיריאל', 'טלמטריה', 'תקשורת', 'פורט', 'port');
  const hasSrWord = hasTermCloseTo('sr', 'srx', 'sr1', 'sr2', 'sr3', 'sr4', 'sr5', 'sr6', 'sr7', 'sr8');
  return {
    companion: hasCompanionWord || hasSrWord || (hasRateWord && (hasCompanionWord || hasSrWord)) || /sr\d|telemetry|companion/.test(qLow),
    pitch: hasPitchWord || /pitch|nose|זווית.*אף|חיובית/.test(qLow),
    roll: hasRollWord || /roll|bank/.test(qLow),
    landing: hasLandingWord || /land|landing|flare|שקיעה|מהירות.*נחיתה/.test(qLow),
    ekf: /ekf|ahrs|gps|קלמן|ניווט/.test(qLow),
    safety: /failsafe|arming|בטיחות|חימוש|abort|אובדן/.test(qLow),
  };
}

function resolveHardIntentOverrides(qNorm, whitelist) {
  const qLow = String(qNorm || '').toLowerCase();
  const hasRate = /(קצב|מהירות|rate|rates)/.test(qLow);
  const hasRoll = /(גלגול|רול|roll)/.test(qLow);
  const hasPitch = /(פיץ|זווית.*אף|pitch|nose)/.test(qLow);
  const out = [];
  if (hasRate && hasRoll && whitelist.has('RLL2SRV_RMAX')) out.push('RLL2SRV_RMAX');
  if (hasRate && hasPitch && whitelist.has('PTCH2SRV_RMAX')) out.push('PTCH2SRV_RMAX');
  return out;
}

function isKeyCompatibleWithIntent(key, intent) {
  const k = String(key || '');
  if (intent.pitch) {
    return /^LIM_PITCH_CD$/.test(k) || /^LAND_/.test(k) || /^LIM_/.test(k);
  }
  if (intent.roll) {
    return /^RLL2SRV_RMAX$/.test(k) || /^LIM_ROLL_CD$/.test(k) || /^LIM_/.test(k);
  }
  if (intent.landing) {
    return /^LAND_/.test(k) || /^PLND_/.test(k) || /^LIM_PITCH_CD$/.test(k);
  }
  if (intent.ekf) {
    return /^EK3_/.test(k) || /^AHRS_/.test(k) || /^PLND_/.test(k);
  }
  if (intent.safety) {
    return /^FS_/.test(k) || /^ARMING_/.test(k) || /^LAND_ABORT_/.test(k);
  }
  if (intent.companion) {
    return (
      k === 'companion_serial_port'
      || k === 'companion_sr_bucket'
      || /^SERIAL\d+_/.test(k)
      || /^SR\d_/.test(k)
      || /^FS_/.test(k)
    );
  }
  return true;
}

function rankAndTrimMatches(qNorm, candidateMap, cap = 6) {
  const intent = detectSearchIntent(qNorm);
  let rows = [...candidateMap.values()]
    .map((c) => ({ ...c, score: scoreCandidateKey(qNorm, c.param_key, c) }))
    .sort((a, b) => b.score - a.score || Number(b.fromStrict) - Number(a.fromStrict) || Number(b.fromGemini) - Number(a.fromGemini));
  const qLow = String(qNorm || '').toLowerCase();
  const companionIntent = /companion|serial|sr\d|telemetry|baud|סיריאל|סריאל|תקשורת|קצב|טלמטרי/.test(qLow);
  const flightIntent = /pitch|roll|limit|land|flare|failsafe|arming|ekf|plnd|נחיתה|הצפה|פיץ|אף|גלגול|רול|בטיחות|חימוש|גובה/.test(qLow);
  if (companionIntent && !flightIntent) {
    rows = rows.filter((r) => r.param_key === 'companion_serial_port' || r.param_key === 'companion_sr_bucket' || /^SR\d_/.test(r.param_key));
  }
  if (!companionIntent) {
    const hasNonCompanion = rows.some((r) => r.param_key !== 'companion_serial_port' && r.param_key !== 'companion_sr_bucket');
    if (hasNonCompanion) {
      rows = rows.filter((r) => r.param_key !== 'companion_serial_port' && r.param_key !== 'companion_sr_bucket');
    }
  }
  const intentFiltered = rows.filter((r) => isKeyCompatibleWithIntent(r.param_key, intent));
  if (intentFiltered.length) rows = intentFiltered;
  const kept = rows.filter((r, i) => r.score >= 2 || i === 0).slice(0, cap);
  return kept.map((r) => ({ param_key: r.param_key, label_he: r.label_he, label_en: r.label_en }));
}

function rankLocalMatches(qNorm, strictKeys, approxKeys) {
  /** @type {Map<string, { param_key: string, label_he: string, label_en: string, fromGemini: boolean, fromStrict: boolean, fromApprox: boolean }>} */
  const candidates = new Map();
  for (const k of strictKeys) {
    const prev = candidates.get(k) || { ...staticMatch(k), fromGemini: false, fromStrict: false, fromApprox: false };
    prev.fromStrict = true;
    candidates.set(k, prev);
  }
  for (const k of approxKeys) {
    const prev = candidates.get(k) || { ...staticMatch(k), fromGemini: false, fromStrict: false, fromApprox: false };
    prev.fromApprox = true;
    candidates.set(k, prev);
  }
  return rankAndTrimMatches(qNorm, candidates);
}

function resolveArduExtraCatalog(qNorm, whitelistSet) {
  const terms = tokenizeSearchTerms(qNorm);
  const out = [];
  for (const row of ARDUPILOT_EXTRA_CATALOG) {
    if (whitelistSet.has(row.param_key)) continue;
    const hit = row.needles.some((n) => terms.some((t) => stringsTypoClose(t, n) || String(n).toLowerCase().includes(t)));
    if (!hit) continue;
    out.push({
      param_key: row.param_key,
      label_he: row.label_he,
      label_en: row.label_en,
      available_in_ui: false,
    });
  }
  return out.slice(0, 6);
}

async function resolveArduExtraGemini(qNorm, whitelist) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  const modelName = resolveGeminiModelName();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 900 },
  });
  const prompt = `Return JSON only:
{"matches":[{"param_key":"NAME","label_he":"...","label_en":"..."}]}

Task: suggest up to 5 ArduPlane/ArduPilot parameter names that best match the user intent,
including params that might NOT be in this editable UI.

Rules:
- Do NOT return any param from this "already-editable" list:
${JSON.stringify(whitelist)}
- Use canonical ArduPilot parameter names only.
- If unsure, return {"matches":[]}.

User query:
${JSON.stringify(qNorm)}`;
  const result = await model.generateContent(prompt);
  let text = String(result.response.text() || '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed.matches) ? parsed.matches : [];
  const wl = new Set(whitelist);
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const k = String(m?.param_key || '').trim();
    if (!k || wl.has(k) || seen.has(k) || !/^[A-Z0-9_]{3,}$/.test(k)) continue;
    seen.add(k);
    out.push({
      param_key: k,
      label_he: String(m.label_he || '').trim() || `קיים בארדופיילוט אך לא פתוח לעריכה במסך זה: ${k}`,
      label_en: String(m.label_en || '').trim() || `${k} (ArduPilot param outside current Param Center scope)`,
      available_in_ui: false,
    });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * @param {string} q
 * @param {string[]} whitelist
 * @returns {Promise<{ keys: string[], matches: { param_key: string, label_he: string, label_en: string }[] }>}
 */
async function resolveParamSmartSearchGeminiEnriched(q, whitelist) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { keys: [], matches: [] };
  const modelName = resolveGeminiModelName();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.15, maxOutputTokens: 2048 },
  });
  const prompt = `You help ArduPlane / ArduPilot operators. The user describes what they want in plain Hebrew or English (not necessarily exact parameter names). The text may contain spelling mistakes, missing letters, wrong sofit letters, or mixed wording — infer intent anyway.

Return JSON only with this exact shape:
{"matches":[{"param_key":"NAME","label_he":"...","label_en":"..."}]}

Rules:
- Each param_key MUST be copied EXACTLY from the allowed list below (case-sensitive). Never invent names.
- 1 to 10 matches, most relevant first.
- label_he: one or two short sentences in Hebrew explaining what this parameter does for the pilot.
- label_en: one short line in English; include the exact param_key token at the start or end.
- Do NOT include communication/companion params unless user intent explicitly mentions communication/serial/telemetry/SRx.
- Do NOT include unrelated params: if user asks roll limit, return roll-related params only; if asks pitch limit, return pitch-related params only.
- If nothing in the list fits: {"matches":[]}

Allowed parameter names (JSON array):
${JSON.stringify(whitelist)}

User query:
${JSON.stringify(q)}`;

  const result = await model.generateContent(prompt);
  let text = result.response.text();
  text = String(text || '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    logger.warn({ err: String(e), snippet: text.slice(0, 200) }, 'param-smart-search: Gemini JSON parse failed');
    return { keys: [], matches: [] };
  }
  const raw = Array.isArray(parsed.matches) ? parsed.matches : [];
  const wl = new Set(whitelist);
  const matches = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m.param_key !== 'string' || !wl.has(m.param_key) || seen.has(m.param_key)) continue;
    seen.add(m.param_key);
    matches.push({
      param_key: m.param_key,
      label_he: String(m.label_he || '').trim() || staticMatch(m.param_key).label_he,
      label_en: String(m.label_en || '').trim() || staticMatch(m.param_key).label_en,
    });
    if (matches.length >= 10) break;
  }
  const keys = matches.map((m) => m.param_key);
  return { keys, matches };
}

/**
 * @param {string} q
 * @returns {Promise<{ ok: boolean, keys: string[], matches: { param_key: string, label_he: string, label_en: string }[], source: string, message?: string }>}
 */
export async function runParamSmartSearch(q) {
  const whitelist = listParamCenterSmartSearchKeys();
  const wlSet = new Set(whitelist);
  const qNorm = normalizeSearchQuery(q);
  const hardKeys = resolveHardIntentOverrides(qNorm, wlSet);
  if (hardKeys.length) {
    const matches = hardKeys.map((k) => staticMatch(k));
    return { ok: true, keys: hardKeys, matches, source: 'hard-intent' };
  }
  const localStrictKeys = resolveParamSmartSearchLocalStrict(qNorm, wlSet).filter((k) => wlSet.has(k));
  const localApproxKeys = resolveParamSmartSearchApprox(qNorm, wlSet).filter((k) => wlSet.has(k));

  if (process.env.GEMINI_API_KEY) {
    try {
      const gem = await resolveParamSmartSearchGeminiEnriched(qNorm, whitelist);
      /** @type {Map<string, { param_key: string, label_he: string, label_en: string, fromGemini: boolean, fromStrict: boolean, fromApprox: boolean }>} */
      const candidates = new Map();
      for (const m of gem.matches) {
        candidates.set(m.param_key, { ...m, fromGemini: true, fromStrict: false, fromApprox: false });
      }
      for (const k of localStrictKeys) {
        const prev = candidates.get(k) || { ...staticMatch(k), fromGemini: false, fromStrict: false, fromApprox: false };
        prev.fromStrict = true;
        candidates.set(k, prev);
      }
      // Approximate matches are noisy by nature — include only when Gemini missed everything.
      if (!gem.matches.length) {
        for (const k of localApproxKeys) {
          const prev = candidates.get(k) || { ...staticMatch(k), fromGemini: false, fromStrict: false, fromApprox: false };
          prev.fromApprox = true;
          candidates.set(k, prev);
        }
      }
      const merged = rankAndTrimMatches(qNorm, candidates);
      if (merged.length) {
        const source = gem.matches.length ? (localStrictKeys.length ? 'gemini+local' : 'gemini') : 'local';
        return {
          ok: true,
          keys: merged.map((m) => m.param_key),
          matches: merged,
          source,
        };
      }
      if (localStrictKeys.length || localApproxKeys.length) {
        const matches = rankLocalMatches(qNorm, localStrictKeys, localApproxKeys);
        return { ok: true, keys: matches.map((m) => m.param_key), matches, source: 'local' };
      }
      const outsideCatalog = resolveArduExtraCatalog(qNorm, wlSet);
      const outsideGemini = outsideCatalog.length ? [] : await resolveArduExtraGemini(qNorm, whitelist);
      const outside_matches = [...outsideCatalog, ...outsideGemini].slice(0, 6);
      if (outside_matches.length) {
        return { ok: true, keys: [], matches: [], source: 'outside', outside_matches };
      }
      return { ok: true, keys: [], matches: [], source: 'none' };
    } catch (err) {
      logger.warn({ err: err?.message || String(err) }, 'param-smart-search: Gemini request failed');
      if (localStrictKeys.length || localApproxKeys.length) {
        const matches = rankLocalMatches(qNorm, localStrictKeys, localApproxKeys);
        return { ok: true, keys: matches.map((m) => m.param_key), matches, source: 'local', message: err?.message };
      }
      const fuzzyOnly = [
        ...new Set([...resolveParamSmartSearchFuzzy(qNorm, wlSet), ...resolveParamSmartSearchApprox(qNorm, wlSet)]),
      ].filter((k) => wlSet.has(k));
      if (fuzzyOnly.length) {
        const matches = fuzzyOnly.map((k) => staticMatch(k));
        return { ok: true, keys: fuzzyOnly, matches, source: 'fuzzy', message: err?.message };
      }
      const outsideCatalog = resolveArduExtraCatalog(qNorm, wlSet);
      if (outsideCatalog.length) {
        return { ok: true, keys: [], matches: [], source: 'outside', outside_matches: outsideCatalog, message: err?.message };
      }
      return { ok: false, keys: [], matches: [], source: 'error', message: err?.message || String(err) };
    }
  }

  if (localStrictKeys.length || localApproxKeys.length) {
    const matches = rankLocalMatches(qNorm, localStrictKeys, localApproxKeys);
    return { ok: true, keys: matches.map((m) => m.param_key), matches, source: 'local' };
  }
  const outsideCatalog = resolveArduExtraCatalog(qNorm, wlSet);
  if (outsideCatalog.length) return { ok: true, keys: [], matches: [], source: 'outside', outside_matches: outsideCatalog };
  return { ok: true, keys: [], matches: [], source: 'none' };
}
