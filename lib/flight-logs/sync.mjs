/**
 * Incremental flight-book sync.
 * Index ETags upsert flights. Events are ingested so cross-flight search works.
 * summary / series / track are cached on first open. Per-flight errors do not abort.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, setConfig } from '../db.mjs';
import { cachedTranslation } from '../statustext-translate.mjs';
import {
  NO_FLIGHTS_HE,
  NOT_CONFIGURED_HE,
  endReasonHe,
  reasonHe,
  syncErrorHe,
  timeSourceLabelHe,
  uploadLabelHe,
} from './messages.mjs';
import { parseJsonlMaybeGzip, parseJsonMaybeGzip, verifySha } from './objects.mjs';
import {
  artifactObjectKey,
  createFlightLogProvider,
  flightLogsConfig,
  preferIndexObjects,
} from './provider.mjs';
import { formatJerusalem, formatTPlus } from './time.mjs';

const mem = { lastSyncAt: null, lastError: null, syncing: false, loaded: false };

function loadMem(db) {
  if (mem.loaded) return;
  const saved = getConfig(db, 'flightLogs', null);
  if (saved && typeof saved === 'object') {
    mem.lastSyncAt = saved.lastSyncAt || null;
    mem.lastError = saved.lastError || null;
  }
  mem.loaded = true;
}

function writeMem(db, { lastSyncAt, lastError }) {
  mem.lastSyncAt = lastSyncAt ?? null;
  mem.lastError = lastError ?? null;
  mem.loaded = true;
  setConfig(db, 'flightLogs', { lastSyncAt: mem.lastSyncAt, lastError: mem.lastError });
}

function scrub(text, cfg) {
  let out = String(text || '');
  if (cfg?.appKey) out = out.split(cfg.appKey).join('[redacted]');
  if (cfg?.keyId) out = out.split(cfg.keyId).join('[redacted]');
  return out.slice(0, 400);
}

export function cacheDirFor(db, uid) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(String(uid || ''))) {
    const err = new Error('bad flight id');
    err.status = 400;
    throw err;
  }
  const base = db?.name && db.name !== ':memory:'
    ? path.join(path.dirname(path.resolve(db.name)), 'flights', 'cloud')
    : path.join(os.tmpdir(), 'airvix-flight-cache');
  return path.join(base, uid);
}

function counts(db) {
  const flights = db.prepare(`
    SELECT COUNT(*) AS n FROM flights
    WHERE origin = 'cloud' AND COALESCE(hidden, 0) = 0 AND classification = 'flight'
  `).get().n;
  const ground = db.prepare(`
    SELECT COUNT(*) AS n FROM flights
    WHERE origin = 'cloud' AND COALESCE(hidden, 0) = 0 AND classification IN ('bench', 'ground_run')
  `).get().n;
  const warnings = db.prepare(`
    SELECT COUNT(*) AS n FROM flights
    WHERE origin = 'cloud' AND COALESCE(hidden, 0) = 0
      AND (COALESCE(warnings, 0) > 0 OR COALESCE(errors, 0) > 0 OR COALESCE(critical, 0) > 0)
  `).get().n;
  return { flights, ground, warnings };
}

export function publicFlightLogsStatus(ctx) {
  const cfg = flightLogsConfig();
  loadMem(ctx.db);
  const empty = counts(ctx.db);
  let messageHe = null;
  if (!cfg.configured) messageHe = cfg.gapHe || NOT_CONFIGURED_HE;
  else if (empty.flights + empty.ground === 0 && !mem.lastError) messageHe = NO_FLIGHTS_HE;
  else if (mem.lastError) messageHe = syncErrorHe(mem.lastSyncAt, scrub(mem.lastError, cfg));
  return {
    ok: true,
    mode: cfg.mode,
    configured: cfg.configured,
    lastSyncAt: mem.lastSyncAt,
    lastError: mem.lastError ? scrub(mem.lastError, cfg) : null,
    counts: cfg.configured ? empty : { flights: 0, ground: 0, warnings: 0 },
    messageHe,
  };
}

function flightNumbers(db) {
  const rows = db.prepare(`
    SELECT flight_uid, vehicle_id, arm_utc FROM flights
    WHERE origin = 'cloud' AND flight_uid IS NOT NULL
    ORDER BY vehicle_id, arm_utc
  `).all();
  const map = new Map();
  const n = {};
  for (const row of rows) {
    const v = row.vehicle_id || '';
    n[v] = (n[v] || 0) + 1;
    map.set(row.flight_uid, n[v]);
  }
  return map;
}

function refreshCloudTitles(db) {
  const rows = db.prepare(`
    SELECT id, flight_uid, vehicle_id, user_label FROM flights
    WHERE origin = 'cloud' AND flight_uid IS NOT NULL
    ORDER BY vehicle_id, arm_utc
  `).all();
  const nums = flightNumbers(db);
  const setTitle = db.prepare('UPDATE flights SET title = ? WHERE id = ?');
  for (const row of rows) {
    const label = String(row.user_label || '').trim();
    const title = label || `טיסה ${nums.get(row.flight_uid) || ''}`.trim();
    setTitle.run(title, row.id);
  }
}

function worstSev(row) {
  if (Number(row.critical) > 0) return 'critical';
  if (Number(row.errors) > 0) return 'error';
  if (Number(row.warnings) > 0) return 'warning';
  return 'info';
}

function decorate(db, row, nums) {
  let modes = [];
  try { modes = JSON.parse(row.modes_json || '[]'); } catch { modes = []; }
  const debrief = db.prepare('SELECT 1 AS n FROM flight_debriefs WHERE flight_uid = ? LIMIT 1').get(row.flight_uid);
  return {
    id: row.id,
    flight_uid: row.flight_uid,
    title: row.title,
    user_label: row.user_label || null,
    origin: row.origin,
    vehicle_id: row.vehicle_id,
    classification: row.classification,
    state: row.state,
    arm_utc: row.arm_utc,
    armLocal: formatJerusalem(row.arm_utc),
    takeoff_utc: row.takeoff_utc,
    landed_utc: row.landed_utc,
    disarm_utc: row.disarm_utc,
    duration_s: row.duration_s,
    air_time_s: row.air_time_s,
    max_rel_alt_m: row.max_rel_alt_m,
    max_airspeed_mps: row.max_airspeed_mps,
    max_groundspeed_mps: row.max_groundspeed_mps,
    distance_m: row.distance_m,
    modes,
    warnings: row.warnings || 0,
    errors: row.errors || 0,
    critical: row.critical || 0,
    worstSev: worstSev(row),
    end_reason: row.end_reason,
    endReasonHe: endReasonHe(row.end_reason),
    flightNumber: nums.get(row.flight_uid) || null,
    uploadLabelHe: uploadLabelHe(row),
    debriefBadgeHe: debrief ? 'יש תחקיר' : 'אין תחקיר',
    hidden: Number(row.hidden) === 1,
    time_source: null,
  };
}

function upsertIndex(db, index, etag) {
  const uid = String(index.flight_id);
  const existing = db.prepare('SELECT id, index_etag, user_label FROM flights WHERE flight_uid = ?').get(uid);
  const fields = {
    flight_uid: uid,
    origin: 'cloud',
    vehicle_id: index.vehicle_id || null,
    classification: index.classification || null,
    state: index.state || null,
    arm_utc: index.arm_utc || null,
    takeoff_utc: index.takeoff_utc || null,
    landed_utc: index.landed_utc || null,
    disarm_utc: index.disarm_utc || null,
    duration_s: index.duration_s ?? null,
    air_time_s: index.air_time_s ?? null,
    max_rel_alt_m: index.max_rel_alt_m ?? null,
    max_airspeed_mps: index.max_airspeed_mps ?? null,
    max_groundspeed_mps: index.max_groundspeed_mps ?? null,
    distance_m: index.distance_m ?? null,
    modes_json: JSON.stringify(index.modes || []),
    warnings: index.warnings ?? 0,
    errors: index.errors ?? 0,
    critical: index.critical ?? 0,
    end_reason: index.end_reason || null,
    manifest_rev: index.manifest_rev ?? null,
    index_etag: etag,
    synced_at: new Date().toISOString(),
  };
  if (!existing) {
    db.prepare(`
      INSERT INTO flights (
        title, created_at, flight_uid, origin, vehicle_id, classification, state,
        arm_utc, takeoff_utc, landed_utc, disarm_utc, duration_s, air_time_s,
        max_rel_alt_m, max_airspeed_mps, max_groundspeed_mps, distance_m, modes_json,
        warnings, errors, critical, end_reason, manifest_rev, index_etag, synced_at, hidden
      ) VALUES (
        @flight_uid, COALESCE(@arm_utc, datetime('now')), @flight_uid, 'cloud', @vehicle_id, @classification, @state,
        @arm_utc, @takeoff_utc, @landed_utc, @disarm_utc, @duration_s, @air_time_s,
        @max_rel_alt_m, @max_airspeed_mps, @max_groundspeed_mps, @distance_m, @modes_json,
        @warnings, @errors, @critical, @end_reason, @manifest_rev, @index_etag, @synced_at, 0
      )
    `).run(fields);
    return true;
  }
  if (existing.index_etag === etag) return false;
  db.prepare(`
    UPDATE flights SET
      vehicle_id=@vehicle_id, classification=@classification, state=@state,
      arm_utc=@arm_utc, takeoff_utc=@takeoff_utc, landed_utc=@landed_utc, disarm_utc=@disarm_utc,
      duration_s=@duration_s, air_time_s=@air_time_s, max_rel_alt_m=@max_rel_alt_m,
      max_airspeed_mps=@max_airspeed_mps, max_groundspeed_mps=@max_groundspeed_mps, distance_m=@distance_m,
      modes_json=@modes_json, warnings=@warnings, errors=@errors, critical=@critical,
      end_reason=@end_reason, manifest_rev=@manifest_rev, index_etag=@index_etag, synced_at=@synced_at,
      origin='cloud'
    WHERE flight_uid=@flight_uid
  `).run(fields);
  return true;
}

function replaceEvents(db, uid, events) {
  const del = db.prepare('DELETE FROM flight_events WHERE flight_uid = ?');
  const ins = db.prepare(`
    INSERT INTO flight_events (
      flight_uid, event_id, t_utc_ms, t_rel_s, src, type, sev, msg, msg_he, data_json, cause_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    del.run(uid);
    for (const e of rows) {
      const ms = e.t_utc ? Date.parse(e.t_utc) : NaN;
      ins.run(
        uid,
        String(e.id),
        Number.isFinite(ms) ? ms : null,
        e.t_rel_s ?? null,
        e.src || null,
        e.type || null,
        e.sev || null,
        e.msg || null,
        e.msg_he || null,
        e.data ? JSON.stringify(e.data) : null,
        e.cause_id || null,
      );
    }
  });
  tx(events);
}

async function ingestEvents(db, provider, cfg, index) {
  const key = artifactObjectKey(cfg, index.vehicle_id, index.flight_id, 'events.jsonl.gz');
  let bytes;
  try {
    ({ bytes } = await provider.getBytes(key));
  } catch (err) {
    if (err.status === 404) return;
    throw err;
  }
  const events = parseJsonlMaybeGzip(bytes);
  replaceEvents(db, index.flight_id, events);
  const dir = cacheDirFor(db, index.flight_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl.gz'), bytes);
}

export async function syncFlightLogs(ctx, { reason: _reason = 'manual' } = {}) {
  const cfg = flightLogsConfig();
  loadMem(ctx.db);
  if (!cfg.configured) {
    return publicFlightLogsStatus(ctx);
  }
  if (mem.syncing) return publicFlightLogsStatus(ctx);
  mem.syncing = true;
  const errors = [];
  try {
    const provider = createFlightLogProvider();
    const vehicles = cfg.vehicles.length ? cfg.vehicles : await provider.listVehicles();
    for (const vehicle of vehicles) {
      let indexes = [];
      try {
        indexes = preferIndexObjects(await provider.listIndex(vehicle));
      } catch (err) {
        errors.push(scrub(err.message, cfg));
        continue;
      }
      for (const item of indexes) {
        try {
          const existing = ctx.db.prepare('SELECT index_etag FROM flights WHERE flight_uid = ?').get(item.flightId);
          const eventCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM flight_events WHERE flight_uid = ?').get(item.flightId).n;
          if (existing && existing.index_etag === item.etag && eventCount > 0) continue;
          const { json } = await provider.readJson(item.key);
          const changed = upsertIndex(ctx.db, json, item.etag);
          if (changed || eventCount === 0) await ingestEvents(ctx.db, provider, cfg, json);
        } catch (err) {
          errors.push(scrub(`${item.flightId || item.key}: ${err.message}`, cfg));
        }
      }
    }
    refreshCloudTitles(ctx.db);
    writeMem(ctx.db, {
      lastSyncAt: new Date().toISOString(),
      lastError: errors.length ? errors.join('; ') : null,
    });
  } catch (err) {
    writeMem(ctx.db, { lastSyncAt: mem.lastSyncAt, lastError: scrub(err.message, cfg) });
  } finally {
    mem.syncing = false;
  }
  return publicFlightLogsStatus(ctx);
}

export function scheduleFlightLogsBootSync(ctx) {
  setImmediate(() => {
    syncFlightLogs(ctx, { reason: 'boot' }).catch(() => {});
  });
}

export function isSafeArtifactName(name) {
  if (typeof name !== 'string' || !name || name.length > 180) return false;
  if (name.includes('..') || name.includes('\\') || name.startsWith('/') || name.includes('\0')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

function writeCache(db, uid, name, bytes) {
  const dir = cacheDirFor(db, uid);
  const rel = name.split('/').join(path.sep);
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    const err = new Error('bad artifact');
    err.status = 400;
    throw err;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return full;
}

function readCache(db, uid, name) {
  try {
    const dir = cacheDirFor(db, uid);
    const full = path.resolve(dir, name.split('/').join(path.sep));
    if (!full.startsWith(path.resolve(dir) + path.sep)) return null;
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  } catch {
    return null;
  }
}

function upsertArtifact(db, uid, art, extra = {}) {
  db.prepare(`
    INSERT INTO flight_cloud_artifacts (
      flight_uid, name, kind, key, bytes, sha256, state, reason, cached_path, cached_at
    ) VALUES (
      @flight_uid, @name, @kind, @key, @bytes, @sha256, @state, @reason, @cached_path, @cached_at
    )
    ON CONFLICT(flight_uid, name) DO UPDATE SET
      kind=excluded.kind, key=excluded.key, bytes=excluded.bytes, sha256=excluded.sha256,
      state=excluded.state, reason=excluded.reason, cached_path=excluded.cached_path, cached_at=excluded.cached_at
  `).run({
    flight_uid: uid,
    name: art.name,
    kind: art.kind || null,
    key: art.key || null,
    bytes: art.bytes ?? null,
    sha256: art.sha256 || null,
    state: extra.state || art.state || null,
    reason: extra.reason !== undefined ? extra.reason : (art.reason || null),
    cached_path: extra.cached_path || null,
    cached_at: extra.cached_at || null,
  });
}

async function loadVerifiedJson(ctx, provider, cfg, row, manifest, name, opts) {
  const art = (manifest?.artifacts || []).find((a) => a.name === name);
  if (art && art.state && art.state !== 'uploaded') return null;
  try {
    const bytes = await loadNamed(ctx.db, provider, cfg, row, name, {});
    if (art?.sha256 && !verifySha(bytes, art.sha256).ok) {
      upsertArtifact(ctx.db, row.flight_uid, art, { state: 'corrupt', reason: 'corrupt' });
      return null;
    }
    if (opts.asJsonl) return parseJsonlMaybeGzip(bytes);
    if (opts.asJson) return parseJsonMaybeGzip(bytes);
    return bytes;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function loadNamed(db, provider, cfg, row, name, { asJson = false, asJsonl = false } = {}) {
  const key = artifactObjectKey(cfg, row.vehicle_id, row.flight_uid, name);
  let bytes = readCache(db, row.flight_uid, name);
  if (!bytes) {
    const got = await provider.getBytes(key);
    bytes = got.bytes;
    writeCache(db, row.flight_uid, name, bytes);
  }
  if (asJsonl) return parseJsonlMaybeGzip(bytes);
  if (asJson) return parseJsonMaybeGzip(bytes);
  return bytes;
}

export async function openFlightBundle(ctx, uid) {
  const cfg = flightLogsConfig();
  if (!cfg.configured) {
    const err = new Error(cfg.gapHe || NOT_CONFIGURED_HE);
    err.status = 409;
    err.messageHe = cfg.gapHe || NOT_CONFIGURED_HE;
    throw err;
  }
  const row = ctx.db.prepare('SELECT * FROM flights WHERE flight_uid = ? AND origin = ?').get(uid, 'cloud');
  if (!row) return null;
  const provider = createFlightLogProvider();
  const manifest = await loadNamed(ctx.db, provider, cfg, row, 'manifest.json', { asJson: true });
  const summary = await loadVerifiedJson(ctx, provider, cfg, row, manifest, 'summary.json', { asJson: true });
  const series = await loadVerifiedJson(ctx, provider, cfg, row, manifest, 'series.json.gz', { asJson: true });
  const track = await loadVerifiedJson(ctx, provider, cfg, row, manifest, 'track.geojson.gz', { asJson: true });
  const eventCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM flight_events WHERE flight_uid = ?').get(uid).n;
  if (!eventCount) {
    try {
      const events = await loadNamed(ctx.db, provider, cfg, row, 'events.jsonl.gz', { asJsonl: true });
      replaceEvents(ctx.db, uid, events);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  for (const art of artifacts) {
    upsertArtifact(ctx.db, uid, art);
  }
  const nums = flightNumbers(ctx.db);
  const flight = decorate(ctx.db, ctx.db.prepare('SELECT * FROM flights WHERE flight_uid = ?').get(uid), nums);
  flight.time_source = manifest?.times?.time_source || null;
  flight.timeSourceLabelHe = timeSourceLabelHe(flight.time_source);
  flight.endReasonHe = endReasonHe(flight.end_reason);
  return {
    flight,
    manifest,
    summary,
    series,
    track,
    artifacts: artifacts.map((art) => ({
      name: art.name,
      kind: art.kind || null,
      state: art.state || null,
      reason: art.reason || null,
      reasonHe: reasonHe(art.reason) || (art.state === 'uploaded' ? '' : reasonHe(art.state)),
      bytes: art.bytes ?? null,
      chunked: Boolean(art.chunked),
      sha256: art.sha256 || null,
    })),
  };
}

export function listFlightLogs(ctx, query) {
  const cfg = flightLogsConfig();
  if (!cfg.configured) {
    return { ok: true, configured: false, flights: [], messageHe: cfg.gapHe || NOT_CONFIGURED_HE };
  }
  const where = [`origin = 'cloud'`, `COALESCE(hidden, 0) = 0`];
  const params = [];
  const includeGround = query.includeGround === '1' || query.includeGround === 'true';
  if (!includeGround) where.push(`classification NOT IN ('bench', 'ground_run')`);
  if (query.classification) {
    where.push('classification = ?');
    params.push(String(query.classification));
  }
  if (query.warnings === '1' || query.warnings === 'true') {
    where.push('(COALESCE(warnings,0) > 0 OR COALESCE(errors,0) > 0 OR COALESCE(critical,0) > 0)');
  }
  if (query.mode) {
    where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(modes_json, '[]')) WHERE json_each.value = ?)`);
    params.push(String(query.mode));
  }
  if (query.from) {
    where.push('arm_utc >= ?');
    params.push(String(query.from));
  }
  if (query.to) {
    const to = String(query.to);
    where.push('arm_utc <= ?');
    params.push(to.length <= 10 ? `${to}T23:59:59.999Z` : to);
  }
  if (query.q) {
    const like = `%${String(query.q).replace(/[%_]/g, '').slice(0, 80)}%`;
    where.push(`EXISTS (
      SELECT 1 FROM flight_events e
      WHERE e.flight_uid = flights.flight_uid
        AND (IFNULL(e.msg,'') LIKE ? OR IFNULL(e.msg_he,'') LIKE ? OR IFNULL(e.type,'') LIKE ?)
    )`);
    params.push(like, like, like);
  }
  const rows = ctx.db.prepare(`
    SELECT * FROM flights WHERE ${where.join(' AND ')} ORDER BY arm_utc DESC
  `).all(...params);
  const nums = flightNumbers(ctx.db);
  return {
    ok: true,
    configured: true,
    flights: rows.map((row) => decorate(ctx.db, row, nums)),
    messageHe: rows.length ? null : NO_FLIGHTS_HE,
  };
}

export function listEvents(ctx, uid, query) {
  const where = ['flight_uid = ?'];
  const params = [uid];
  if (query.src) {
    where.push('src = ?');
    params.push(String(query.src));
  }
  if (query.sev) {
    where.push('sev = ?');
    params.push(String(query.sev));
  }
  const rows = ctx.db.prepare(`
    SELECT * FROM flight_events WHERE ${where.join(' AND ')} ORDER BY t_rel_s, event_id
  `).all(...params);
  return rows.map((row) => {
    let data = null;
    try { data = row.data_json ? JSON.parse(row.data_json) : null; } catch { data = null; }
    const translated = row.msg_he || cachedTranslation(row.msg) || null;
    return {
      id: row.event_id,
      t_utc: row.t_utc_ms ? new Date(row.t_utc_ms).toISOString() : null,
      tLocal: row.t_utc_ms ? formatJerusalem(row.t_utc_ms) : '',
      t_rel_s: row.t_rel_s,
      tPlus: formatTPlus(row.t_rel_s),
      src: row.src,
      type: row.type,
      sev: row.sev,
      msg: row.msg,
      msg_he: translated || row.msg,
      data,
      cause_id: row.cause_id,
    };
  });
}

export function patchFlightOverlay(ctx, uid, body) {
  const row = ctx.db.prepare(`SELECT * FROM flights WHERE flight_uid = ? AND origin = 'cloud'`).get(uid);
  if (!row) return null;
  if (body && Object.prototype.hasOwnProperty.call(body, 'user_label')) {
    const label = String(body.user_label ?? '').trim().slice(0, 80);
    ctx.db.prepare('UPDATE flights SET user_label = ? WHERE flight_uid = ?').run(label || null, uid);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'hidden')) {
    ctx.db.prepare('UPDATE flights SET hidden = ? WHERE flight_uid = ?').run(body.hidden ? 1 : 0, uid);
  }
  refreshCloudTitles(ctx.db);
  const nums = flightNumbers(ctx.db);
  return decorate(ctx.db, ctx.db.prepare('SELECT * FROM flights WHERE flight_uid = ?').get(uid), nums);
}

export async function readFlightArtifact(ctx, uid, name) {
  if (!isSafeArtifactName(name)) {
    const err = new Error('bad artifact name');
    err.status = 400;
    err.messageHe = 'שם קובץ לא חוקי';
    throw err;
  }
  const bundle = await openFlightBundle(ctx, uid);
  if (!bundle) return null;
  const art = (bundle.manifest?.artifacts || []).find((a) => a.name === name);
  if (!art) {
    const err = new Error('not in manifest');
    err.status = 404;
    err.messageHe = 'הקובץ לא מופיע במניפסט של הטיסה';
    throw err;
  }
  if (art.state !== 'uploaded') {
    const err = new Error('unavailable');
    err.status = 409;
    err.messageHe = reasonHe(art.reason) || 'הקובץ עדיין לא זמין';
    err.reason = art.reason || null;
    throw err;
  }
  const cfg = flightLogsConfig();
  const provider = createFlightLogProvider();
  const baseKey = art.key || artifactObjectKey(cfg, bundle.flight.vehicle_id, uid, name);
  let bytes = null;
  let state = 'uploaded';
  if (art.chunked) {
    const assembled = await provider.readChunked(baseKey);
    if (!assembled.ok) {
      upsertArtifact(ctx.db, uid, art, { state: 'corrupt', reason: 'corrupt' });
      const err = new Error('corrupt');
      err.status = 409;
      err.messageHe = reasonHe('corrupt');
      throw err;
    }
    bytes = assembled.bytes;
  } else {
    const cached = readCache(ctx.db, uid, name);
    if (cached && verifySha(cached, art.sha256).ok) bytes = cached;
    else {
      const got = await provider.getBytes(baseKey);
      bytes = got.bytes;
    }
  }
  const check = verifySha(bytes, art.sha256);
  if (!check.ok) {
    upsertArtifact(ctx.db, uid, art, { state: 'corrupt', reason: 'corrupt' });
    const err = new Error('corrupt');
    err.status = 409;
    err.messageHe = reasonHe('corrupt');
    throw err;
  }
  const cachedPath = writeCache(ctx.db, uid, name, bytes);
  upsertArtifact(ctx.db, uid, art, {
    state,
    reason: null,
    cached_path: cachedPath,
    cached_at: new Date().toISOString(),
  });
  return { bytes, filename: path.posix.basename(name) };
}

/** Test hook: drop in-memory sync status between cases. */
export function _resetFlightLogsMemory() {
  mem.lastSyncAt = null;
  mem.lastError = null;
  mem.syncing = false;
  mem.loaded = false;
}
