import { listParamCenterSmartSearchKeys } from './param-schema.mjs';
import { allParamEntries, getParamInfo as getOfficialParamInfo } from './docs-param-kb.mjs';
import { semanticSearch, isSemanticSearchAvailable } from './param-semantic-search.mjs';

/** Shared Hebrew→English aviation term map (mirrors the one in param-smart-search-v2.mjs). */
const HE_EN_KB = {
  'סיסה': ['yaw'], 'גלגול': ['roll'], 'אף': ['pitch'], 'קצב': ['rate'],
  'זווית': ['angle'], 'הטיה': ['bank', 'roll'],
  'מהירות': ['speed', 'airspeed'], 'גובה': ['altitude', 'height', 'alt'],
  'שקיעה': ['sink', 'descent'], 'עלייה': ['climb'],
  'בקר': ['controller', 'control'], 'בקרת': ['controller', 'control'],
  'גאין': ['gain'], 'הגבר': ['gain'], 'שיכוך': ['damping'], 'חיכוך': ['damping'],
  'קבוע': ['constant', 'time'], 'מסנן': ['filter'],
  'כיול': ['calibration', 'tune', 'autotune'], 'אוטוטיון': ['autotune'],
  'מגבלה': ['limit', 'max'], 'מגבלת': ['limit', 'max'],
  'מקסימלי': ['maximum', 'max'], 'מינימלי': ['minimum', 'min'],
  'סרוו': ['servo'], 'סרו': ['servo'], 'פלט': ['output'], 'יציאה': ['output'],
  'יציאת': ['output'], 'ערוץ': ['channel'],
  'ניווט': ['navigation', 'nav'], 'מצב': ['mode'],
  'קלמן': ['kalman', 'ekf'], 'בטיחות': ['failsafe', 'safety'],
  'כשל': ['failsafe'], 'חימוש': ['arming'],
  'נחיתה': ['landing', 'land'], 'המראה': ['takeoff'], 'גישה': ['approach'],
  'ריחוף': ['loiter', 'hover'], 'מצערת': ['throttle'], 'מנוע': ['throttle', 'motor'],
  'טיסה': ['flight'], 'הפעלה': ['enable'], 'כיבוי': ['disable'],
  'מגבר': ['gain', 'amplifier'], 'מקדם': ['gain', 'coefficient'],
  'אינטגרל': ['integral'], 'רגולטור': ['controller'],
  // Nose wheel / ground steering
  'ניהוג': ['steer', 'steering'],
  'היגוי': ['steer', 'steering'],
  'הגה': ['steering', 'rudder'],
  'גלגל': ['wheel'],
  'גלגלים': ['wheel', 'gear'],
  'קרקע': ['ground'],
  'מדרך': ['ground', 'taxi'],
  'הנדלה': ['taxi', 'ground'],
  'הסעה': ['taxi'],
  'כיוון': ['heading', 'direction'],
};

const EDITABLE_SET = new Set(listParamCenterSmartSearchKeys());

/** Canonical ArduPlane-centric catalog fallback (can be expanded safely). */
const ARDUPLANE_CATALOG = [
  { param_key: 'AUTOTUNE_LEVEL', description_en: 'Autotune aggressiveness level.', description_he: 'רמת אוטוטיון.', synonyms: ['autotune', 'אוטוטיון'], units: 'level' },
  { param_key: 'AUTOTUNE_AXES', description_en: 'Axis bitmask for autotune.', description_he: 'בחירת צירים לאוטוטיון.', synonyms: ['autotune axes', 'צירי אוטוטיון'], units: 'bitmask' },
  { param_key: 'RLL2SRV_RMAX', description_en: 'Maximum roll rate.', description_he: 'קצב גלגול מקסימלי.', synonyms: ['roll rate', 'קצב גלגול'], units: 'deg/s' },
  { param_key: 'PTCH2SRV_RMAX', description_en: 'Maximum pitch rate.', description_he: 'קצב פיץ מקסימלי.', synonyms: ['pitch rate', 'קצב פיץ'], units: 'deg/s' },
  { param_key: 'RLL2SRV_TCONST', description_en: 'Roll controller time constant.', description_he: 'קבוע זמן גלגול.', synonyms: ['roll tconst', 'תגובה גלגול'] },
  { param_key: 'PTCH2SRV_TCONST', description_en: 'Pitch controller time constant.', description_he: 'קבוע זמן פיץ.', synonyms: ['pitch tconst', 'תגובה אף'] },
  { param_key: 'LIM_ROLL_CD', description_en: 'Maximum roll angle in centidegrees.', description_he: 'מגבלת זווית גלגול.', synonyms: ['roll limit', 'זווית גלגול'], units: 'cdeg' },
  { param_key: 'LIM_PITCH_CD', description_en: 'Maximum pitch angle in centidegrees.', description_he: 'מגבלת זווית אף.', synonyms: ['pitch limit', 'זווית אף'], units: 'cdeg' },
  { param_key: 'LAND_SPEED', description_en: 'Final landing sink speed.', description_he: 'מהירות שקיעה סופית לנחיתה.', synonyms: ['landing speed', 'מהירות נחיתה'], units: 'cm/s' },
  { param_key: 'LAND_SPEED_HIGH', description_en: 'Landing speed at higher stage.', description_he: 'מהירות נחיתה בשלב גבוה.', synonyms: ['land speed high'] },
  { param_key: 'LAND_ALT_LOW', description_en: 'Switch altitude to low landing stage.', description_he: 'גובה מעבר לשלב נחיתה נמוך.', synonyms: ['land alt low'] },
  { param_key: 'LAND_ABORT_PWM', description_en: 'Abort landing PWM threshold.', description_he: 'סף PWM לביטול נחיתה.', synonyms: ['abort landing', 'ביטול נחיתה'] },
  { param_key: 'NAVL1_PERIOD', description_en: 'L1 guidance period.', description_he: 'פרמטר ניווט L1.', synonyms: ['navl1', 'l1 period'] },
  { param_key: 'NAVL1_DAMPING', description_en: 'L1 guidance damping.', description_he: 'שיכוך L1.', synonyms: ['l1 damping', 'שיכוך ניווט'] },
  { param_key: 'TECS_SPDWEIGHT', description_en: 'TECS speed-vs-altitude weight.', description_he: 'איזון TECS בין מהירות לגובה.', synonyms: ['tecs', 'spdweight'] },
  { param_key: 'EK3_ENABLE', description_en: 'Enable EKF3 estimator.', description_he: 'הפעלת EKF3.', synonyms: ['ekf', 'קלמן'] },
  { param_key: 'EK3_GPS_TYPE', description_en: 'EKF3 GPS usage mode.', description_he: 'מצב שימוש GPS ב-EKF3.', synonyms: ['ekf gps', 'ניווט gps'] },
  { param_key: 'EK3_ALT_SOURCE', description_en: 'EKF3 altitude source.', description_he: 'מקור גובה ל-EKF3.', synonyms: ['alt source', 'מקור גובה'] },
  { param_key: 'AHRS_EKF_TYPE', description_en: 'AHRS EKF type selection.', description_he: 'בחירת סוג EKF ל-AHRS.', synonyms: ['ahrs ekf'] },
  { param_key: 'FS_THR_ENABLE', description_en: 'Throttle failsafe behavior.', description_he: 'התנהגות Failsafe מצערת.', synonyms: ['failsafe', 'בטיחות'] },
  { param_key: 'FS_THR_VALUE', description_en: 'PWM threshold for throttle failsafe.', description_he: 'סף PWM ל-Failsafe.', synonyms: ['failsafe pwm'] },
  { param_key: 'ARMING_CHECK', description_en: 'Pre-arm checks bitmask.', description_he: 'מסכת בדיקות לפני חימוש.', synonyms: ['arming check', 'בדיקות חימוש'] },
  /** Servo output N — "יציאת סרוו" / "servo 2" maps here, not to EKF. */
  {
    param_key: 'SERVO2_FUNCTION',
    description_en: 'ArduPlane: output function for servo output 2 (what the PWM channel controls).',
    description_he: 'הגדרת תפקיד יציאת סרוו 2 (מה שערוץ ה-PWM מפעיל) — ArduPlane.',
    synonyms: [
      'servo 2',
      'servo2',
      'סרו 2',
      'סרוו 2',
      'מספר 2',
      'יציאת סרו',
      'יציאת סרוו',
      'פלט סרוו',
      'ערוץ סרוו',
    ],
  },
  {
    param_key: 'SERVO2_MIN',
    description_en: 'Minimum PWM in microseconds for servo 2 output.',
    description_he: 'ערך PWM מינימלי למיקרו־שנייה לסרוו 2.',
    synonyms: ['servo 2 min', 'סרו 2 מינימום'],
  },
  {
    param_key: 'SERVO2_MAX',
    description_en: 'Maximum PWM in microseconds for servo 2 output.',
    description_he: 'ערך PWM מקסימלי לסרוו 2.',
    synonyms: ['servo 2 max', 'סרו 2 מקסימום'],
  },
  {
    param_key: 'SERVO2_REVERSED',
    description_en: 'Reverse direction for servo 2 output.',
    description_he: 'היפוך כיוון לסרוו 2.',
    synonyms: ['servo 2 reverse', 'הפוך סרוו'],
  },
  {
    param_key: 'SERIAL2_PROTOCOL',
    description_en: 'MAVLink SERIAL port 2 protocol (not the same as PWM servo output; use for UART wiring).',
    description_he: 'ערוץ SERIAL 2 (UART) — לתקשורת MAVLink, לא אותו דבר כמו יציאת סרוו.',
    synonyms: ['serial 2', 'ממשק 2', 'באוד 2', 'פורט 2'],
  },
  // ── Nose wheel / ground steering ─────────────────────────────────────────
  {
    param_key: 'STEER2SRV_P',
    description_en: 'Steering controller P gain — proportional gain for nose wheel steering.',
    description_he: 'מקדם P של בקר ניהוג גלגל אף (gain פרופורציונלי).',
    simple_he: 'כמה חזק גלגל האף מגיב לסטייה. ערך גבוה מדי יכול לגרום לנענועים; נמוך מדי ירגיש עצלן.',
    synonyms: ['steer p', 'ניהוג p', 'גלגל אף p', 'בקר היגוי', 'nose wheel p'],
  },
  {
    param_key: 'STEER2SRV_I',
    description_en: 'Steering controller I gain — integral gain for nose wheel steering.',
    description_he: 'מקדם אינטגרל (I) של בקר ניהוג גלגל אף.',
    simple_he: 'מתקן שגיאה שנשארת לאורך זמן. בדרך כלל משנים בזהירות ורק אחרי שה-P סביר.',
    synonyms: ['steer i', 'ניהוג i', 'גלגל אף integral', 'nose wheel i'],
  },
  {
    param_key: 'STEER2SRV_D',
    description_en: 'Steering controller D gain — derivative gain for nose wheel steering.',
    description_he: 'מקדם נגזרת (D) של בקר ניהוג גלגל אף.',
    simple_he: 'מרסן תנועה מהירה של ההיגוי. יכול לעזור נגד רעידות, אבל ערך גבוה מדי מוסיף רעש.',
    synonyms: ['steer d', 'ניהוג d', 'גלגל אף derivative', 'nose wheel d'],
  },
  {
    param_key: 'STEER2SRV_IMAX',
    description_en: 'Steering controller integrator maximum — limits wind-up of the I term.',
    description_he: 'מגבלת אינטגרל של בקר ניהוג גלגל אף (מניעת windup).',
    simple_he: 'מגביל כמה תיקון מצטבר מותר לבקר לצבור. מגן מפני תיקון מוגזם.',
    synonyms: ['steer imax', 'ניהוג imax', 'nose wheel imax'],
  },
  {
    param_key: 'STEER2SRV_TCONST',
    description_en: 'Steering controller time constant — how quickly the steering responds.',
    description_he: 'קבוע זמן תגובה של בקר ניהוג גלגל אף.',
    default_value: 0.5,
    simple_he: 'קובע כמה מהר גלגל האף מנסה להגיע לכיוון הרצוי. קטן יותר = תגובה מהירה יותר.',
    synonyms: ['steer tconst', 'קבוע ניהוג', 'תגובת היגוי', 'nose wheel time constant'],
  },
  {
    param_key: 'STEER2SRV_MINSPD',
    description_en: 'Minimum speed below which steering is locked straight (avoids hunting on ground).',
    description_he: 'מהירות מינימלית לפיה ניהוג גלגל האף ננעל ישר (מניעת תנודות בעצירה).',
    simple_he: 'מתחת למהירות הזו הגלגל נשאר ישר כדי לא לרדוף אחרי תיקונים כשהמטוס כמעט עומד.',
    synonyms: ['steer minspd', 'מהירות ניהוג', 'nose wheel min speed'],
  },
  {
    param_key: 'STEER2SRV_SRATE',
    description_en: 'Steering servo slew rate — limits how fast the nose wheel servo moves.',
    description_he: 'קצב תנועה מרבי של סרוו היגוי גלגל האף.',
    simple_he: 'מגביל כמה מהר הסרוו של גלגל האף זז. עוזר למנוע תנועות חדות מדי.',
    synonyms: ['steer srate', 'קצב סרוו ניהוג', 'nose wheel slew'],
  },
  {
    param_key: 'STEER2SRV_TRIM',
    description_en: 'Steering servo trim — neutral PWM value for straight-ahead steering.',
    description_he: 'ערך טרים (אמצע) של סרוו ניהוג גלגל האף.',
    simple_he: 'הערך שבו גלגל האף אמור להיות ישר. משתמשים בזה כשיש סטייה קבועה ימינה או שמאלה.',
    synonyms: ['steer trim', 'טרים ניהוג', 'nose wheel trim'],
  },
  {
    param_key: 'GROUND_STEER_ALT',
    description_en: 'Altitude above which ground steering is disabled and flight steering takes over.',
    description_he: 'גובה שבו בקר ניהוג הקרקע פעיל ליד הקרקע; 0 מכבה שימוש אוטומטי בבקר STEER2SRV לפי גובה.',
    default_value: 0,
    simple_he: 'זה קובע אם ומתי להשתמש בבקר ניהוג הקרקע. ערך 0 בדרך כלל אומר לא להפעיל לפי גובה; ערך מעל 0 מפעיל ליד הקרקע.',
    synonyms: ['ground steer alt', 'גובה ניהוג קרקע', 'מעבר ניהוג', 'הפעלת ניהוג', 'כיבוי ניהוג'],
  },
  {
    param_key: 'GROUND_STEER_DPS',
    description_en: 'Ground steering rate in degrees per second for full rudder stick deflection.',
    description_he: 'קצב ניהוג קרקע במעלות לשנייה עבור סטיק הגה מלא.',
    simple_he: 'כמה מהר המטוס מבקש לפנות על הקרקע כשהסטיק עד הסוף.',
    synonyms: ['ground steer rate', 'קצב ניהוג קרקע', 'מהירות ניהוג קרקע'],
  },
];

const ARDUPLANE_ServoCatalog = (() => {
  const out = [];
  for (let n = 1; n <= 16; n += 1) {
    if ([2].includes(n)) continue;
    out.push({
      param_key: `SERVO${n}_FUNCTION`,
      description_en: `ArduPlane: output function for servo output ${n} (what this PWM output controls).`,
      description_he: `תפקיד יציאת סרוו ${n} (PWM). להפעלת גלגל אף על היציאה הזו מגדירים ערך 26 = GroundSteering.`,
      simple_he: `כאן בוחרים מה עושה יציאת סרוו ${n}. אם גלגל האף מחובר ליציאה הזו, ערך 26 מפעיל ניהוג גלגל אף. ערך 0 מכבה את היציאה.`,
      synonyms: [`servo ${n}`, `servo${n}`, `סרו ${n}`, `סרוו ${n}`, 'ground steering servo', 'הפעלת גלגל אף', 'כיבוי גלגל אף'],
    });
  }
  return out;
})();

const ARDUPLANE_CATALOG_FULL = [...ARDUPLANE_CATALOG, ...ARDUPLANE_ServoCatalog];

function normalizeKey(k) {
  return String(k || '').trim().toUpperCase();
}

function buildBaseEntry(paramKey) {
  const key = normalizeKey(paramKey);
  const manual = ARDUPLANE_CATALOG_FULL.find((r) => r.param_key === key);
  const official = getOfficialParamInfo(key);
  return {
    param_key: key,
    vehicle: 'ArduPlane',
    type: null,
    units: manual?.units || official?.units || null,
    range: official?.range || null,
    enum_values: official?.values || null,
    default_value: manual?.default_value ?? official?.default_value ?? null,
    simple_he: manual?.simple_he || null,
    // Manual catalog has hand-crafted synonyms and Hebrew; official DB has authoritative English.
    description_en: manual?.description_en || official?.description || `${key} parameter`,
    description_he: manual?.description_he || `פרמטר ${key}`,
    // Keep official display_name so the scorer can match "Roll control time constant" etc.
    display_name: official?.display_name || manual?.description_en || key,
    synonyms: Array.isArray(manual?.synonyms) ? manual.synonyms : [],
    safety_tags: [],
    editable_here: EDITABLE_SET.has(key),
    available_on_fc: false,
    live_value: null,
  };
}

/**
 * Why: unify editable schema + built-in catalog + live FC snapshot into one search KB.
 * What: returns deduped rows with explicit editable and FC availability flags.
 */
export function buildArduPlaneSearchKb({ liveParams = null } = {}) {
  /** @type {Map<string, any>} */
  const map = new Map();

  // Seed with editable keys so existing Param Center coverage is guaranteed.
  for (const k of EDITABLE_SET) map.set(k, buildBaseEntry(k));
  // Expand with built-in fallback catalog for hand-curated entries.
  for (const row of ARDUPLANE_CATALOG_FULL) {
    if (!map.has(row.param_key)) map.set(row.param_key, buildBaseEntry(row.param_key));
  }
  // Expand with the full official ArduPlane DB (5000+ params).
  // This is the widest net: every param ArduPilot publishes is now searchable.
  for (const [key] of allParamEntries()) {
    if (!map.has(key)) map.set(key, buildBaseEntry(key));
  }
  // Enrich with live FC params (highest trust for "exists now on connected FC").
  if (liveParams && typeof liveParams === 'object') {
    for (const [kRaw, v] of Object.entries(liveParams)) {
      const k = normalizeKey(kRaw);
      if (!k) continue;
      if (!map.has(k)) map.set(k, buildBaseEntry(k));
      const row = map.get(k);
      row.available_on_fc = true;
      row.live_value = Number.isFinite(Number(v)) ? Number(v) : v;
    }
  }
  return [...map.values()];
}

export function isEditableParamKey(paramKey) {
  return EDITABLE_SET.has(normalizeKey(paramKey));
}

// ── KB-level search (Hebrew-aware) ──────────────────────────────────────────

/**
 * The static-params KB is built once and cached because building it
 * iterates 5 000+ official entries — fine for search but wasteful per-request.
 * Live-param enrichment is NOT included in the cache; it's applied separately.
 * @type {Array | null}
 */
let _staticKbCache = null;

function getStaticKb() {
  if (_staticKbCache) return _staticKbCache;
  _staticKbCache = buildArduPlaneSearchKb({ liveParams: null });
  return _staticKbCache;
}

/**
 * Search the full KB (5 000+ params) with Hebrew + English support.
 *
 * Why this is better than searchOfficialDb() for the advisor:
 *  • The KB entries carry `description_he` and `synonyms` from the manual catalog
 *    → Hebrew queries like "קצב גלגול" correctly score `RLL2SRV_RMAX`
 *  • `display_name` from the official DB covers English display names
 *  • Explicit param-key mentions (ALL_CAPS_WITH_UNDERSCORES) get a large boost
 *
 * @param {string} query
 * @param {{ limit?: number, liveParams?: object | null }} [opts]
 * @returns {Array<{ param_key: string, display_name: string, description_en: string, description_he: string, units: string|null, range: object|null, enum_values: object|null, editable_here: boolean, available_on_fc: boolean, _score: number }>}
 */
export async function searchKb(query, { limit = 15, liveParams = null } = {}) {
  if (!query) return [];

  const base = getStaticKb();

  // If live params provided, enrich a shallow copy of matching entries.
  let kb = base;
  if (liveParams && typeof liveParams === 'object') {
    const liveSet = new Set(Object.keys(liveParams).map((k) => normalizeKey(k)));
    kb = base.map((row) => {
      if (!liveSet.has(row.param_key)) return row;
      const v = liveParams[row.param_key] ?? liveParams[row.param_key.toLowerCase()];
      return {
        ...row,
        available_on_fc: true,
        live_value: Number.isFinite(Number(v)) ? Number(v) : v,
      };
    });
  }

  const qLow = String(query).toLowerCase();
  const rawTerms = qLow.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2);

  // Expand Hebrew terms to English equivalents for cross-language matching.
  const terms = [...new Set(rawTerms.flatMap((t) => {
    const en = HE_EN_KB[t];
    // Also try stripping common Hebrew single-letter prefixes (ל/ב/כ/ו/ה/ש)
    const stripped = /^[\u0590-\u05FF]/.test(t) && t.length >= 4 ? t.replace(/^[לבכוהש]/, '') : null;
    const enStripped = stripped ? HE_EN_KB[stripped] : null;
    return [t, ...(en || []), ...(stripped ? [stripped] : []), ...(enStripped || [])];
  }))];

  // Detect explicit param-key patterns in the raw query (e.g. RLL2SRV_RMAX).
  const explicitKeys = new Set(
    (query.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []).map((k) => k.toUpperCase()),
  );

  const results = [];
  for (const row of kb) {
    // Blob for token matching: official display name + English desc + Hebrew desc + synonyms
    const blob = [
      row.display_name,
      row.description_en,
      row.description_he,
      ...(row.synonyms || []),
    ].join(' ').toLowerCase();

    const key = row.param_key.toLowerCase();
    let score = 0;

    for (const t of terms) {
      if (t.length < 2) continue;
      if (key === t) score += 14;
      else if (key.startsWith(t + '_') || key.startsWith(t)) score += 9;
      else if (key.includes(t)) score += 6;
      if (blob.includes(t)) score += 3;
    }

    // Explicit param key mentioned verbatim in the query → highest priority.
    if (explicitKeys.has(row.param_key)) score += 30;

    if (score <= 0) continue;
    if (row.available_on_fc) score += 1;
    if (row.editable_here) score += 0.5;
    results.push({ ...row, _score: score });
  }

  const keyword = results.sort((a, b) => b._score - a._score).slice(0, limit);

  // If keyword search returned too few results and semantic search is available,
  // fill remaining slots with embedding-based matches (any language, any phrasing).
  if (keyword.length < 4 && isSemanticSearchAvailable()) {
    try {
      const semHits = await semanticSearch(query, { limit: limit * 2 });
      if (semHits && semHits.length) {
        const usedKeys = new Set(keyword.map((r) => r.param_key));
        const base = getStaticKb();
        const kbMap = new Map(base.map((r) => [r.param_key, r]));
        for (const { param_key, similarity } of semHits) {
          if (usedKeys.has(param_key)) continue;
          const row = kbMap.get(param_key);
          if (!row) continue;
          keyword.push({ ...row, _score: similarity * 15, _semantic: true });
          usedKeys.add(param_key);
          if (keyword.length >= limit) break;
        }
      }
    } catch { /* semantic search is best-effort */ }
  }

  return keyword.slice(0, limit);
}

