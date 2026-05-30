/**
 * Flight HUD — resolve free-text to a telemetry catalog key (ranked + ambiguous).
 */

export const FLIGHT_HUD_CATALOG = [
  { key: 'mavlink.airspeed',      label: 'מהירות אוויר',       unit: 'm/s' },
  { key: 'mavlink.groundspeed',   label: 'מהירות קרקעית',      unit: 'm/s' },
  { key: 'mavlink.climbRate',     label: 'מהירות אנכית',       unit: 'm/s' },
  { key: 'mavlink.altitude',      label: 'גובה',               unit: 'm' },
  { key: 'mavlink.heading',       label: 'כיוון אף',           unit: '°' },
  { key: 'mavlink.flightMode',    label: 'מוד טיסה',           unit: '' },
  { key: 'mavlink.armed',         label: 'מצב ARM',            unit: '' },
  { key: 'mavlink.batteryV',      label: 'מתח סוללה',          unit: 'V' },
  { key: 'mavlink.batteryPct',    label: 'טעינת סוללה',        unit: '%' },
  { key: 'mavlink.rollDeg',       label: 'רול',                unit: '°' },
  { key: 'mavlink.pitchDeg',      label: 'פיץ׳',              unit: '°' },
  { key: 'mavlink.gpsFixType',    label: 'Fix GPS',            unit: '' },
  { key: 'mavlink.gpsSats',       label: 'לוויינים GPS',       unit: '' },
  { key: 'vision.confidence',     label: 'ביטחון Vision',      unit: '%' },
  { key: 'vision.headingErrorDeg',label: 'שגיאת כיוון Vision', unit: '°' },
  { key: 'slam.posX',             label: 'SLAM X',             unit: 'm' },
  { key: 'slam.posY',             label: 'SLAM Y',             unit: 'm' },
  { key: 'slam.posZ',             label: 'SLAM Z',             unit: 'm' },
  { key: 'slam.yawDeg',           label: 'SLAM יאו',           unit: '°' },
  { key: 'slam.mapQuality',       label: 'איכות מפת SLAM',     unit: '' },
  { key: 'jetson.cpuLoadPct',     label: 'עומס CPU Jetson',    unit: '%' },
  { key: 'jetson.tempC',          label: 'טמפ׳ Jetson',        unit: '°C' },
  { key: 'jetson.memPct',         label: 'זיכרון Jetson',      unit: '%' },
];

/** Extra tokens (normalized lowercase) that bump scores for specific keys. */
const SYNONYMS = {
  'mavlink.airspeed':       ['ias', 'indicated', 'airspd', 'אוויר', 'airspeed', 'מד אוויר', 'tas'],
  'mavlink.groundspeed':    ['gs', 'ground', 'groundspeed', 'קרקע', 'קרקעית', 'mgd'],
  'mavlink.climbRate':      ['vspd', 'vspeed', 'climbrate', 'climb', 'roc', 'rate of climb',
                             'אנכי', 'אנכית', 'עלייה', 'ירידה', 'climb rate', 'vertical speed',
                             'vertical', 'verticalspeed', 'vz', 'מהירות אנכית', 'עליה'],
  'mavlink.altitude':       ['alt', 'altitude', 'גבה', 'גובה', 'מ״מ', 'ממ״ג'],
  'mavlink.heading':        ['hdg', 'heading', 'כיוון', 'אזימוט'],
  'mavlink.flightMode':     ['mode', 'flight mode', 'מצב', 'מוד', 'fm'],
  'mavlink.armed':          ['arm', 'armed', 'disarm', 'זירוז', 'מזורז'],
  'mavlink.batteryV':       ['volt', 'voltage', 'מתח', 'וולט'],
  'mavlink.batteryPct':     ['percent', 'battery', 'טעינה', 'סוללה', 'אחוז'],
  'mavlink.rollDeg':        ['roll', 'גלגול', 'הטיה רוחב', 'bank'],
  'mavlink.pitchDeg':       ['pitch', 'דקירה', 'פיץ', 'nose'],
  'mavlink.gpsFixType':     ['gps fix', 'fix type', 'fixtype', 'gps type'],
  'mavlink.gpsSats':        ['sats', 'satellites', 'לוויינים', 'num sat', 'numsat'],
  'vision.confidence':      ['conf', 'confidence', 'ביטחון', 'ויזן'],
  'vision.headingErrorDeg': ['heading error', 'שגיאת כיוון'],
  'slam.posX':              ['slam x', 'pos x'],
  'slam.posY':              ['slam y', 'pos y'],
  'slam.posZ':              ['slam z', 'pos z'],
  'slam.yawDeg':            ['slam yaw'],
  'slam.mapQuality':        ['map quality', 'איכות', 'slam map'],
  'jetson.cpuLoadPct':      ['cpu', 'עומס', 'מעבד', 'load'],
  'jetson.tempC':           ['temp', 'temperature', 'חום', 'טמפ'],
  'jetson.memPct':          ['ram', 'mem', 'memory', 'זיכרון'],
};

function normalizeForMatch(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function labelWords(label) {
  return label
    .split(/[\s\u200f\u202a-\u202e]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 2);
}

/**
 * @param {string} text
 * @param {(typeof FLIGHT_HUD_CATALOG)[0]} entry
 * @returns {number}
 */
function scoreEntry(textNorm, entry) {
  const label = entry.label.toLowerCase();
  const keyPart = entry.key.split('.')[1].toLowerCase();

  if (textNorm.includes(label)) return 92;
  if (label.includes(textNorm) && textNorm.length >= 4) return 88;

  let score = 0;
  if (keyPart.length >= 2 && textNorm.includes(keyPart)) score += 22;

  for (const w of labelWords(entry.label)) {
    const wl = w.toLowerCase();
    if (wl.length >= 2 && textNorm.includes(wl)) score += 9;
  }

  const syns = SYNONYMS[entry.key];
  if (syns) {
    for (const s of syns) {
      const sl = s.toLowerCase();
      if (sl.length >= 2 && textNorm.includes(sl)) score += 14;
    }
  }

  return score;
}

/**
 * @param {string} text
 * @returns {{ entry: (typeof FLIGHT_HUD_CATALOG)[0], score: number }[]}
 */
export function rankHudParamMatches(text) {
  const textNorm = normalizeForMatch(text);
  if (!textNorm) return [];
  return FLIGHT_HUD_CATALOG.map((entry) => ({
    entry,
    score: scoreEntry(textNorm, entry),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * @param {string} text
 * @returns {{ kind: 'match', key: string, label: string, unit: string } | { kind: 'ambiguous', options: typeof FLIGHT_HUD_CATALOG, hint: string } | { kind: 'need_model' }}
 */
export function resolveHudParamLocally(text) {
  const ranked = rankHudParamMatches(text);
  const hint = 'לא בטוחים למה התכוונת — בחרו פריט מהרשימה, או נסחו מחדש בקצרה:';

  if (ranked.length === 0) return { kind: 'need_model' };

  const top = ranked[0];
  const second = ranked[1];

  if (top.score < 8) return { kind: 'need_model' };

  const nearTie = second != null && top.score - second.score < 8;
  if (nearTie) {
    const cutoff = top.score - 3;
    const opts = ranked.filter((r) => r.score >= cutoff).slice(0, 5).map((r) => r.entry);
    const uniq = [];
    const seen = new Set();
    for (const e of opts) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      uniq.push(e);
    }
    if (uniq.length >= 2) {
      return { kind: 'ambiguous', options: uniq, hint };
    }
  }

  return { kind: 'match', key: top.entry.key, label: top.entry.label, unit: top.entry.unit };
}

export function formatHudCatalogForPrompt() {
  return FLIGHT_HUD_CATALOG.map((e) => `  "${e.key}" → ${e.label} (${e.unit || 'ללא יחידה'})`).join('\n');
}

/**
 * @param {string} rawJson
 * @returns {{ kind: 'match', key: string, label: string, unit: string } | { kind: 'ambiguous', options: typeof FLIGHT_HUD_CATALOG, hint: string } | { kind: 'none', message: string }}
 */
export function parseHudGeminiResolution(rawJson) {
  const hint = 'לא בטוחים — בחרו מהרשימה או נסחו שוב:';
  let obj;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return { kind: 'none', message: 'לא זוהה — נסו ניסוח אחר או בחרו מהרשימה.' };
  }
  const status = String(obj.status || '').toLowerCase();
  if (status === 'match' && obj.key) {
    const found = FLIGHT_HUD_CATALOG.find((e) => e.key === String(obj.key).trim());
    if (found) return { kind: 'match', key: found.key, label: found.label, unit: found.unit };
  }
  const keysRaw = Array.isArray(obj.keys) ? obj.keys : [];
  const keys = keysRaw.map((k) => String(k).trim()).filter(Boolean);
  const options = keys
    .map((k) => FLIGHT_HUD_CATALOG.find((e) => e.key === k))
    .filter(Boolean);
  if (status === 'ambiguous' && options.length >= 2) {
    return { kind: 'ambiguous', options, hint };
  }
  if (status === 'ambiguous' && options.length === 1) {
    const e = options[0];
    return { kind: 'match', key: e.key, label: e.label, unit: e.unit };
  }
  if (status === 'none' || status === 'nomatch') {
    return { kind: 'none', message: String(obj.message || 'לא נמצאה התאמה — נסו מילה אחרת או הוסיפו הקשר (למשל «מהירות אוויר מול קרקעית»).') };
  }
  return { kind: 'none', message: 'לא זוהה — נסו ניסוח אחר.' };
}

export function buildHudGeminiPrompt(userText) {
  return `You map the pilot's Hebrew or English phrase to telemetry fields for a flight HUD.

Catalog (keys are exact):
${formatHudCatalogForPrompt()}

Pilot text: ${JSON.stringify(userText)}

Reply with ONLY valid JSON (no markdown):
{
  "status": "match" | "ambiguous" | "none",
  "key": "<exact catalog key or null>",
  "keys": ["key1", "key2"],
  "message": "<short Hebrew hint if status is none>"
}

Rules:
- status "match" when ONE catalog row clearly fits; set "key", "keys" [].
- status "ambiguous" when 2–4 catalog rows could fit (e.g. only "מהירות" without air vs ground); set "keys" with 2–4 exact keys, "key" null.
- status "none" only if nothing fits; short Hebrew message.
- Never invent keys — only from the catalog.
- If unsure between airspeed and groundspeed, prefer "ambiguous" with both mavlink axes unless the pilot said אוויר/קרקע/IAS/GS clearly.`;
}
