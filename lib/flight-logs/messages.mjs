/** Hebrew operator strings. Secrets never appear in these. */

export const NOT_CONFIGURED_HE =
  'אחסון הטיסות בענן לא הוגדר. הוסיפו מפתח קריאה.';

const GAP_LABELS = [
  ['endpoint', 'כתובת האחסון'],
  ['region', 'האזור'],
  ['bucket', 'שם המאגר'],
  ['keyId', 'מפתח הקריאה'],
  ['secret', 'הסוד של מפתח הקריאה'],
];

/** Plain Hebrew for a missing cloud setting. No file names and no doc paths. */
export function cloudGapHe(parts = {}) {
  if (parts.explicitOff && parts.cloudReady) return 'אחסון הטיסות כבוי.';
  const missing = GAP_LABELS.filter(([key]) => !String(parts[key] || '').trim()).map(([, label]) => label);
  if (missing.length === 0 || missing.length === GAP_LABELS.length) return NOT_CONFIGURED_HE;
  return `אחסון הטיסות בענן לא מוכן. חסר: ${missing.join(', ')}.`;
}

export const NO_FLIGHTS_HE =
  'עדיין אין טיסות. אחרי טיסה מחשב המשימה יעלה אותה אוטומטית.';

export const MAP_UNAVAILABLE_HE = 'המפה לא זמינה';

export const NO_SERIES_HE = 'אין נתונים';

const REASONS = {
  fc_off: 'לוג הבקר עוד לא הורד: הבקר כבוי',
  no_usb: 'לוג הבקר לא זמין: אין חיבור USB',
  log_not_found: 'לוג הבקר לא נמצא',
  aborted_armed: 'הורדת הלוג הופסקה כי הבקר חמוש',
  awaiting_disarm_settle: 'ממתין שהבקר יישאר כבוי-מנוע',
  no_journal_permission: 'יומן המערכת לא זמין: אין הרשאת journal',
  cellular_policy: 'הקובץ לא הועלה: מדיניות רשת סלולרית',
  quota: 'הקובץ לא הועלה: המכסה מלאה',
  corrupt: 'הקובץ פגום ולא מוצג כתקין',
};

export function reasonHe(reason) {
  if (!reason) return '';
  return REASONS[reason] || `לא זמין: ${reason}`;
}

export function uploadLabelHe(row) {
  const state = String(row?.state || '');
  if (state === 'corrupt' || Number(row?.corrupt) > 0) return 'פגום';
  if (state === 'complete') return '✓ הושלם';
  if (state === 'awaiting_fc_log' || state === 'pending') return 'ממתין ללוג בקר';
  if (state === 'partial') return 'חלקי';
  if (state === 'uploading' || state === 'processing' || state === 'in_flight') return 'בהעלאה';
  return state || '—';
}

export function timeSourceLabelHe(src) {
  if (src === 'ntp') return 'שעון מסונכרן';
  if (src === 'fc_system_time') return 'שעון הבקר';
  if (src === 'jetson_unsynced') return 'שעון לא מסונכרן';
  return src || 'מקור זמן לא ידוע';
}

export function endReasonHe(reason) {
  const map = {
    disarmed: 'כיבוי מנוע',
    fc_link_lost: 'אובדן קישור לבקר',
    companion_restart: 'אתחול מחשב המשימה',
  };
  return map[reason] || reason || '—';
}

export function syncErrorHe(lastSyncAt, detail) {
  const when = lastSyncAt ? ` הצלחה אחרונה: ${lastSyncAt}.` : ' עדיין אין סנכרון מוצלח.';
  const tail = detail ? ` (${detail})` : '';
  return `סנכרון הטיסות נכשל.${when}${tail}`;
}
