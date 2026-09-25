/**
 * ArduCopter `custom_mode` (HEARTBEAT) → mode name.
 * Source: ArduPilot `ArduCopter/mode.h` enum `Mode::Number` (master, 2026-09-25).
 * Keep aligned with `ARDUPILOT_COPTER_MODES` in `public/app.js`.
 * Mode 9 is LAND. Mode 14 is FLIP, not AVOID_ADSB (that number is 19 on Copter).
 */

/** @type {Record<number, string>} */
export const ARDUPILOT_COPTER_MODES = Object.freeze({
  0: 'STABILIZE',
  1: 'ACRO',
  2: 'ALT_HOLD',
  3: 'AUTO',
  4: 'GUIDED',
  5: 'LOITER',
  6: 'RTL',
  7: 'CIRCLE',
  9: 'LAND',
  11: 'DRIFT',
  13: 'SPORT',
  14: 'FLIP',
  15: 'AUTOTUNE',
  16: 'POSHOLD',
  17: 'BRAKE',
  18: 'THROW',
  19: 'AVOID_ADSB',
  20: 'GUIDED_NOGPS',
  21: 'SMART_RTL',
  22: 'FLOWHOLD',
  23: 'FOLLOW',
  24: 'ZIGZAG',
  25: 'SYSTEMID',
  26: 'AUTOROTATE',
  27: 'AUTO_RTL',
  28: 'TURTLE',
});

/**
 * @param {number} customMode
 * @returns {string|null}
 */
export function arduCopterModeName(customMode) {
  const n = Number(customMode);
  if (!Number.isInteger(n)) return null;
  return ARDUPILOT_COPTER_MODES[n] ?? null;
}
