/**
 * One Hebrew description table for the parameters tab.
 * Meanings follow data/arduplane-params.json. A missing key has no description.
 */
import { getParamInfo } from './docs-param-kb.mjs';

function serialPortHe(n) {
  if (n === 1) return 'יציאת טלמטריה 1';
  if (n === 2) return 'יציאת טלמטריה 2';
  if (n === 3) return 'יציאת ה־GPS';
  return `יציאה טורית ${n}`;
}

function buildDescriptions() {
  const he = {
    EK3_ENABLE: 'הפעלת מסנן הניווט EKF3',
    AHRS_EKF_TYPE: 'איזה EKF מחשב מיקום וזוויות. ברירת מחדל: 3.',
    EK3_SRC1_POSXY: 'מקור המיקום האופקי',
    EK3_SRC1_VELXY: 'מקור המהירות האופקית',
    EK3_SRC1_POSZ: 'מקור הגובה',
    EK3_SRC1_VELZ: 'מקור המהירות האנכית',
    EK3_GPS_CHECK: 'בדיקת GPS לפני המראה',
    AHRS_GPS_USE: 'שימוש ב־GPS לניווט',
    AHRS_OPTIONS: 'אפשרויות נוספות של מסנן הניווט',

    PLND_ENABLED: 'הפעלת נחיתה מדויקת',
    PLND_TYPE: 'סוג חיישן הנחיתה המדויקת',
    PLND_BUS: 'אפיק החיישן',
    PLND_LAG: 'השהיית חיישן הנחיתה',
    PLND_XY_DIST_MAX: 'מרחק אופקי מרבי לפני הירידה',
    PLND_STRICT: 'רמת הדיוק הנדרשת בנחיתה המדויקת',
    PLND_EST_TYPE: 'סוג אומדן הנחיתה',
    PLND_OPTIONS: 'אפשרויות נוספות לנחיתה מדויקת',

    LAND_FLARE_ALT: 'גובה תחילת היישור לפני נגיעה',
    LAND_FLARE_SEC: 'זמן תחילת היישור לפני נגיעה',
    LAND_PITCH_DEG: 'זווית האף ביישור',
    LAND_ABORT_DEG: 'שיפוע לביטול הנחיתה',
    LAND_PF_ALT: 'גובה תחילת ההכנה ליישור',
    LAND_PF_ARSPD: 'מהירות האוויר בהכנה ליישור',
    LAND_TYPE: 'סוג הנחיתה האוטומטית',
    TECS_LAND_ARSPD: 'מהירות האוויר בגישת הנחיתה',
    TECS_LAND_SINK: 'קצב השקיעה בשלב הסופי',
    TECS_LAND_THR: 'מצערת בגישת הנחיתה',
    TECS_LAND_SPDWGT: 'משקל בקרת המהירות בנחיתה',
    TECS_LAND_TCONST: 'קבוע הזמן של בקר הנחיתה',

    TECS_CLMB_MAX: 'קצב טיפוס מרבי',
    TECS_SINK_MAX: 'קצב שקיעה מרבי',
    TECS_TIME_CONST: 'כמה מהר המטוס מתקן גובה ומהירות. ערך נמוך מגיב חד יותר, ערך גבוה חלק יותר.',
    TECS_THR_DAMP: 'ריסון המצערת',
    TECS_PTCH_DAMP: 'ריסון זווית האף',
    TECS_SPDWEIGHT: 'משקל בקרת המהירות',
    AIRSPEED_CRUISE: 'מהירות שיוט',
    AIRSPEED_MIN: 'מהירות אוויר מזערית',
    AIRSPEED_MAX: 'מהירות אוויר מרבית',
    ARSPD_USE: 'שימוש במד המהירות',
    ARSPD_TYPE: 'סוג מד המהירות',
    ARSPD_BUS: 'אפיק מד המהירות',
    ARSPD_RATIO: 'יחס כיול מד המהירות',

    NAVL1_PERIOD: 'זמן התגובה של ניווט L1',
    NAVL1_DAMPING: 'ריסון ניווט L1',
    NAVL1_XTRACK_I: 'תיקון סטייה מהקו',
    WP_RADIUS: 'רדיוס קבלת נקודת הדרך',
    WP_LOITER_RAD: 'רדיוס המעגל סביב נקודה',
    WP_MAX_RADIUS: 'רדיוס מרבי לנקודת דרך',

    FS_SHORT_ACTN: 'פעולה בהפסקת קשר קצרה',
    FS_LONG_ACTN: 'פעולה בהפסקת קשר ארוכה',
    FS_LONG_TIMEOUT: 'זמן עד הפסקת קשר ארוכה',
    FS_GCS_ENABL: 'הפעלת Failsafe מול תחנת הקרקע',
    THR_FAILSAFE: 'הפעלת Failsafe מצערת ושלט',
    THR_FS_VALUE: 'ערך מצערת שמפעיל Failsafe',
    BATT_FS_LOW_ACT: 'פעולה בסוללה נמוכה',
    BATT_FS_CRT_ACT: 'פעולה בסוללה קריטית',
    FS_EKF_THRESH: 'גבול Failsafe של מסנן הניווט',

    BATT_MONITOR: 'אופן מדידת הסוללה',
    BATT_CAPACITY: 'קיבולת הסוללה',
    BATT_LOW_VOLT: 'מתח סוללה נמוך',
    BATT_CRT_VOLT: 'מתח סוללה קריטי',
    BATT_LOW_MAH: 'קיבולת שנותרה נמוכה',
    BATT_CRT_MAH: 'קיבולת שנותרה קריטית',
    BATT_ARM_VOLT: 'מתח מזערי לחימוש',
    BATT_ARM_MAH: 'קיבולת מזערית לחימוש',

    RNGFND1_TYPE: 'סוג מד הטווח',
    RNGFND1_MIN: 'טווח מזערי',
    RNGFND1_MAX: 'טווח מרבי',
    RNGFND1_ORIENT: 'כיוון מד הטווח',
    RNGFND1_GNDCLR: 'גובה המד מעל הקרקע',
    RNGFND1_ADDR: 'כתובת המד באפיק',
    RNGFND1_SCALING: 'כיול מד הטווח',

    GPS_TYPE: 'סוג מקלט ה־GPS הראשון',
    GPS1_TYPE: 'סוג מקלט ה־GPS',
    GPS_AUTO_SWITCH: 'מעבר אוטומטי בין מקלטי GPS',
    GPS_NAVFILTER: 'סינון ניווט של ה־GPS',
    GPS_SBAS_MODE: 'מצב תיקון SBAS',
    GPS1_RATE_MS: 'קצב עדכון ה־GPS',

    ARMING_REQUIRE: 'חיוב חימוש לפני טיסה',
    ARMING_RUDDER: 'חימוש באמצעות הגה הכיוון',
    ARMING_OPTIONS: 'אפשרויות חימוש',
    ARMING_ACCTHRESH: 'סף שגיאת מד התאוצה',
    ARMING_MIS_ITEMS: 'פריטי משימה הנדרשים לחימוש',
    ARMING_SKIPCHK: 'בדיקות חימוש לדילוג',

    LOG_BITMASK: 'מה נרשם ללוג',
    LOG_DISARMED: 'רישום כשהמטוס לא חמוש',
    LOG_REPLAY: 'רישום לשחזור טיסה',
    LOG_FILE_DSRMROT: 'סגירת קובץ הלוג בניטרול',
    LOG_BACKEND_TYPE: 'איפה נשמר הלוג',
    LOG_FILE_RATEMAX: 'קצב רישום מרבי לקובץ',
  };

  for (let n = 1; n <= 8; n += 1) {
    const port = serialPortHe(n);
    he[`SERIAL${n}_PROTOCOL`] = `פרוטוקול ${port}`;
    he[`SERIAL${n}_BAUD`] = `מהירות התקשורת ביציאה הטורית ${n}`;
    he[`SERVO${n}_FUNCTION`] = `תפקיד יציאת סרוו ${n}`;
  }
  for (let n = 1; n <= 4; n += 1) {
    he[`RC${n}_MIN`] = `דופק מזערי של ערוץ שלט ${n}`;
    he[`RC${n}_MAX`] = `דופק מרבי של ערוץ שלט ${n}`;
    he[`RC${n}_TRIM`] = `נקודת האמצע של ערוץ שלט ${n}`;
    he[`RC${n}_REVERSED`] = `היפוך ערוץ שלט ${n}`;
  }
  for (const n of [1, 2]) {
    he[`SERVO${n}_MIN`] = `דופק מזערי ביציאת סרוו ${n}`;
    he[`SERVO${n}_MAX`] = `דופק מרבי ביציאת סרוו ${n}`;
    he[`SERVO${n}_TRIM`] = `דופק אמצע ביציאת סרוו ${n}`;
  }
  return Object.freeze(he);
}

export const FC_PARAM_DESCRIPTIONS = buildDescriptions();

export function fcParamHebrew(key) {
  return FC_PARAM_DESCRIPTIONS[String(key || '')] || '';
}

function rangeText(info) {
  const range = info?.range;
  if (!range || range.low == null || range.high == null) return '';
  const low = String(range.low).trim();
  const high = String(range.high).trim();
  if (!low || !high) return '';
  return `${low}–${high}`;
}

/** Hebrew from the table. Unit and range only when the metadata has them. */
export function fcParamPresentation(key) {
  const name = String(key || '');
  const info = getParamInfo(name);
  const units = info?.units != null && String(info.units).trim() ? String(info.units).trim() : '';
  return {
    he: fcParamHebrew(name),
    units,
    range: rangeText(info),
  };
}

export function fcPresentationsForKeys(keys) {
  const meta = {};
  for (const key of keys || []) meta[key] = fcParamPresentation(key);
  return meta;
}
