/**
 * Dedicated flight telemetry archive (operator-armed Start → Stop).
 *
 * Path: data/flights/archive/  (under the console app data dir)
 * Schema: one .tlog session file + SQLite index `telemetry_archive`.
 *
 * Priority / backpressure (do not starve flight):
 *   0  FLIGHT         — parse / send MAVLink. Never queued behind archive or modem sync.
 *   1  ARCHIVE_WRITE  — local disk append. Dropped when the archive buffer is full.
 *   2  DOWNLINK_SYNC  — cellular export when a modem exists. Lowest. Stub until E3372 is live.
 *
 * Recording is operator-armed (Start → Stop). Default is not recording: connect or
 * idle MAVLink must not open a session file. The sink writes only while armed.
 *
 * A full Huawei E3372 downlink is not live yet. The queue and API are the software
 * foundation; sync jobs are accepted or shed according to the same backpressure rules.
 */

import fs from 'fs';
import path from 'path';
import { dataDir } from './db.mjs';

export const TELEMETRY_ARCHIVE_REL = 'data/flights/archive';

export const QUEUE_PRIORITIES = Object.freeze({
  FLIGHT: 0,
  ARCHIVE_WRITE: 1,
  DOWNLINK_SYNC: 2,
});

export function resolveArchiveRoot(rootDir = dataDir) {
  return path.join(rootDir, 'flights', 'archive');
}

export function ensureArchiveRoot(rootDir = dataDir) {
  const dir = resolveArchiveRoot(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionFileName({ at = new Date(), linkRole = 'radio', id = 'session' } = {}) {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const role = linkRole === 'cellular' ? 'cellular' : 'radio';
  return `${stamp}-${role}-${id}.tlog`;
}

/**
 * In-memory priority queue. Flight work always dequeues first.
 * Downlink is capped so a slow modem cannot fill RAM or delay FC traffic.
 */
export function createBackpressureQueue({
  maxPending = 64,
  maxDownlink = 8,
} = {}) {
  const buckets = [[], [], []];

  function pendingCount() {
    return buckets[0].length + buckets[1].length + buckets[2].length;
  }

  return {
    enqueue(priority, job) {
      const p = Number(priority);
      const slot = p === QUEUE_PRIORITIES.FLIGHT
        ? 0
        : p === QUEUE_PRIORITIES.ARCHIVE_WRITE
          ? 1
          : 2;
      if (slot === 2 && buckets[2].length >= maxDownlink) {
        return { accepted: false, reason: 'downlink_backpressure', pending: pendingCount() };
      }
      const total = pendingCount();
      if (slot !== 0 && total >= maxPending) {
        return { accepted: false, reason: 'archive_backpressure', pending: total };
      }
      buckets[slot].push(job);
      return { accepted: true, reason: null, pending: total + 1, priority: slot };
    },
    takeNext() {
      for (const bucket of buckets) {
        if (bucket.length) return bucket.shift();
      }
      return null;
    },
    stats() {
      return {
        flight: buckets[0].length,
        archiveWrite: buckets[1].length,
        downlinkSync: buckets[2].length,
        pending: pendingCount(),
        maxPending,
        maxDownlink,
      };
    },
  };
}

export const ARCHIVE_STALL_MS = 8000;

export const ARCHIVE_COPY_HE = Object.freeze({
  startOk: 'הקלטה התחילה. באית נשמרת לארכיון.',
  startAlready: 'ההקלטה כבר פעילה.',
  startFail: 'לא הצלחנו לפתוח קובץ הקלטה.',
  startNoLink: 'אין קישור פעיל. הקובץ יישאר ריק עד שתגיע באית.',
  stopOk: 'ההקלטה נעצרה. הסשן נסגר.',
  stopEmpty: 'ההקלטה נעצרה. לא נשמרה באית.',
  stopIdle: 'אין הקלטה פעילה.',
  stopFail: 'לא הצלחנו לעצור את ההקלטה.',
  httpFail: 'אין תשובה מהשרת. ההקלטה לא השתנתה.',
});

export const ARCHIVE_SESSIONS_LIMIT = 50;

export const ARCHIVE_SESSION_COPY_HE = Object.freeze({
  empty: 'אין הקלטות ארכיון עדיין',
  loadFail: 'לא הצלחנו לטעון את רשימת ההקלטות.',
  interrupted: 'נקטע',
  open: 'פתוח',
  emptyBytes: 'ריק',
  radio: 'רדיו',
  cellular: 'סלולר',
  missingFile: 'אין קובץ',
});

export function isPathInsideDir(filePath, dir) {
  const resolvedFile = path.resolve(String(filePath || ''));
  const resolvedDir = path.resolve(String(dir || ''));
  if (!resolvedDir || resolvedDir === path.sep) return false;
  return resolvedFile === resolvedDir || resolvedFile.startsWith(resolvedDir + path.sep);
}

export function archiveSessionBasename(storedPath) {
  const name = path.basename(String(storedPath || ''));
  return name || null;
}

export function isSafeArchiveTlog({ storedPath, archiveRoot } = {}) {
  if (!storedPath || !archiveRoot) return false;
  const resolved = path.resolve(String(storedPath));
  if (!isPathInsideDir(resolved, archiveRoot)) return false;
  if (path.extname(resolved).toLowerCase() !== '.tlog') return false;
  return true;
}

export function archiveDownloadFileName(basename) {
  const raw = String(basename || 'session.tlog');
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  const named = clean && clean !== '_' ? clean : 'session.tlog';
  return named.toLowerCase().endsWith('.tlog') ? named : `${named}.tlog`;
}

function sessionFileExists(storedPath) {
  try {
    return fs.statSync(path.resolve(String(storedPath))).isFile();
  } catch {
    return false;
  }
}

/**
 * One index row → operator-facing session card. Flags come from stored columns only.
 */
export function describeArchiveSession(row, { archiveRoot } = {}) {
  const bytes = Number(row?.bytes);
  const byteCount = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const endedAt = row?.ended_at || null;
  const interrupted = String(row?.downlink_state || '') === 'interrupted';
  const open = endedAt == null;
  const basename = archiveSessionBasename(row?.stored_path);
  const safe = isSafeArchiveTlog({ storedPath: row?.stored_path, archiveRoot });
  const exists = safe && sessionFileExists(row?.stored_path);
  const downloadable = safe && exists;
  const id = Number(row?.id);
  let statusHe = null;
  if (interrupted) statusHe = ARCHIVE_SESSION_COPY_HE.interrupted;
  else if (open) statusHe = ARCHIVE_SESSION_COPY_HE.open;
  else if (byteCount <= 0) statusHe = ARCHIVE_SESSION_COPY_HE.emptyBytes;
  return {
    id: Number.isFinite(id) && id > 0 ? id : null,
    startedAt: row?.started_at || null,
    endedAt,
    bytes: byteCount,
    linkRole: row?.link_role === 'cellular' ? 'cellular' : 'radio',
    interrupted,
    orphan: interrupted,
    empty: byteCount <= 0,
    open,
    basename,
    storedPath: row?.stored_path || null,
    downloadable,
    downloadUrl: downloadable && Number.isFinite(id) && id > 0
      ? `/api/telemetry-archive/sessions/${id}/file`
      : null,
    statusHe,
    linkRoleHe: row?.link_role === 'cellular'
      ? ARCHIVE_SESSION_COPY_HE.cellular
      : ARCHIVE_SESSION_COPY_HE.radio,
    bytesHe: formatArchiveBytesHe(byteCount),
  };
}

export function listArchiveSessions(db, {
  archiveRoot,
  limit = ARCHIVE_SESSIONS_LIMIT,
} = {}) {
  const cap = Math.min(Math.max(Number(limit) || ARCHIVE_SESSIONS_LIMIT, 1), 200);
  if (!db) {
    return { sessions: [], emptyHe: ARCHIVE_SESSION_COPY_HE.empty };
  }
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, started_at, ended_at, bytes, link_role, stored_path, downlink_state
      FROM telemetry_archive
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `).all(cap);
  } catch {
    rows = [];
  }
  const sessions = (rows || []).map((row) => describeArchiveSession(row, { archiveRoot }));
  return {
    sessions,
    emptyHe: sessions.length ? null : ARCHIVE_SESSION_COPY_HE.empty,
  };
}

export function resolveArchiveSessionFile(db, { id, archiveRoot } = {}) {
  const rowId = Number(id);
  if (!Number.isFinite(rowId) || rowId < 1) {
    return { ok: false, reason: 'bad_id', status: 400 };
  }
  if (!db || !archiveRoot) {
    return { ok: false, reason: 'unavailable', status: 404 };
  }
  let row = null;
  try {
    row = db.prepare(
      `SELECT id, stored_path FROM telemetry_archive WHERE id = ?`,
    ).get(rowId);
  } catch {
    return { ok: false, reason: 'unavailable', status: 404 };
  }
  if (!row) return { ok: false, reason: 'not_found', status: 404 };
  if (!isSafeArchiveTlog({ storedPath: row.stored_path, archiveRoot })) {
    return { ok: false, reason: 'unsafe', status: 404 };
  }
  const absPath = path.resolve(String(row.stored_path));
  if (!sessionFileExists(absPath)) {
    return { ok: false, reason: 'missing', status: 404 };
  }
  const basename = archiveDownloadFileName(path.basename(absPath));
  return { ok: true, absPath, basename };
}

export function formatArchiveBytesHe(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${Math.round(n)} ב`;
  const kb = n / 1024;
  const shown = kb >= 10 ? String(Math.round(kb)) : String(kb.toFixed(1)).replace(/\.0$/, '');
  return `${shown} ק״ב`;
}

/**
 * Start/stop operator feedback. Failed HTTP or ok:false never paints success.
 */
export function operatorArchiveFeedback({
  ok = true,
  httpOk = true,
  messageHe = null,
  warnHe = null,
  fallbackHe = ARCHIVE_COPY_HE.httpFail,
} = {}) {
  if (httpOk === false || ok === false) {
    return {
      kind: 'error',
      textHe: String(messageHe || fallbackHe || ARCHIVE_COPY_HE.httpFail),
      paintRecording: false,
    };
  }
  if (warnHe) {
    return { kind: 'warn', textHe: String(warnHe), paintRecording: true };
  }
  return {
    kind: 'ok',
    textHe: messageHe ? String(messageHe) : null,
    paintRecording: true,
  };
}

export function zeroByteStopWarn({ closed = null } = {}) {
  if (!closed) return { empty: false, warnHe: null };
  const bytes = Number(closed.bytes);
  const empty = !Number.isFinite(bytes) || bytes <= 0;
  return {
    empty,
    warnHe: empty ? ARCHIVE_COPY_HE.stopEmpty : null,
  };
}

/**
 * Tiny Mission cue while armed. Bytes are real session counters only.
 * Stalled when bytes stay flat for stallMs, or the link is down while recording.
 */
export function missionRecordCue({
  armed = false,
  bytes = null,
  lastBytes = null,
  lastChangeAt = 0,
  now = Date.now(),
  linkUp = null,
  stallMs = ARCHIVE_STALL_MS,
  lastWriteError = null,
} = {}) {
  if (!armed) {
    return { visible: false, stalled: false, labelHe: null, bytesHe: null };
  }
  const n = Number(bytes);
  const bytesHe = Number.isFinite(n) && n >= 0 ? formatArchiveBytesHe(n) : null;
  const flat = Number.isFinite(n)
    && Number.isFinite(lastBytes)
    && n === lastBytes
    && lastChangeAt > 0
    && (Number(now) - Number(lastChangeAt)) >= stallMs;
  const down = linkUp === false;
  const writeErr = Boolean(lastWriteError);
  const stalled = flat || down || writeErr;
  let labelHe = bytesHe;
  if (writeErr) labelHe = bytesHe ? `שגיאת כתיבה · ${bytesHe}` : 'שגיאת כתיבה';
  else if (down) labelHe = bytesHe ? `אין קישור · ${bytesHe}` : 'אין קישור';
  else if (flat) labelHe = bytesHe ? `תקוע · ${bytesHe}` : 'תקוע';
  return { visible: true, stalled, labelHe, bytesHe };
}

export function snapshotRecordingState({
  armed = false,
  session = null,
  lastWriteError = null,
  droppedWrites = 0,
} = {}) {
  return {
    armed: !!armed,
    session: session
      ? {
          storedPath: session.storedPath || null,
          bytes: Number(session.bytes) || 0,
          frames: Number(session.frames) || 0,
          linkRole: session.linkRole === 'cellular' ? 'cellular' : 'radio',
          rowId: session.rowId == null ? null : Number(session.rowId),
        }
      : null,
    lastWriteError: lastWriteError
      ? {
          message: String(lastWriteError.message || lastWriteError),
          at: lastWriteError.at == null ? null : Number(lastWriteError.at),
        }
      : null,
    droppedWrites: Number(droppedWrites) || 0,
    noteHe: armed
      ? 'הקלטה פעילה. באית נשמרת לארכיון.'
      : 'אין הקלטה. חיבור לבד לא שומר טיסה.',
  };
}

/**
 * Close leftover telemetry_archive rows after a process restart.
 * Sets ended_at and marks downlink_state interrupted. Does not invent bytes.
 */
export function finalizeOrphanArchiveRows(db, { reason = 'interrupted' } = {}) {
  if (!db) return { finalized: 0, rowIds: [] };
  try {
    const rows = db.prepare(`SELECT id FROM telemetry_archive WHERE ended_at IS NULL`).all();
    if (!rows.length) return { finalized: 0, rowIds: [] };
    const upd = db.prepare(
      `UPDATE telemetry_archive
       SET ended_at = datetime('now'), downlink_state = ?
       WHERE id = ? AND ended_at IS NULL`,
    );
    const rowIds = [];
    const apply = () => {
      for (const row of rows) {
        upd.run(reason, row.id);
        rowIds.push(Number(row.id));
      }
    };
    if (typeof db.transaction === 'function') db.transaction(apply)();
    else apply();
    return { finalized: rowIds.length, rowIds };
  } catch {
    return { finalized: 0, rowIds: [] };
  }
}

export function describeTelemetryArchive({
  rootDir = dataDir,
  queue = null,
  modemPresent = false,
  recording = null,
} = {}) {
  const dir = resolveArchiveRoot(rootDir);
  const rec = snapshotRecordingState(recording || { armed: false, session: null });
  return {
    relativePath: TELEMETRY_ARCHIVE_REL,
    absolutePath: dir,
    schema: {
      files: '*.tlog — raw MAVLink bytes, one session per link',
      table: 'telemetry_archive',
      columns: [
        'id', 'flight_id', 'link_role', 'stored_path', 'bytes', 'frames',
        'started_at', 'ended_at', 'downlink_state',
      ],
    },
    priority: {
      flight: QUEUE_PRIORITIES.FLIGHT,
      archiveWrite: QUEUE_PRIORITIES.ARCHIVE_WRITE,
      downlinkSync: QUEUE_PRIORITIES.DOWNLINK_SYNC,
      note: 'Flight parse/send never waits on archive write or modem downlink.',
    },
    recording: rec,
    sessionBytes: rec.session ? Number(rec.session.bytes) || 0 : null,
    sessionFrames: rec.session ? Number(rec.session.frames) || 0 : null,
    lastWriteError: rec.lastWriteError,
    droppedWrites: Number(rec.droppedWrites) || 0,
    queue: queue ? queue.stats() : null,
    downlink: {
      live: false,
      modemPresent: !!modemPresent,
      stub: true,
      noteHe: modemPresent
        ? 'מודם זוהה. סנכרון יורד בתור נמוך ולא עוצר טלמטריית טיסה.'
        : 'מודם לא מחובר. ארכיון מקומי מוכן. סנכרון סלולר ממתין למודם.',
    },
  };
}

export function createTelemetryArchive({
  rootDir = dataDir,
  db = null,
  maxPending = 64,
  maxDownlink = 8,
} = {}) {
  const dir = ensureArchiveRoot(rootDir);
  const queue = createBackpressureQueue({ maxPending, maxDownlink });
  let current = null;
  let recordingArmed = false;
  let lastWriteError = null;
  let droppedWrites = 0;
  const orphans = finalizeOrphanArchiveRows(db);

  function recordingSnapshot() {
    return snapshotRecordingState({
      armed: recordingArmed,
      session: current,
      lastWriteError,
      droppedWrites,
    });
  }

  function rollbackOpen(handle, storedPath) {
    try { if (handle != null) fs.closeSync(handle); } catch { /* ignore */ }
    try { if (storedPath) fs.unlinkSync(storedPath); } catch { /* ignore */ }
  }

  function openSession({ linkRole = 'radio', flightId = null } = {}) {
    if (current) closeSession();
    const name = sessionFileName({ linkRole, id: String(Date.now()) });
    const storedPath = path.join(dir, name);
    let handle;
    try {
      handle = fs.openSync(storedPath, 'a');
    } catch (err) {
      throw err;
    }
    let rowId = null;
    try {
      if (db) {
        const ins = db.prepare(
          `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state)
           VALUES (?,?,?,?,?,?)`,
        ).run(flightId, linkRole === 'cellular' ? 'cellular' : 'radio', storedPath, 0, 0, 'local');
        rowId = Number(ins.lastInsertRowid);
      }
    } catch (err) {
      rollbackOpen(handle, storedPath);
      throw err;
    }
    current = { handle, storedPath, rowId, bytes: 0, frames: 0, linkRole };
    return current;
  }

  function startRecording({ linkRole = 'radio', flightId = null } = {}) {
    if (recordingArmed && current) {
      return { ok: true, already: true, session: current, recording: recordingSnapshot() };
    }
    try {
      const session = openSession({ linkRole, flightId });
      recordingArmed = true;
      lastWriteError = null;
      return { ok: true, already: false, session, recording: recordingSnapshot() };
    } catch (err) {
      recordingArmed = false;
      current = null;
      lastWriteError = { message: String(err.message || err), at: Date.now() };
      return {
        ok: false,
        already: false,
        session: null,
        error: String(err.message || err),
        recording: recordingSnapshot(),
      };
    }
  }

  function stopRecording() {
    try { drain({ maxJobs: 64 }); } catch (err) {
      lastWriteError = { message: String(err.message || err), at: Date.now() };
    }
    const closed = closeSession();
    recordingArmed = false;
    const empty = zeroByteStopWarn({ closed });
    return {
      ok: true,
      closed,
      empty: empty.empty,
      warnHe: empty.warnHe,
      recording: recordingSnapshot(),
    };
  }

  function discardRecording() {
    if (!current) {
      recordingArmed = false;
      return { ok: true, discarded: false, recording: recordingSnapshot() };
    }
    const storedPath = current.storedPath;
    const rowId = current.rowId;
    try { fs.closeSync(current.handle); } catch { /* ignore */ }
    current = null;
    recordingArmed = false;
    try { if (storedPath) fs.unlinkSync(storedPath); } catch { /* ignore */ }
    if (db && rowId) {
      try { db.prepare(`DELETE FROM telemetry_archive WHERE id = ?`).run(rowId); } catch { /* ignore */ }
    }
    return { ok: true, discarded: true, recording: recordingSnapshot() };
  }

  function appendRaw(buf) {
    if (!recordingArmed) return { accepted: false, reason: 'not_recording' };
    if (!current || !buf || !buf.length) return { accepted: false, reason: 'no_session' };
    const job = { kind: 'archive_write', buf };
    const result = queue.enqueue(QUEUE_PRIORITIES.ARCHIVE_WRITE, job);
    if (!result.accepted) {
      droppedWrites += 1;
      return result;
    }
    // Drain archive writes immediately but never on the MAVLink parse stack's account:
    // callers enqueue, then drain() from a timer / idle tick.
    return result;
  }

  function drain({ maxJobs = 16 } = {}) {
    let n = 0;
    while (n < maxJobs) {
      const job = queue.takeNext();
      if (!job) break;
      n += 1;
      if (job.kind === 'archive_write' && current?.handle && job.buf) {
        try {
          fs.writeSync(current.handle, job.buf);
          current.bytes += job.buf.length;
          current.frames += 1;
          if (db && current.rowId) {
            db.prepare(`UPDATE telemetry_archive SET bytes = ?, frames = ? WHERE id = ?`)
              .run(current.bytes, current.frames, current.rowId);
          }
          lastWriteError = null;
        } catch (err) {
          lastWriteError = { message: String(err.message || err), at: Date.now() };
        }
      }
      // downlink_sync jobs are stubs until the E3372 path is live.
    }
    return n;
  }

  function enqueueDownlink(payload = {}) {
    return queue.enqueue(QUEUE_PRIORITIES.DOWNLINK_SYNC, { kind: 'downlink_sync', payload });
  }

  function closeSession() {
    if (!current) return null;
    try { fs.closeSync(current.handle); } catch { /* ignore */ }
    if (db && current.rowId) {
      try {
        db.prepare(`UPDATE telemetry_archive SET ended_at = datetime('now'), bytes = ?, frames = ? WHERE id = ?`)
          .run(current.bytes, current.frames, current.rowId);
      } catch { /* ignore */ }
    }
    const closed = current;
    current = null;
    return closed;
  }

  return {
    dir,
    queue,
    openSession,
    appendRaw,
    drain,
    enqueueDownlink,
    closeSession,
    describe(modemPresent = false) {
      return describeTelemetryArchive({
        rootDir,
        queue,
        modemPresent,
        recording: recordingSnapshot(),
      });
    },
    hasSession() {
      return Boolean(current);
    },
    isRecording() {
      return recordingArmed;
    },
    recordingState() {
      return recordingSnapshot();
    },
    startRecording,
    stopRecording,
    discardRecording,
    bootOrphans: orphans,
  };
}
