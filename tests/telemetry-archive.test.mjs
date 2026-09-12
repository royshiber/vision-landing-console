import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import {
  createBackpressureQueue,
  QUEUE_PRIORITIES,
  createTelemetryArchive,
  describeTelemetryArchive,
  TELEMETRY_ARCHIVE_REL,
  finalizeOrphanArchiveRows,
  operatorArchiveFeedback,
  missionRecordCue,
  zeroByteStopWarn,
  ARCHIVE_COPY_HE,
} from '../lib/telemetry-archive.mjs';

describe('telemetry archive backpressure', () => {
  it('never dequeues downlink before flight work', () => {
    const q = createBackpressureQueue({ maxPending: 32, maxDownlink: 4 });
    q.enqueue(QUEUE_PRIORITIES.DOWNLINK_SYNC, { kind: 'downlink', n: 1 });
    q.enqueue(QUEUE_PRIORITIES.ARCHIVE_WRITE, { kind: 'archive', n: 2 });
    q.enqueue(QUEUE_PRIORITIES.FLIGHT, { kind: 'flight', n: 3 });
    expect(q.takeNext()).toEqual({ kind: 'flight', n: 3 });
    expect(q.takeNext()).toEqual({ kind: 'archive', n: 2 });
    expect(q.takeNext()).toEqual({ kind: 'downlink', n: 1 });
  });

  it('sheds extra downlink instead of starving the flight bucket', () => {
    const q = createBackpressureQueue({ maxPending: 8, maxDownlink: 2 });
    expect(q.enqueue(QUEUE_PRIORITIES.FLIGHT, { kind: 'flight' }).accepted).toBe(true);
    expect(q.enqueue(QUEUE_PRIORITIES.DOWNLINK_SYNC, { a: 1 }).accepted).toBe(true);
    expect(q.enqueue(QUEUE_PRIORITIES.DOWNLINK_SYNC, { a: 2 }).accepted).toBe(true);
    const shed = q.enqueue(QUEUE_PRIORITIES.DOWNLINK_SYNC, { a: 3 });
    expect(shed.accepted).toBe(false);
    expect(shed.reason).toBe('downlink_backpressure');
    expect(q.takeNext().kind).toBe('flight');
  });

  it('writes a local tlog session under the dedicated flights path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-'));
    const archive = createTelemetryArchive({ rootDir: root, db: null });
    const started = archive.startRecording({ linkRole: 'radio' });
    const session = started.session;
    expect(session.storedPath).toContain(`${path.sep}flights${path.sep}archive${path.sep}`);
    expect(session.storedPath).toMatch(/\.tlog$/);
    const buf = Buffer.from([0xfe, 0x09, 0x00]);
    expect(archive.appendRaw(buf).accepted).toBe(true);
    archive.drain();
    expect(fs.statSync(session.storedPath).size).toBeGreaterThan(0);
    archive.stopRecording();
    const desc = describeTelemetryArchive({ rootDir: root, queue: archive.queue, modemPresent: false });
    expect(desc.relativePath).toBe(TELEMETRY_ARCHIVE_REL);
    expect(desc.downlink.stub).toBe(true);
    expect(desc.priority.flight).toBe(0);
    expect(desc.priority.downlinkSync).toBe(2);
  });

  it('defaults to not recording and rejects archive writes until Start', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-off-'));
    const archive = createTelemetryArchive({ rootDir: root, db: null });
    expect(archive.isRecording()).toBe(false);
    expect(archive.hasSession()).toBe(false);
    expect(archive.recordingState().armed).toBe(false);
    expect(archive.recordingState().session).toBeNull();
    expect(archive.appendRaw(Buffer.from([0xfe, 0x01])).accepted).toBe(false);
    expect(archive.appendRaw(Buffer.from([0xfe, 0x01])).reason).toBe('not_recording');
    const files = fs.readdirSync(path.join(root, 'flights', 'archive'));
    expect(files.filter((n) => n.endsWith('.tlog'))).toEqual([]);
    const desc = archive.describe(false);
    expect(desc.recording.armed).toBe(false);
    expect(desc.recording.session).toBeNull();
  });

  it('Start arms the sink and Stop finalizes the session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-gate-'));
    const archive = createTelemetryArchive({ rootDir: root, db: null });
    const start = archive.startRecording({ linkRole: 'radio' });
    expect(start.ok).toBe(true);
    expect(archive.isRecording()).toBe(true);
    expect(archive.hasSession()).toBe(true);
    expect(start.recording.armed).toBe(true);
    expect(start.session.storedPath).toMatch(/\.tlog$/);
    const buf = Buffer.from([0xfe, 0x09, 0x00, 0x01]);
    expect(archive.appendRaw(buf).accepted).toBe(true);
    archive.drain();
    expect(fs.statSync(start.session.storedPath).size).toBe(buf.length);
    const stop = archive.stopRecording();
    expect(stop.ok).toBe(true);
    expect(stop.closed.storedPath).toBe(start.session.storedPath);
    expect(stop.closed.bytes).toBe(buf.length);
    expect(archive.isRecording()).toBe(false);
    expect(archive.hasSession()).toBe(false);
    expect(archive.appendRaw(Buffer.from([0xfe, 0x02])).accepted).toBe(false);
    expect(archive.appendRaw(Buffer.from([0xfe, 0x02])).reason).toBe('not_recording');
    expect(fs.existsSync(start.session.storedPath)).toBe(true);
  });

  it('Stop writes ended_at on the SQLite index row', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-db-'));
    const dbPath = path.join(root, 'index.sqlite');
    const db = openDatabase(dbPath);
    const archive = createTelemetryArchive({ rootDir: root, db });
    const start = archive.startRecording({ linkRole: 'radio' });
    archive.appendRaw(Buffer.from([0xfe, 0x04]));
    archive.drain();
    const rowId = start.session.rowId;
    expect(rowId).toBeGreaterThan(0);
    const openRow = db.prepare('SELECT ended_at, bytes FROM telemetry_archive WHERE id = ?').get(rowId);
    expect(openRow.ended_at).toBeNull();
    archive.stopRecording();
    const closedRow = db.prepare('SELECT ended_at, bytes FROM telemetry_archive WHERE id = ?').get(rowId);
    expect(closedRow.ended_at).toBeTruthy();
    expect(closedRow.bytes).toBe(2);
    db.close();
  });

  it('discard removes the current session file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-discard-'));
    const archive = createTelemetryArchive({ rootDir: root, db: null });
    const start = archive.startRecording({ linkRole: 'radio' });
    archive.appendRaw(Buffer.from([0xfe]));
    archive.drain();
    const discarded = archive.discardRecording();
    expect(discarded.discarded).toBe(true);
    expect(archive.isRecording()).toBe(false);
    expect(fs.existsSync(start.session.storedPath)).toBe(false);
  });

  it('sets recordingArmed only after openSession succeeds and rolls back on failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-arm-'));
    const db = {
      prepare(sql) {
        if (String(sql).includes('INSERT')) throw new Error('insert fail');
        return { all: () => [], run: () => ({ lastInsertRowid: 0 }) };
      },
    };
    const archive = createTelemetryArchive({ rootDir: root, db });
    const start = archive.startRecording({ linkRole: 'radio' });
    expect(start.ok).toBe(false);
    expect(archive.isRecording()).toBe(false);
    expect(archive.hasSession()).toBe(false);
    expect(start.recording.armed).toBe(false);
    const files = fs.readdirSync(path.join(root, 'flights', 'archive'));
    expect(files.filter((n) => n.endsWith('.tlog'))).toEqual([]);
  });

  it('finalizes orphan telemetry_archive rows on boot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-orphan-'));
    const dbPath = path.join(root, 'index.sqlite');
    const db = openDatabase(dbPath);
    const ins = db.prepare(
      `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state)
       VALUES (?,?,?,?,?,?)`,
    ).run(null, 'radio', path.join(root, 'orphan.tlog'), 0, 0, 'local');
    const rowId = Number(ins.lastInsertRowid);
    expect(db.prepare('SELECT ended_at FROM telemetry_archive WHERE id = ?').get(rowId).ended_at).toBeNull();
    const archive = createTelemetryArchive({ rootDir: root, db });
    expect(archive.bootOrphans.finalized).toBe(1);
    const row = db.prepare('SELECT ended_at, downlink_state FROM telemetry_archive WHERE id = ?').get(rowId);
    expect(row.ended_at).toBeTruthy();
    expect(row.downlink_state).toBe('interrupted');
    const again = finalizeOrphanArchiveRows(db);
    expect(again.finalized).toBe(0);
    db.close();
  });

  it('zero-byte Stop still closes and warns that nothing was recorded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-empty-'));
    const archive = createTelemetryArchive({ rootDir: root, db: null });
    const start = archive.startRecording({ linkRole: 'radio' });
    const stop = archive.stopRecording();
    expect(stop.ok).toBe(true);
    expect(stop.closed.storedPath).toBe(start.session.storedPath);
    expect(stop.closed.bytes).toBe(0);
    expect(stop.empty).toBe(true);
    expect(stop.warnHe).toBe(ARCHIVE_COPY_HE.stopEmpty);
    expect(fs.existsSync(start.session.storedPath)).toBe(true);
    expect(zeroByteStopWarn({ closed: { bytes: 0 } }).empty).toBe(true);
    expect(zeroByteStopWarn({ closed: { bytes: 12 } }).warnHe).toBeNull();
  });

  it('records lastWriteError on drain failure and counts backpressure drops', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-err-'));
    const archive = createTelemetryArchive({ rootDir: root, db: null, maxPending: 1 });
    const start = archive.startRecording({ linkRole: 'radio' });
    expect(archive.appendRaw(Buffer.from([0xfe])).accepted).toBe(true);
    const dropped = archive.appendRaw(Buffer.from([0xfd]));
    expect(dropped.accepted).toBe(false);
    expect(dropped.reason).toBe('archive_backpressure');
    expect(archive.recordingState().droppedWrites).toBe(1);
    expect(archive.describe(false).droppedWrites).toBe(1);
    fs.closeSync(start.session.handle);
    archive.drain();
    expect(archive.recordingState().lastWriteError).toBeTruthy();
    expect(archive.recordingState().lastWriteError.message).toBeTruthy();
    archive.stopRecording();
  });
});

describe('archive honesty helpers', () => {
  it('never paints success when start/stop HTTP or ok is false', () => {
    const fail = operatorArchiveFeedback({
      ok: false,
      httpOk: true,
      messageHe: ARCHIVE_COPY_HE.startFail,
    });
    expect(fail.paintRecording).toBe(false);
    expect(fail.kind).toBe('error');
    expect(fail.textHe).toBe(ARCHIVE_COPY_HE.startFail);
    const http = operatorArchiveFeedback({ httpOk: false, messageHe: null });
    expect(http.paintRecording).toBe(false);
    expect(http.textHe).toBe(ARCHIVE_COPY_HE.httpFail);
    const warn = operatorArchiveFeedback({
      ok: true,
      httpOk: true,
      messageHe: ARCHIVE_COPY_HE.startOk,
      warnHe: ARCHIVE_COPY_HE.startNoLink,
    });
    expect(warn.paintRecording).toBe(true);
    expect(warn.kind).toBe('warn');
    expect(warn.textHe).toBe(ARCHIVE_COPY_HE.startNoLink);
  });

  it('builds a stall cue from real bytes only', () => {
    const idle = missionRecordCue({ armed: false, bytes: 12 });
    expect(idle.visible).toBe(false);
    expect(idle.labelHe).toBeNull();
    const live = missionRecordCue({ armed: true, bytes: 128, lastBytes: 64, lastChangeAt: 1, now: 2, linkUp: true });
    expect(live.visible).toBe(true);
    expect(live.stalled).toBe(false);
    expect(live.labelHe).toBe('128 ב');
    const stall = missionRecordCue({
      armed: true,
      bytes: 128,
      lastBytes: 128,
      lastChangeAt: 1,
      now: 9000,
      linkUp: true,
    });
    expect(stall.stalled).toBe(true);
    expect(stall.labelHe).toMatch(/תקוע/);
    const down = missionRecordCue({ armed: true, bytes: 0, lastBytes: 0, lastChangeAt: 1, now: 2, linkUp: false });
    expect(down.stalled).toBe(true);
    expect(down.labelHe).toMatch(/אין קישור/);
    expect(down.bytesHe).toBe('0 ב');
  });
});
