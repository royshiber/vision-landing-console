/**
 * ArduPlane parameter groups for the parameters tab.
 * Names exist in data/arduplane-params.json. Values are never stored here.
 */

export const FC_PARAM_GROUPS = Object.freeze([
  {
    id: 'ekf',
    labelHe: 'EKF / AHRS',
    keys: ['EK3_ENABLE', 'AHRS_EKF_TYPE', 'EK3_SRC1_POSXY', 'EK3_SRC1_VELXY', 'EK3_SRC1_POSZ', 'EK3_SRC1_VELZ', 'EK3_GPS_CHECK', 'AHRS_GPS_USE', 'AHRS_OPTIONS'],
  },
  {
    id: 'plnd',
    labelHe: 'נחיתה מדויקת',
    keys: ['PLND_ENABLED', 'PLND_TYPE', 'PLND_BUS', 'PLND_LAG', 'PLND_XY_DIST_MAX', 'PLND_STRICT', 'PLND_EST_TYPE', 'PLND_OPTIONS'],
  },
  {
    id: 'land',
    labelHe: 'נחיתה',
    keys: ['LAND_FLARE_ALT', 'LAND_FLARE_SEC', 'LAND_PITCH_DEG', 'LAND_ABORT_DEG', 'LAND_PF_ALT', 'LAND_PF_ARSPD', 'LAND_TYPE', 'TECS_LAND_ARSPD', 'TECS_LAND_SINK', 'TECS_LAND_THR', 'TECS_LAND_SPDWGT', 'TECS_LAND_TCONST'],
  },
  {
    id: 'tecs',
    labelHe: 'TECS / מהירות',
    keys: ['TECS_CLMB_MAX', 'TECS_SINK_MAX', 'TECS_TIME_CONST', 'TECS_THR_DAMP', 'TECS_PTCH_DAMP', 'TECS_SPDWEIGHT', 'AIRSPEED_CRUISE', 'AIRSPEED_MIN', 'AIRSPEED_MAX', 'ARSPD_USE', 'ARSPD_TYPE', 'ARSPD_BUS', 'ARSPD_RATIO'],
  },
  {
    id: 'nav',
    labelHe: 'ניווט L1',
    keys: ['NAVL1_PERIOD', 'NAVL1_DAMPING', 'NAVL1_XTRACK_I', 'WP_RADIUS', 'WP_LOITER_RAD', 'WP_MAX_RADIUS'],
  },
  {
    id: 'failsafe',
    labelHe: 'Failsafe',
    keys: ['FS_SHORT_ACTN', 'FS_LONG_ACTN', 'FS_LONG_TIMEOUT', 'FS_GCS_ENABL', 'THR_FAILSAFE', 'THR_FS_VALUE', 'BATT_FS_LOW_ACT', 'BATT_FS_CRT_ACT', 'FS_EKF_THRESH'],
  },
  {
    id: 'serial',
    labelHe: 'טורי / טלמטריה',
    keys: [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [`SERIAL${n}_PROTOCOL`, `SERIAL${n}_BAUD`]),
  },
  {
    id: 'battery',
    labelHe: 'סוללה',
    keys: ['BATT_MONITOR', 'BATT_CAPACITY', 'BATT_LOW_VOLT', 'BATT_CRT_VOLT', 'BATT_LOW_MAH', 'BATT_CRT_MAH', 'BATT_FS_LOW_ACT', 'BATT_FS_CRT_ACT', 'BATT_ARM_VOLT', 'BATT_ARM_MAH'],
  },
  {
    id: 'rc',
    labelHe: 'שלט ויציאות סרוו',
    keys: [
      ...[1, 2, 3, 4].flatMap((n) => [`RC${n}_MIN`, `RC${n}_MAX`, `RC${n}_TRIM`, `RC${n}_REVERSED`]),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `SERVO${n}_FUNCTION`),
      'SERVO1_MIN', 'SERVO1_MAX', 'SERVO1_TRIM', 'SERVO2_MIN', 'SERVO2_MAX', 'SERVO2_TRIM',
    ],
  },
  {
    id: 'rangefinder',
    labelHe: 'מד טווח',
    keys: ['RNGFND1_TYPE', 'RNGFND1_MIN', 'RNGFND1_MAX', 'RNGFND1_ORIENT', 'RNGFND1_GNDCLR', 'RNGFND1_ADDR', 'RNGFND1_SCALING'],
  },
  {
    id: 'gps',
    labelHe: 'GPS',
    keys: ['GPS_TYPE', 'GPS1_TYPE', 'GPS_AUTO_SWITCH', 'GPS_NAVFILTER', 'GPS_SBAS_MODE', 'GPS1_RATE_MS'],
  },
  {
    id: 'arming',
    labelHe: 'חימוש',
    keys: ['ARMING_REQUIRE', 'ARMING_RUDDER', 'ARMING_OPTIONS', 'ARMING_ACCTHRESH', 'ARMING_MIS_ITEMS', 'ARMING_SKIPCHK'],
  },
  {
    id: 'logs',
    labelHe: 'לוגים',
    keys: ['LOG_BITMASK', 'LOG_DISARMED', 'LOG_REPLAY', 'LOG_FILE_DSRMROT', 'LOG_BACKEND_TYPE', 'LOG_FILE_RATEMAX'],
  },
  {
    id: 'all',
    labelHe: 'כל הפרמטרים',
    keys: [],
  },
]);

const CATALOG_KEYS = new Set(FC_PARAM_GROUPS.flatMap((group) => group.keys));

export function listFcParamGroups() {
  return FC_PARAM_GROUPS.map((group) => ({
    id: group.id,
    labelHe: group.labelHe,
    keys: group.keys.slice(),
  }));
}

export function fcParamGroup(id) {
  return listFcParamGroups().find((group) => group.id === id) || null;
}

/**
 * Current FC value for display. Never invents a number.
 * @returns {{ state: 'unknown'|'missing'|'present', text: string }}
 */
export function fcParamPresence(snapshot, key) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { state: 'unknown', text: 'לא ידוע' };
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
    return { state: 'missing', text: 'חסר' };
  }
  const value = snapshot[key];
  if (value == null || value === '') return { state: 'unknown', text: 'לא ידוע' };
  return { state: 'present', text: String(value) };
}

/**
 * Accept a catalog param on the existing write validator.
 * Returns null when the key is not in a group (caller keeps its own rules).
 */
export function coerceGroupWriteValue(key, rawValue) {
  const name = String(key || '');
  if (!CATALOG_KEYS.has(name)) return null;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not_numeric' };
  return { ok: true, value: n };
}
