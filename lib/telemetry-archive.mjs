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

export function snapshotRecordingState({ armed = false, session = null } = {}) {
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
    noteHe: armed
      ? 'הקלטה פעילה. באית נשמרת לארכיון.'
      : 'אין הקלטה. חיבור לבד לא שומר טיסה.',
  };
}

export function describeTelemetryArchive({
  rootDir = dataDir,
  queue = null,
  modemPresent = false,
  recording = null,
} = {}) {
  const dir = resolveArchiveRoot(rootDir);
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
    recording: snapshotRecordingState(recording || { armed: false, session: null }),
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

  function recordingSnapshot() {
    return snapshotRecordingState({ armed: recordingArmed, session: current });
  }

  function openSession({ linkRole = 'radio', flightId = null } = {}) {
    if (current) closeSession();
    const name = sessionFileName({ linkRole, id: String(Date.now()) });
    const storedPath = path.join(dir, name);
    const handle = fs.openSync(storedPath, 'a');
    let rowId = null;
    if (db) {
      const ins = db.prepare(
        `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state)
         VALUES (?,?,?,?,?,?)`,
      ).run(flightId, linkRole === 'cellular' ? 'cellular' : 'radio', storedPath, 0, 0, 'local');
      rowId = Number(ins.lastInsertRowid);
    }
    current = { handle, storedPath, rowId, bytes: 0, frames: 0, linkRole };
    return current;
  }

  function startRecording({ linkRole = 'radio', flightId = null } = {}) {
    if (recordingArmed && current) {
      return { ok: true, already: true, session: current, recording: recordingSnapshot() };
    }
    recordingArmed = true;
    const session = openSession({ linkRole, flightId });
    return { ok: true, already: false, session, recording: recordingSnapshot() };
  }

  function stopRecording() {
    try { drain({ maxJobs: 64 }); } catch { /* ignore */ }
    const closed = closeSession();
    recordingArmed = false;
    return { ok: true, closed, recording: recordingSnapshot() };
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
    if (!result.accepted) return result;
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
        } catch {
          /* disk errors must not throw into the flight path */
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
  };
}
