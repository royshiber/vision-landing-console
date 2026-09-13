/**
 * Spoken / Ask unit preference. Internal telemetry stays SI (m, m/s).
 * Conversion is display-and-speech only. Does not invent numbers.
 */

export const SPOKEN_UNIT_IDS = Object.freeze({
  altitude: Object.freeze(['m', 'ft']),
  speed: Object.freeze(['ms', 'kmh', 'kn']),
  distance: Object.freeze(['m', 'km', 'ft']),
  verticalRate: Object.freeze(['ms', 'ftmin']),
  angle: Object.freeze(['deg']),
});

export const DEFAULT_SPOKEN_UNITS = Object.freeze({
  altitude: 'm',
  speed: 'ms',
  distance: 'm',
  verticalRate: 'ms',
  angle: 'deg',
});

export const SPOKEN_UNIT_OPTIONS = Object.freeze({
  altitude: Object.freeze([
    { id: 'm', label_he: 'מטרים', spoken_he: 'מטר', symbol: 'm' },
    { id: 'ft', label_he: 'רגל', spoken_he: 'רגל', symbol: 'ft' },
  ]),
  speed: Object.freeze([
    { id: 'ms', label_he: 'מטר לשנייה', spoken_he: 'מטר לשנייה', symbol: 'm/s' },
    { id: 'kmh', label_he: 'קילומטר לשעה', spoken_he: 'קילומטר לשעה', symbol: 'km/h' },
    { id: 'kn', label_he: 'קשר', spoken_he: 'קשר', symbol: 'kn' },
  ]),
  distance: Object.freeze([
    { id: 'm', label_he: 'מטרים', spoken_he: 'מטר', symbol: 'm' },
    { id: 'km', label_he: 'קילומטר', spoken_he: 'קילומטר', symbol: 'km' },
    { id: 'ft', label_he: 'רגל', spoken_he: 'רגל', symbol: 'ft' },
  ]),
  verticalRate: Object.freeze([
    { id: 'ms', label_he: 'מטר לשנייה', spoken_he: 'מטר לשנייה', symbol: 'm/s' },
    { id: 'ftmin', label_he: 'רגל לדקה', spoken_he: 'רגל לדקה', symbol: 'ft/min' },
  ]),
  angle: Object.freeze([
    { id: 'deg', label_he: 'מעלות', spoken_he: 'מעלות', symbol: '°' },
  ]),
});

const M_TO_FT = 3.280839895;
const MS_TO_KMH = 3.6;
const MS_TO_KN = 1.943844492;
const MS_TO_FTMIN = 196.8503937;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeSpokenUnits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (kind, fallback) => {
    const allowed = SPOKEN_UNIT_IDS[kind];
    const v = String(src[kind] || '').trim();
    return allowed.includes(v) ? v : fallback;
  };
  return {
    altitude: pick('altitude', DEFAULT_SPOKEN_UNITS.altitude),
    speed: pick('speed', DEFAULT_SPOKEN_UNITS.speed),
    distance: pick('distance', DEFAULT_SPOKEN_UNITS.distance),
    verticalRate: pick('verticalRate', DEFAULT_SPOKEN_UNITS.verticalRate),
    angle: 'deg',
  };
}

export function convertSpokenMeasure(kind, siValue, units) {
  if (!finiteNumber(siValue)) return null;
  const prefs = normalizeSpokenUnits(units);
  if (kind === 'altitude') {
    const id = prefs.altitude;
    return {
      kind,
      unitId: id,
      value: id === 'ft' ? siValue * M_TO_FT : siValue,
      ...unitMeta('altitude', id),
    };
  }
  if (kind === 'speed') {
    const id = prefs.speed;
    let value = siValue;
    if (id === 'kmh') value = siValue * MS_TO_KMH;
    else if (id === 'kn') value = siValue * MS_TO_KN;
    return { kind, unitId: id, value, ...unitMeta('speed', id) };
  }
  if (kind === 'distance') {
    const id = prefs.distance;
    let value = siValue;
    if (id === 'km') value = siValue / 1000;
    else if (id === 'ft') value = siValue * M_TO_FT;
    return { kind, unitId: id, value, ...unitMeta('distance', id) };
  }
  if (kind === 'verticalRate') {
    const id = prefs.verticalRate;
    return {
      kind,
      unitId: id,
      value: id === 'ftmin' ? siValue * MS_TO_FTMIN : siValue,
      ...unitMeta('verticalRate', id),
    };
  }
  if (kind === 'angle') {
    return { kind, unitId: 'deg', value: siValue, ...unitMeta('angle', 'deg') };
  }
  return null;
}

function unitMeta(kind, id) {
  const row = (SPOKEN_UNIT_OPTIONS[kind] || []).find((o) => o.id === id);
  return {
    label_he: row?.label_he || id,
    spoken_he: row?.spoken_he || id,
    symbol: row?.symbol || id,
  };
}

export function formatSpokenNumber(value) {
  if (!finiteNumber(value)) return '--';
  const a = Math.abs(value);
  if (Number.isInteger(value) || a >= 100) return String(Math.round(value));
  if (a >= 10) return value.toFixed(1);
  return value.toFixed(a >= 1 ? 1 : 2);
}

/** One spoken/display line: "120 מטר". Never invents a number. */
export function formatSpokenMeasure(kind, siValue, units) {
  if (!finiteNumber(siValue)) return '--';
  const conv = convertSpokenMeasure(kind, siValue, units);
  if (!conv) return '--';
  return `${formatSpokenNumber(conv.value)} ${conv.spoken_he}`;
}
