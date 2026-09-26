/**
 * Deterministic fact sheet for one flight. The debrief may cite only these IDs.
 */
import crypto from 'node:crypto';

const ALWAYS_SEV = new Set(['warning', 'error', 'critical']);
const SEV_RANK = { critical: 0, error: 1, warning: 2, notice: 3, info: 4 };

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

export function digestFactSheet(sheet) {
  const copy = { ...sheet };
  delete copy.digest;
  return crypto.createHash('sha256').update(JSON.stringify(stable(copy))).digest('hex');
}

function isAlways(event) {
  const type = String(event.type || '');
  if (ALWAYS_SEV.has(event.sev)) return true;
  if (/mode/i.test(type)) return true;
  if (/arm|disarm|takeoff|land/i.test(type)) return true;
  return false;
}

function byTime(a, b) {
  const dt = Number(a.t_rel_s) - Number(b.t_rel_s);
  if (dt) return dt;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Collapse repeated info events to first+last, then cap.
 * Lowest-severity info rows are dropped first. `truncated` records that.
 */
export function collapseEvents(events, maxEvents = 400) {
  const always = [];
  const groups = new Map();
  for (const event of events || []) {
    if (isAlways(event)) {
      always.push(event);
      continue;
    }
    const key = String(event.type || event.id || 'info');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const collapsed = [...always];
  for (const rows of groups.values()) {
    rows.sort(byTime);
    collapsed.push(rows[0]);
    if (rows.length > 1) collapsed.push(rows[rows.length - 1]);
  }
  collapsed.sort(byTime);
  let truncated = false;
  let dropped = 0;
  let kept = collapsed;
  if (kept.length > maxEvents) {
    const ranked = [...kept].sort((a, b) => (SEV_RANK[b.sev] ?? 9) - (SEV_RANK[a.sev] ?? 9) || byTime(a, b));
    const cut = new Set(ranked.slice(0, kept.length - maxEvents).map((e) => e.id));
    kept = kept.filter((e) => !cut.has(e.id));
    dropped = cut.size;
    truncated = true;
  }
  return { events: kept, truncated, dropped };
}

function slimEvent(event) {
  return {
    id: event.id,
    t_rel_s: event.t_rel_s ?? null,
    t_utc: event.t_utc || null,
    src: event.src || null,
    type: event.type || null,
    sev: event.sev || null,
    msg: event.msg || '',
    msg_he: event.msg_he || null,
    cause_id: event.cause_id || null,
    data: event.data || null,
  };
}

export function buildFactSheet({
  flightId,
  summary,
  events,
  manifest,
  notes,
  maxEvents = 400,
  maxTokens = 30000,
} = {}) {
  const collapsed = collapseEvents(events, maxEvents);
  let kept = collapsed.events.map(slimEvent);
  let truncated = collapsed.truncated;
  let dropped = collapsed.dropped;
  const facts = Array.isArray(summary?.facts) ? summary.facts : [];
  const insights = Array.isArray(summary?.insights) ? summary.insights : [];
  const modes = Array.isArray(summary?.modes) ? summary.modes : [];
  const artifacts = (manifest?.artifacts || []).map((art) => ({
    name: art.name,
    state: art.state || null,
    reason: art.reason || null,
    kind: art.kind || null,
  }));
  const noteRows = (notes || []).map((n) => ({
    body: String(n.body || '').slice(0, 500),
    created_at: n.created_at || null,
  }));

  function assemble(eventRows) {
    return {
      schema: 'airvix.flight.factsheet/1',
      flight_id: flightId || null,
      facts,
      insights,
      events: eventRows,
      modes,
      coverage: summary?.coverage || {},
      stats: summary?.stats || {},
      artifacts,
      notes: noteRows,
      truncated,
      dropped,
    };
  }

  let sheet = assemble(kept);
  while (Math.ceil(JSON.stringify(sheet).length / 4) > maxTokens && kept.length) {
    const infoIdx = [...kept.keys()].reverse().find((i) => (SEV_RANK[kept[i].sev] ?? 9) >= 3);
    const idx = infoIdx == null ? kept.length - 1 : infoIdx;
    kept = kept.filter((_, i) => i !== idx);
    dropped += 1;
    truncated = true;
    sheet = assemble(kept);
  }
  sheet.digest = digestFactSheet(sheet);
  return sheet;
}
