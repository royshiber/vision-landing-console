import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  diffFcParamFile,
  listFcParamFiles,
  readFcParamFile,
  resolveFcParamFilesDir,
  saveFcParamFile,
  shouldRecordFcRead,
} from '../lib/fc-param-files.mjs';

describe('FC parameter file history', () => {
  it('saves read and write snapshots beside the database and lists metadata only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-param-files-'));
    const db = { name: path.join(dir, 'vision.sqlite') };
    const filesDir = resolveFcParamFilesDir(db);
    expect(filesDir).toBe(path.join(dir, 'fc-param-files'));
    expect(saveFcParamFile(filesDir, { source: 'read', params: {}, armed: false })).toBeNull();
    const read = saveFcParamFile(filesDir, {
      source: 'read',
      params: { EK3_ENABLE: 1, GPS_TYPE: 1 },
      armed: false,
    });
    const write = saveFcParamFile(filesDir, {
      source: 'write',
      params: { EK3_ENABLE: 0, GPS_TYPE: 1 },
      armed: null,
    });
    const listed = listFcParamFiles(filesDir);
    expect(listed.map((item) => item.id)).toEqual([write.id, read.id]);
    expect(listed[0].params).toBeUndefined();
    expect(listed[0]).toMatchObject({ source: 'write', count: 2, armed: null });
    expect(listed[1]).toMatchObject({ source: 'read', count: 2, armed: false });
    const full = readFcParamFile(filesDir, read.id);
    expect(full.params).toEqual({ EK3_ENABLE: 1, GPS_TYPE: 1 });
    expect(readFcParamFile(filesDir, '../vision.sqlite')).toBeNull();
    expect(readFcParamFile(filesDir, 'not-an-id')).toBeNull();
    expect(listed.some((item) => item.goodFlight || item.lastKnownGood)).toBe(false);
  });

  it('diffs against the current FC map and records a full read only from a live connected read', () => {
    const rows = diffFcParamFile(
      { EK3_ENABLE: 1, GPS_TYPE: 1, LAND_FLARE_ALT: 3 },
      { EK3_ENABLE: 1, GPS_TYPE: 0 },
    );
    expect(rows).toEqual([
      { key: 'EK3_ENABLE', currentText: '1', nextText: '1', changed: false },
      { key: 'GPS_TYPE', currentText: '0', nextText: '1', changed: true },
      { key: 'LAND_FLARE_ALT', currentText: 'חסר', nextText: '3', changed: true },
    ]);
    expect(diffFcParamFile({ EK3_ENABLE: 1 }, null)[0].currentText).toBe('לא ידוע');
    expect(shouldRecordFcRead({
      record: true,
      mavlinkConnected: true,
      connected: true,
      current: { EK3_ENABLE: 1 },
    })).toBe(true);
    expect(shouldRecordFcRead({
      record: false,
      mavlinkConnected: true,
      connected: true,
      current: { EK3_ENABLE: 1 },
    })).toBe(false);
    expect(shouldRecordFcRead({
      record: true,
      mavlinkConnected: false,
      connected: true,
      current: { EK3_ENABLE: 1 },
    })).toBe(false);
    expect(shouldRecordFcRead({
      record: true,
      mavlinkConnected: true,
      connected: true,
      current: {},
    })).toBe(false);
  });
});
