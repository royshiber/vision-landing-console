/**
 * ArduPlane `custom_mode` (HEARTBEAT) → mode name.
 * Source: ArduPilot `ArduPlane/mode.h` enum `Mode::Number` (master, 2026-09-25).
 * FBWA / FBWB are the console names for FLY_BY_WIRE_A / FLY_BY_WIRE_B.
 * Keep aligned with `ARDUPILOT_PLANE_MODES` in `public/app.js` and `AP_MODES` in `public/sim-lab.mjs`.
 * Mode 14 is AVOID_ADSB. It is not a landing mode.
 */

/** @type {Record<number, string>} */
export const ARDUPILOT_PLANE_MODES = Object.freeze({
  0: 'MANUAL',
  1: 'CIRCLE',
  2: 'STABILIZE',
  3: 'TRAINING',
  4: 'ACRO',
  5: 'FBWA',
  6: 'FBWB',
  7: 'CRUISE',
  8: 'AUTOTUNE',
  10: 'AUTO',
  11: 'RTL',
  12: 'LOITER',
  13: 'TAKEOFF',
  14: 'AVOID_ADSB',
  15: 'GUIDED',
  16: 'INITIALISING',
  17: 'QSTABILIZE',
  18: 'QHOVER',
  19: 'QLOITER',
  20: 'QLAND',
  21: 'QRTL',
  22: 'QAUTOTUNE',
  23: 'QACRO',
  24: 'THERMAL',
  25: 'LOITER_ALT_QLAND',
  26: 'AUTOLAND',
});

/** Quadplane-only numbers from `mode.h` (`HAL_QUADPLANE_ENABLED` / `QAUTOTUNE_ENABLED`). */
export const ARDUPLANE_QUADPLANE_MODES = Object.freeze(new Set([17, 18, 19, 20, 21, 22, 23, 25]));

/**
 * @param {number} customMode
 * @returns {string|null}
 */
export function arduPlaneModeName(customMode) {
  const n = Number(customMode);
  if (!Number.isInteger(n)) return null;
  return ARDUPILOT_PLANE_MODES[n] ?? null;
}

/**
 * @param {number} customMode
 * @returns {{ name: string, quadplaneOnly: boolean }|null}
 */
export function arduPlaneModeInfo(customMode) {
  const name = arduPlaneModeName(customMode);
  if (!name) return null;
  return {
    name,
    quadplaneOnly: ARDUPLANE_QUADPLANE_MODES.has(Number(customMode)),
  };
}

/**
 * Hebrew UI line for replay timeline — human mode + numeric fallback.
 * Unknown numbers stay numeric. No guessed name.
 * @param {number} customMode
 */
export function replayFlightModeLabel(customMode) {
  const n = Number(customMode);
  if (!Number.isFinite(n)) return 'מצב טיסה: —';
  const name = arduPlaneModeName(n);
  if (name) return `מצב טיסה: ${name} (#${n})`;
  return `מצב טיסה: #${n} (לא מוכר)`;
}
