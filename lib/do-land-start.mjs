/**
 * Fixed-wing voice "land" is MAV_CMD_DO_LAND_START (189), not an ArduPlane mode.
 * A NAV_LAND waypoint without this marker does not count: ArduPlane jumps to the marker.
 */

export const MAV_CMD_DO_LAND_START = 189;
export const MAV_CMD_NAV_LAND = 21;
export const MAV_RESULT_ACCEPTED = 0;

/**
 * @param {Array<{ command?: number }>|null|undefined} items
 */
export function missionHasDoLandStart(items) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => Number(item?.command) === MAV_CMD_DO_LAND_START);
}

/**
 * @param {Array<{ command?: number }>|null|undefined} items
 */
export function missionHasNavLand(items) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => Number(item?.command) === MAV_CMD_NAV_LAND);
}
