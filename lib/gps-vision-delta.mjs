/**
 * Display-only GPS vs Vision horizontal distance.
 * Missing or non-finite coordinates yield null — never a coerced 0.
 */

const EARTH_RADIUS_M = 6_371_000;

function finiteCoord(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine distance in meters, or null when any WGS84 coordinate is missing.
 * @param {unknown} gpsLat
 * @param {unknown} gpsLon
 * @param {unknown} visionLat
 * @param {unknown} visionLon
 * @returns {number | null}
 */
export function gpsVisionDeltaMeters(gpsLat, gpsLon, visionLat, visionLon) {
  const lat1 = finiteCoord(gpsLat);
  const lon1 = finiteCoord(gpsLon);
  const lat2 = finiteCoord(visionLat);
  const lon2 = finiteCoord(visionLon);
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Topbar label for `#liveGpsVisionDelta`. Placeholder stays `-- m` when there is no number.
 * @param {unknown} meters
 * @returns {string}
 */
export function formatGpsVisionDeltaMeters(meters) {
  if (!Number.isFinite(meters)) return '-- m';
  return `${meters.toFixed(1)} m`;
}
