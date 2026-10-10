/**
 * GPS hover text and map-position gate.
 * Missing fields stay absent. A known fix below 3D does not move the drawn aircraft.
 */

const GPS_FIX_LABELS = ['אין GPS', 'אין Fix', '2D Fix', '3D Fix', 'DGPS', 'RTK Float', 'RTK קבוע'];

function knownFix(fixType) {
  if (fixType == null || fixType === '') return null;
  const n = Number(fixType);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function gpsFixLabel(fixType) {
  const n = knownFix(fixType);
  if (n == null) return null;
  return GPS_FIX_LABELS[n] || `Fix ${n}`;
}

export function gpsFixChip(fixType) {
  const n = knownFix(fixType);
  if (n == null) return null;
  if (n >= 5) return 'RTK';
  if (n === 4) return 'DGPS';
  if (n === 3) return '3D';
  if (n === 2) return '2D';
  return 'אין';
}

export function formatReadingAgeHe(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const sec = Math.round(ageMs / 1000);
  if (sec <= 0) return 'עכשיו';
  return `לפני ${sec} שנ׳`;
}

export function formatHdop(hdop) {
  if (hdop == null || hdop === '') return null;
  const n = Number(hdop);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

function finiteReading(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sampleLines(title, sample, ageMs) {
  if (!sample || typeof sample !== 'object') return [];
  const satsN = finiteReading(sample.sats);
  const sats = satsN == null ? null : String(Math.round(satsN));
  const fix = gpsFixLabel(sample.fixType);
  const hdop = formatHdop(finiteReading(sample.hdop));
  const age = formatReadingAgeHe(ageMs);
  const body = [];
  if (sats != null) body.push(`לוויינים ${sats}`);
  if (fix) body.push(fix);
  if (hdop != null) body.push(`HDOP ${hdop}`);
  if (age) body.push(age);
  if (!body.length) return [];
  return [title, ...body];
}

export function formatGpsHoverTooltip({
  fixType = null,
  sats = null,
  hdop = null,
  ageMs = null,
  gps2 = null,
} = {}) {
  const primary = sampleLines('GPS', { fixType, sats, hdop }, ageMs);
  const second = gps2 && typeof gps2 === 'object'
    ? sampleLines('GPS2', gps2, gps2.ageMs)
    : [];
  return [...primary, ...second].join('\n');
}

/**
 * Drawn aircraft position.
 * fix < 3 keeps the last accepted point and does not extend the track.
 * A missing fix still draws the coordinates that arrived.
 */
export function nextMapAircraftFix({ lat, lon, fixType, held, source } = {}) {
  const latN = Number(lat);
  const lonN = Number(lon);
  const coordsOk = Number.isFinite(latN) && Number.isFinite(lonN);
  const fixN = knownFix(fixType);
  const weak = fixN != null && fixN < 3;
  const replay = source === 'SIMLAB_REPLAY';
  if (weak && !replay) {
    const holdLat = Number(held?.lat);
    const holdLon = Number(held?.lon);
    if (Number.isFinite(holdLat) && Number.isFinite(holdLon)) {
      return {
        lat: holdLat,
        lon: holdLon,
        draw: true,
        track: false,
        held: true,
        acceptHold: false,
      };
    }
    return { lat: null, lon: null, draw: false, track: false, held: false, acceptHold: false };
  }
  if (!coordsOk) {
    return { lat: null, lon: null, draw: false, track: false, held: false, acceptHold: false };
  }
  return { lat: latN, lon: lonN, draw: true, track: true, held: false, acceptHold: true };
}

/** Missing storage follows. Only an explicit off stays off. */
export function flightFollowEnabled(stored) {
  return stored !== '0' && stored !== false;
}

if (typeof window !== 'undefined') {
  window.__vlcGpsQuality = {
    gpsFixLabel,
    gpsFixChip,
    formatReadingAgeHe,
    formatHdop,
    formatGpsHoverTooltip,
    nextMapAircraftFix,
    flightFollowEnabled,
  };
}
