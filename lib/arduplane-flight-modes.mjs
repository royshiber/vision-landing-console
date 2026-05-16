/**
 * ArduPlane `custom_mode` (HEARTBEAT) → mode name.
 * Keep aligned with `ARDUPILOT_PLANE_MODES` in `public/app.js` (classic script — no shared import there).
 */

/** @type {Record<number, string>} */
export const ARDUPILOT_PLANE_MODES = {
  0:  'MANUAL',
  1:  'CIRCLE',
  2:  'STABILIZE',
  3:  'TRAINING',
  4:  'ACRO',
  5:  'FBWA',
  6:  'FBWB',
  7:  'CRUISE',
  8:  'AUTOTUNE',
  10: 'AUTO',
  11: 'RTL',
  12: 'LOITER',
  14: 'LAND',
  15: 'GUIDED',
  17: 'QSTABILIZE',
  18: 'QHOVER',
  19: 'QLOITER',
  20: 'QLAND',
  21: 'QRTL',
  22: 'THERMAL',
  25: 'TAKEOFF',
};

/**
 * @param {number} customMode
 * @returns {string|null}
 */
export function arduPlaneModeName(customMode) {
  const n = Number(customMode);
  if (!Number.isFinite(n)) return null;
  return ARDUPILOT_PLANE_MODES[n] ?? null;
}

/**
 * Hebrew UI line for replay timeline — human mode + numeric fallback.
 * @param {number} customMode
 */
export function replayFlightModeLabel(customMode) {
  const n = Number(customMode);
  if (!Number.isFinite(n)) return 'מצב טיסה: —';
  const name = arduPlaneModeName(n);
  if (name) return `מצב טיסה: ${name} (#${n})`;
  return `מצב טיסה: מקושחה #${n} (לא מוכר)`;
}
