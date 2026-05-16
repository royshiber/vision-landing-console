/**
 * Official ArduPlane parameter knowledge base.
 *
 * Loads data/arduplane-params.json (produced by: npm run fetch-arduplane-params).
 * Provides fast in-memory lookup and keyword search used by both:
 *   - Smart Search V2 (candidate generation / description enrichment)
 *   - Advisor chat (param context injection into Gemini system prompt)
 *
 * Thread-safe: module is a singleton; file is read once at first call.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'arduplane-params.json');

/** @type {Map<string, import('./docs-param-kb.d').ParamInfo> | null} */
let _map = null;
let _meta = null;

function load() {
  if (_map) return;
  try {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    _meta = raw._meta || {};
    _map = new Map(Object.entries(raw.params || {}).map(([k, v]) => [k.toUpperCase(), v]));
  } catch {
    _meta = {};
    _map = new Map();
    // Not a hard error — system degrades gracefully; log at runtime.
    process.stderr.write(
      '[docs-param-kb] WARNING: data/arduplane-params.json not found. ' +
      'Run: npm run fetch-arduplane-params\n',
    );
  }
}

/** @returns {{ fetched_at?: string, vehicle?: string, count?: number }} */
export function getDbMeta() {
  load();
  return _meta;
}

/** Total number of params in the official DB. */
export function getParamCount() {
  load();
  return _map.size;
}

/**
 * Look up a single param by exact key (case-insensitive).
 * @param {string} paramKey
 * @returns {{ display_name: string, description: string, units: string|null, range: {low:string,high:string}|null, values: object|null, bitmask: object|null } | null}
 */
export function getParamInfo(paramKey) {
  load();
  return _map.get(String(paramKey || '').toUpperCase()) ?? null;
}

/**
 * Return all params as an iterable of [key, info] entries.
 * @returns {IterableIterator<[string, object]>}
 */
export function allParamEntries() {
  load();
  return _map.entries();
}

/**
 * Fast keyword search over the official DB.
 *
 * Scoring:
 *   key match (exact prefix or includes) → 8
 *   display_name match                   → 4
 *   description match (word-level)       → 2
 *
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ param_key: string, display_name: string, description: string, units: string|null, range: object|null, values: object|null, _score: number }>}
 */
export function searchOfficialDb(query, { limit = 20 } = {}) {
  load();
  if (!query) return [];
  const terms = String(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const hits = [];
  for (const [key, info] of _map) {
    const keyLow = key.toLowerCase();
    const nameLow = (info.display_name || '').toLowerCase();
    const descLow = (info.description || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (keyLow === t) score += 12;
      else if (keyLow.startsWith(t)) score += 8;
      else if (keyLow.includes(t)) score += 5;
      if (nameLow.includes(t)) score += 4;
      if (descLow.includes(t)) score += 2;
    }
    if (score > 0) hits.push({ param_key: key, ...info, _score: score });
  }
  return hits.sort((a, b) => b._score - a._score).slice(0, limit);
}

/**
 * Format a short reference block for LLM context injection.
 * Intentionally concise to stay within token budget.
 *
 * @param {Array<{ param_key: string, display_name?: string, description?: string, units?: string|null, range?: {low:string,high:string}|null, values?: object|null }>} entries
 * @returns {string}
 */
export function formatParamRefBlock(entries) {
  if (!entries || !entries.length) return '';
  const lines = entries.map((p) => {
    const parts = [`**${p.param_key}**`];
    if (p.display_name && p.display_name !== p.param_key) parts.push(`(${p.display_name})`);
    if (p.units) parts.push(`[${p.units}]`);
    if (p.range) parts.push(`range: ${p.range.low}–${p.range.high}`);
    const desc = (p.description || '').trim().slice(0, 200);
    if (desc) parts.push(`— ${desc}`);
    if (p.values) {
      const vStr = Object.entries(p.values).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(', ');
      parts.push(`| values: ${vStr}`);
    }
    return '  ' + parts.join(' ');
  });
  const meta = _meta?.fetched_at ? ` (fetched ${_meta.fetched_at.slice(0, 10)})` : '';
  return `### ArduPlane Parameter Reference${meta} — ${entries.length} entries:\n${lines.join('\n')}`;
}
