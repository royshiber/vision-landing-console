/**
 * Which custom_mode table a heartbeat belongs to.
 * Unknown / fixed-wing / generic stays on the ArduPlane table: this console is a
 * fixed-wing landing station, and mode 14 there is AVOID_ADSB (never labeled LAND).
 * Copter types use the ArduCopter table.
 *
 * MAV_TYPE: 2 quadrotor, 3 coaxial, 4 helicopter, 13 hexarotor, 14 octorotor, 15 tricopter.
 */

import { ARDUPILOT_COPTER_MODES } from './arducopter-flight-modes.mjs';
import { ARDUPILOT_PLANE_MODES } from './arduplane-flight-modes.mjs';

export const COPTER_MAV_TYPES = Object.freeze(new Set([2, 3, 4, 13, 14, 15]));

const COPTER_TYPE_NAMES = new Set([
  'Quadrotor',
  'Hexarotor',
  'Octorotor',
  'Tricopter',
  'Helicopter',
  'Coaxial',
]);

/**
 * @param {{ mavType?: number, vehicleType?: string }|null|undefined} source
 * @returns {'plane'|'copter'}
 */
export function vehicleModeFamily(source) {
  const mavType = Number(source?.mavType);
  if (COPTER_MAV_TYPES.has(mavType)) return 'copter';
  const name = String(source?.vehicleType || '');
  if (COPTER_TYPE_NAMES.has(name)) return 'copter';
  if (/^type(2|3|4|13|14|15)$/.test(name)) return 'copter';
  return 'plane';
}

/**
 * @param {'plane'|'copter'} family
 * @returns {Record<number, string>}
 */
export function modeTableForFamily(family) {
  return family === 'copter' ? ARDUPILOT_COPTER_MODES : ARDUPILOT_PLANE_MODES;
}

/**
 * @param {'plane'|'copter'} family
 * @param {number} customMode
 * @returns {string|null}
 */
export function modeNameForFamily(family, customMode) {
  const n = Number(customMode);
  if (!Number.isInteger(n)) return null;
  return modeTableForFamily(family)[n] ?? null;
}
