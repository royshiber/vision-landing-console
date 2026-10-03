/**
 * First-real-flight checklist.
 * Auto rows tick only from live telemetry already on the connection.
 * Manual rows are operator ticks and never write to the FC.
 * Missing telemetry stays open. Nothing here is invented.
 */

export const MAV_SYS_STATUS_SENSOR_3D_ACCEL = 2;
export const MAV_SYS_STATUS_SENSOR_3D_MAG = 4;

export const PREFLIGHT_READINESS_TITLE_HE = 'מוכנות לטיסה ראשונה';

const STALE_MS = 5000;

function bitOn(value, bit) {
  return (Number(value) & bit) !== 0;
}

/** true / false when the bitmap is present, null when there is no sample. */
export function sensorBitReady(sensors, bit) {
  if (!sensors || typeof sensors !== 'object') return null;
  const present = Number(sensors.present);
  const enabled = Number(sensors.enabled);
  const health = Number(sensors.health);
  if (![present, enabled, health].every((n) => Number.isFinite(n))) return null;
  if (!bitOn(present, bit)) return false;
  return bitOn(enabled, bit) && bitOn(health, bit);
}

function autoItem(id, labelHe, proven, detailHe) {
  const ok = proven === true;
  return {
    id,
    labelHe,
    source: 'auto',
    state: ok ? 'ok' : 'open',
    ticked: ok,
    detailHe: ok ? '' : (detailHe || 'אין הוכחה בטלמטריה החיה.'),
  };
}

function manualItem(id, labelHe, detailHe) {
  return {
    id,
    labelHe,
    source: 'manual',
    state: 'manual',
    ticked: false,
    detailHe,
  };
}

/**
 * @param {{
 *   sensors?: { present: number, enabled: number, health: number }|null,
 *   gpsFixType?: number|null,
 *   batteryV?: number|null,
 *   radioConnected?: boolean,
 *   radioSimulator?: boolean,
 *   cellularConnected?: boolean,
 *   cam0?: boolean|null,
 *   cam1?: boolean|null,
 *   recording?: boolean,
 *   jetsonReachable?: boolean,
 * }} [input]
 */
export function buildPreflightReadiness(input = {}) {
  const accel = sensorBitReady(input.sensors, MAV_SYS_STATUS_SENSOR_3D_ACCEL);
  const mag = sensorBitReady(input.sensors, MAV_SYS_STATUS_SENSOR_3D_MAG);
  const gps = Number.isFinite(input.gpsFixType) ? input.gpsFixType >= 3 : null;
  const battery = Number.isFinite(input.batteryV) ? input.batteryV > 0 : null;
  const radioReal = input.radioConnected === true && input.radioSimulator !== true;
  const items = [
    autoItem('accel', 'כיול מד תאוצה', accel === true, accel === false ? 'מד התאוצה ב-FC לא מסומן כמכויל.' : 'אין דגלי כיול מד תאוצה מה-FC.'),
    autoItem('compass', 'מצפן', mag === true, mag === false ? 'המצפן ב-FC לא מסומן כתקין.' : 'אין דגל מצפן מה-FC.'),
    autoItem('gps', 'GPS', gps === true, 'אין תיקון GPS.'),
    autoItem('battery', 'מתח סוללה', battery === true, 'אין מתח סוללה בטלמטריה.'),
    autoItem(
      'rf_link',
      'קישור RF',
      radioReal,
      input.radioSimulator === true ? 'סימולטור אינו רדיו אמיתי.' : 'אין קישור RF על רדיו אמיתי.',
    ),
    autoItem('cellular', 'גיבוי סלולר', input.cellularConnected === true, 'גיבוי הסלולר לא מחובר.'),
    autoItem('cam0', 'קדמית משדרת', input.cam0 === true, 'קדמית לא מדווחת זרם חי.'),
    autoItem('cam1', 'מטה משדרת', input.cam1 === true, 'מטה לא מדווחת זרם חי.'),
    autoItem('logs', 'לוגים', input.recording === true, 'ההקלטה לא רצה.'),
    autoItem('jetson', 'מחשב משימה (Jetson)', input.jetsonReachable === true, 'מחשב משימה (Jetson) לא מחובר.'),
    manualItem('rc_cal', 'כיול שלט RC', 'אין אות שמעיד שכיול השלט הושלם. סמנו אחרי הבדיקה.'),
    manualItem('fs_rc', 'כשל אובדן שלט RC', 'הכשל לא נקרא מה-FC. סמנו אחרי שבדקתם.'),
    manualItem('fs_rf', 'כשל אובדן RF', 'הכשל לא נקרא מה-FC. סמנו אחרי שבדקתם.'),
    manualItem('fs_battery', 'כשל סוללה', 'סף הסוללה לא נקרא מה-FC. סמנו אחרי שבדקתם.'),
    manualItem('geofence', 'גדר גאוגרפית', 'הגדר לא נקראת מכאן. סמנו אחרי שבדקתם.'),
    manualItem('rtl_alt', 'גובה RTL', 'גובה החזרה לא נקרא מכאן. סמנו אחרי שבדקתם.'),
    manualItem('rf_verified', 'RF אומת ברדיו אמיתי', 'קישור לסימולטור לא נספר. סמנו רק אחרי בדיקה על רדיו אמיתי.'),
  ];
  const open = items.filter((item) => item.state !== 'ok');
  return {
    ok: true,
    titleHe: PREFLIGHT_READINESS_TITLE_HE,
    noteHe: 'סימון אוטומטי רק מטלמטריה חיה. סימון ידני נשאר במחשב הזה ולא נכתב ל-FC.',
    items,
    openIds: open.map((item) => item.id),
    openCount: open.length,
    staleMs: STALE_MS,
  };
}

export function preflightSampleFresh(sample, now = Date.now()) {
  if (!sample || typeof sample !== 'object') return null;
  const wall = sample.receivedWallMs;
  if (typeof wall === 'number' && Number.isFinite(wall) && now - wall > STALE_MS) return null;
  return sample;
}
