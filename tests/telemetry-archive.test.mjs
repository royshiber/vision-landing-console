import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  createBackpressureQueue,
  QUEUE_PRIORITIES,
  createTelemetryArchive,
  describeTelemetryArchive,
  TELEMETRY_ARCHIVE_REL,
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
    const session = archive.openSession({ linkRole: 'radio' });
    expect(session.storedPath).toContain(`${path.sep}flights${path.sep}archive${path.sep}`);
    expect(session.storedPath).toMatch(/\.tlog$/);
    const buf = Buffer.from([0xfe, 0x09, 0x00]);
    expect(archive.appendRaw(buf).accepted).toBe(true);
    archive.drain();
    expect(fs.statSync(session.storedPath).size).toBeGreaterThan(0);
    archive.closeSession();
    const desc = describeTelemetryArchive({ rootDir: root, queue: archive.queue, modemPresent: false });
    expect(desc.relativePath).toBe(TELEMETRY_ARCHIVE_REL);
    expect(desc.downlink.stub).toBe(true);
    expect(desc.priority.flight).toBe(0);
    expect(desc.priority.downlinkSync).toBe(2);
  });
});
