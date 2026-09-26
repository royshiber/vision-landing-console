/**
 * Server-side check that a debrief only says numbers, times, and modes
 * that appear in the cited fact-sheet items.
 */

const MODE_WORDS = [
  'MANUAL', 'CIRCLE', 'STABILIZE', 'TRAINING', 'ACRO', 'FBWA', 'FBWB', 'CRUISE',
  'AUTOTUNE', 'AUTO', 'RTL', 'LOITER', 'TAKEOFF', 'GUIDED', 'QSTABILIZE', 'QHOVER',
  'QLOITER', 'QLAND', 'QRTL',
];

function flightModes(sheet) {
  const modes = new Set();
  for (const row of sheet?.modes || []) {
    if (typeof row === 'string') modes.add(row);
    else if (row?.mode) modes.add(String(row.mode));
  }
  return modes;
}

function itemById(sheet) {
  const map = new Map();
  for (const fact of sheet?.facts || []) map.set(fact.id, { kind: 'fact', item: fact });
  for (const insight of sheet?.insights || []) map.set(insight.id, { kind: 'insight', item: insight });
  for (const event of sheet?.events || []) map.set(event.id, { kind: 'event', item: event });
  return map;
}

function collectNumbers(value, into) {
  if (typeof value === 'number' && Number.isFinite(value)) into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectNumbers(v, into));
}

function citedNumbers(sheet, ids, index, { whole = false } = {}) {
  const values = [];
  const times = [];
  const source = whole ? [...index.values()] : ids.map((id) => index.get(id)).filter(Boolean);
  for (const hit of source) {
    const item = hit.item;
    collectNumbers(item.value, values);
    collectNumbers(item.t_rel_s, times);
    collectNumbers(item.from_rel_s, times);
    collectNumbers(item.to_rel_s, times);
    collectNumbers(item.dur_s, times);
    if (item.data) collectNumbers(item.data, values);
    const unit = item.unit || null;
    if (typeof item.value === 'number') {
      if (unit === 'm') values.push(item.value / 1000);
      if (unit === 'm/s') values.push(item.value * 3.6);
      if (unit === 'km') values.push(item.value * 1000);
      if (unit === 'km/h') values.push(item.value / 3.6);
    }
  }
  if (whole) collectNumbers(sheet?.stats, values);
  return { values, times };
}

function closeEnough(shown, candidates) {
  for (const raw of candidates) {
    const actual = Number(raw);
    if (!Number.isFinite(actual)) continue;
    if (Object.is(shown, actual)) return true;
    if (Math.round(actual) === shown || Math.round(actual * 10) / 10 === shown) return true;
    const scale = Math.max(Math.abs(actual), 1e-9);
    if (Math.abs(shown - actual) / scale <= 0.02) return true;
  }
  return false;
}

function timesOf(text) {
  const out = [];
  const tplus = /T([+-])(\d+):(\d{2})/g;
  let m;
  while ((m = tplus.exec(text))) {
    const sign = m[1] === '-' ? -1 : 1;
    out.push(sign * (Number(m[2]) * 60 + Number(m[3])));
  }
  return out;
}

function plainNumbers(text) {
  const masked = String(text).replace(/T[+-]\d+:\d{2}/g, ' ');
  const out = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(masked))) out.push(Number(m[0].replace(',', '.')));
  return out;
}

function modesIn(text) {
  const found = [];
  for (const word of MODE_WORDS) {
    if (new RegExp(`(^|[^A-Za-z])${word}([^A-Za-z]|$)`).test(text)) found.push(word);
  }
  return found;
}

function checkText(text, cite, sheet, index, { summary = false } = {}) {
  const errors = [];
  const ids = Array.isArray(cite) ? cite.map(String) : [];
  for (const id of ids) {
    if (!index.has(id)) errors.push(`unknown cite ${id}`);
  }
  const pool = citedNumbers(sheet, summary ? [...index.keys()] : ids, index, { whole: summary });
  const needsCite = !summary && (plainNumbers(text).length || timesOf(text).length || modesIn(text).length);
  if (needsCite && !ids.length) errors.push('missing cite');
  for (const n of plainNumbers(text)) {
    if (!closeEnough(n, pool.values) && !closeEnough(n, pool.times)) errors.push(`number ${n}`);
  }
  for (const t of timesOf(text)) {
    if (!pool.times.some((raw) => Number.isFinite(Number(raw)) && Math.abs(t - Number(raw)) <= 1)) {
      errors.push(`time ${t}`);
    }
  }
  const allowed = flightModes(sheet);
  for (const mode of modesIn(text)) {
    if (!allowed.has(mode)) errors.push(`mode ${mode}`);
  }
  return errors;
}

function schemaErrors(output) {
  const errors = [];
  if (!output || typeof output !== 'object') return ['not an object'];
  if (!['ok', 'attention', 'problem'].includes(output.verdict)) errors.push('verdict');
  if (typeof output.summary_he !== 'string') errors.push('summary_he');
  for (const key of ['what_happened', 'why', 'what_to_do']) {
    if (!Array.isArray(output[key])) errors.push(key);
  }
  if (!Array.isArray(output.unknowns_he)) errors.push('unknowns_he');
  return errors;
}

/**
 * @returns {{ok:boolean, failureRatio:number, errors:string[], output:object, unverifiedCount:number, sentenceCount:number}}
 */
export function validateDebrief(raw, sheet) {
  const structural = schemaErrors(raw);
  if (structural.length) {
    return {
      ok: false,
      failureRatio: 1,
      errors: structural,
      output: raw && typeof raw === 'object' ? raw : {},
      unverifiedCount: 1,
      sentenceCount: 1,
    };
  }
  const index = itemById(sheet);
  const errors = [];
  let sentenceCount = 0;
  let unverifiedCount = 0;
  const output = {
    verdict: raw.verdict,
    summary_he: raw.summary_he,
    what_happened: [],
    why: [],
    what_to_do: [],
    unknowns_he: raw.unknowns_he.map((s) => String(s)),
  };

  const summaryErr = checkText(raw.summary_he, [], sheet, index, { summary: true });
  sentenceCount += 1;
  if (summaryErr.length) {
    unverifiedCount += 1;
    errors.push(`summary_he: ${summaryErr.join(', ')}`);
    output.summary_unverified = true;
  }

  for (const key of ['what_happened', 'why', 'what_to_do']) {
    raw[key].forEach((item, i) => {
      sentenceCount += 1;
      const text = String(item?.text_he || '');
      const cite = Array.isArray(item?.cite) ? item.cite.map(String) : [];
      const rowErr = checkText(text, cite, sheet, index);
      const unverified = rowErr.length > 0;
      if (unverified) {
        unverifiedCount += 1;
        errors.push(`${key}[${i}]: ${rowErr.join(', ')}`);
      }
      const row = { text_he: text, cite, unverified };
      if (key === 'what_to_do') row.confidence = ['high', 'medium', 'low'].includes(item?.confidence) ? item.confidence : 'low';
      output[key].push(row);
    });
  }

  if (output.summary_unverified) {
    const verified = [...output.what_happened, ...output.why].filter((row) => !row.unverified).map((row) => row.text_he);
    output.summary_he = verified.length ? verified.join(' ') : 'אין משפטים מאומתים לסיכום.';
    output.summary_recomputed = true;
  }

  const failureRatio = sentenceCount ? unverifiedCount / sentenceCount : 0;
  return {
    ok: unverifiedCount === 0,
    failureRatio,
    errors,
    output,
    unverifiedCount,
    sentenceCount,
  };
}
