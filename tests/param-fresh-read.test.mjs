import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MavlinkConnection,
  MSG_PARAM_REQUEST_LIST,
  MSG_PARAM_REQUEST_READ,
  parseMavlinkStream,
} from '../lib/mavlink-connection.mjs';
import * as mavlinkConnection from '../lib/mavlink-connection.mjs';
import { openDatabase } from '../lib/db.mjs';
import { buildArduTargetDefaults } from '../lib/param-schema.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fakeLink() {
  const conn = new MavlinkConnection({
    id: 4,
    name: 'fresh',
    type: 'tcp',
    host: '127.0.0.1',
    port: 1,
  });
  conn.connected = true;
  conn.sysId = 1;
  conn.fcTargetCompId = 1;
  const frames = [];
  conn._socket = {
    write(buf) {
      frames.push(Buffer.from(buf));
    },
  };
  return { conn, frames };
}

function sentIds(frames) {
  const parsed = parseMavlinkStream(Buffer.concat(frames));
  return parsed.frames.map((frame) => frame.msgId);
}

describe('readParamsFresh', () => {
  it('sends PARAM_REQUEST_LIST and ignores values from the previous list', async () => {
    const { conn, frames } = fakeLink();
    const pending = conn.readParamsFresh({ timeoutMs: 1000 });
    conn.emit('param', { name: 'STALE', value: 1, count: 2, index: 9 });
    expect(conn.paramReadProgress()).toEqual({ reading: true, received: 0, expected: 0 });
    conn.emit('param', { name: 'A', value: 3, count: 2, index: 0 });
    expect(conn.paramReadProgress().received).toBe(1);
    expect(conn.paramReadProgress().expected).toBe(2);
    conn.emit('param', { name: 'B', value: 4, count: 2, index: 1 });
    const result = await pending;
    expect(result.fresh).toBe(true);
    expect(result.count).toBe(2);
    expect(result.paramCount).toBe(2);
    expect(result.current).toEqual({ A: 3, B: 4 });
    expect(result.current.STALE).toBeUndefined();
    expect(sentIds(frames)).toContain(MSG_PARAM_REQUEST_LIST);
    expect(conn.paramReadProgress().reading).toBe(false);
  });

  it('sends PARAM_REQUEST_READ for named keys', async () => {
    const { conn, frames } = fakeLink();
    const pending = conn.readParamsFresh({ keys: ['RTL_ALTITUDE'], timeoutMs: 1000 });
    conn.emit('param', { name: 'RTL_ALTITUDE', value: 150, count: 800, index: 40 });
    const result = await pending;
    expect(result.fresh).toBe(true);
    expect(result.count).toBe(1);
    expect(result.current.RTL_ALTITUDE).toBe(150);
    expect(sentIds(frames)).toContain(MSG_PARAM_REQUEST_READ);
    expect(sentIds(frames)).not.toContain(MSG_PARAM_REQUEST_LIST);
  });

  it('re-requests index 0 when its reply is dropped and keeps the rest', async () => {
    const count = 20;
    const { conn, frames } = fakeLink();
    const answered = new Set();
    const pump = setInterval(() => {
      const parsed = parseMavlinkStream(Buffer.concat(frames.length ? frames : [Buffer.alloc(0)]));
      for (const frame of parsed.frames) {
        if (frame.msgId !== MSG_PARAM_REQUEST_READ || frame.payload.length < 2) continue;
        const index = frame.payload.readInt16LE(0);
        if (index !== 0 || answered.has(index)) continue;
        answered.add(index);
        conn.emit('param', { name: 'P0000', value: 7, count, index: 0 });
      }
    }, 5);
    const pending = conn.readParamsFresh({ timeoutMs: 2500, quietMs: 40 });
    for (let index = 1; index < count; index += 1) {
      conn.emit('param', {
        name: `P${String(index).padStart(4, '0')}`,
        value: index + 1,
        count,
        index,
      });
    }
    expect(conn.paramReadProgress().received).toBe(count - 1);
    expect(conn.paramReadProgress().expected).toBe(count);
    try {
      const result = await pending;
      const reads = parseMavlinkStream(Buffer.concat(frames)).frames
        .filter((frame) => frame.msgId === MSG_PARAM_REQUEST_READ && frame.payload.length >= 2)
        .map((frame) => frame.payload.readInt16LE(0));
      expect(reads).toContain(0);
      expect(result.fresh).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.partial).toBe(false);
      expect(result.count).toBe(count);
      expect(result.paramCount).toBe(count);
      expect(result.missing).toEqual([]);
      expect(result.current.P0000).toBe(7);
      expect(result.current.P0001).toBe(2);
    } finally {
      clearInterval(pump);
    }
  });

  it('returns fresh false when the named value does not arrive', async () => {
    const { conn } = fakeLink();
    const result = await conn.readParamsFresh({ keys: ['RTL_ALTITUDE'], timeoutMs: 80 });
    expect(result.fresh).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.count).toBe(0);
  });

  async function readDropped({ ratio, accept, count = 1000 }) {
    const { conn, frames } = fakeLink();
    const dropCount = Math.max(1, Math.round(count * ratio));
    const dropped = [];
    for (let index = 1; index <= dropCount; index += 1) dropped.push(index);
    const drop = new Set(dropped);
    const answered = new Set();
    const pump = setInterval(() => {
      const parsed = parseMavlinkStream(Buffer.concat(frames.length ? frames : [Buffer.alloc(0)]));
      for (const frame of parsed.frames) {
        if (frame.msgId !== MSG_PARAM_REQUEST_READ || frame.payload.length < 2) continue;
        const index = frame.payload.readInt16LE(0);
        if (index < 0 || answered.has(index) || !accept(index)) continue;
        answered.add(index);
        conn.emit('param', {
          name: `P${String(index).padStart(4, '0')}`,
          value: index + 1,
          count,
          index,
        });
      }
    }, 5);
    const started = Date.now();
    const pending = conn.readParamsFresh({ timeoutMs: 2500, quietMs: 40 });
    for (let index = 0; index < count; index += 1) {
      if (drop.has(index)) continue;
      conn.emit('param', {
        name: `P${String(index).padStart(4, '0')}`,
        value: index + 1,
        count,
        index,
      });
    }
    try {
      const result = await pending;
      const reads = parseMavlinkStream(Buffer.concat(frames))
        .frames
        .filter((frame) => frame.msgId === MSG_PARAM_REQUEST_READ && frame.payload.length >= 2)
        .map((frame) => frame.payload.readInt16LE(0));
      return { result, elapsed: Date.now() - started, reads, dropped };
    } finally {
      clearInterval(pump);
    }
  }

  it('re-requests a 0.1% drop and recovers the full list', async () => {
    const { result, elapsed, reads, dropped } = await readDropped({ ratio: 0.001, accept: () => true });
    expect(dropped).toEqual([1]);
    expect(reads).toContain(1);
    expect(result.fresh).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.count).toBe(1000);
    expect(result.paramCount).toBe(1000);
    expect(result.missing).toEqual([]);
    expect(result.current.P0001).toBe(2);
    expect(elapsed).toBeLessThan(2000);
  });

  it('re-requests a 1% drop and recovers the full list', async () => {
    const { result, elapsed, reads, dropped } = await readDropped({ ratio: 0.01, accept: () => true });
    expect(dropped).toHaveLength(10);
    expect(reads).toEqual(expect.arrayContaining(dropped));
    expect(result.fresh).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.count).toBe(1000);
    expect(result.missing).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  });

  it('keeps a 5% drop after three quiet rounds when only half of the holes return', async () => {
    const { result, elapsed, reads } = await readDropped({
      ratio: 0.05,
      accept: (index) => index % 2 === 1,
    });
    expect(reads.filter((index) => index % 2 === 0).length).toBeGreaterThan(0);
    expect(result.fresh).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.count).toBe(975);
    expect(result.paramCount).toBe(1000);
    expect(result.missing).toHaveLength(25);
    expect(result.missing.every((row) => row.index % 2 === 0)).toBe(true);
    expect(result.current.P0001).toBe(2);
    expect(result.current.P0002).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  it('paces index re-requests in batches of 20 and counts the FC total', async () => {
    const { conn, frames } = fakeLink();
    conn.paramCount = 1346;
    const total = 600;
    const indices = Array.from({ length: total }, (_, index) => index);
    const readIndexes = () => parseMavlinkStream(Buffer.concat(frames.length ? frames : [Buffer.alloc(0)]))
      .frames
      .filter((frame) => frame.msgId === MSG_PARAM_REQUEST_READ && frame.payload.length >= 2)
      .map((frame) => frame.payload.readInt16LE(0));
    const pending = conn.readParamsFresh({ indices, timeoutMs: 4000, quietMs: 40 });
    expect(readIndexes()).toHaveLength(20);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mid = readIndexes().length;
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThanOrEqual(80);
    const answered = new Set();
    const pump = setInterval(() => {
      const parsed = parseMavlinkStream(Buffer.concat(frames.length ? frames : [Buffer.alloc(0)]));
      for (const frame of parsed.frames) {
        if (frame.msgId !== MSG_PARAM_REQUEST_READ || frame.payload.length < 2) continue;
        const index = frame.payload.readInt16LE(0);
        if (index < 0 || answered.has(index)) continue;
        answered.add(index);
        conn.emit('param', {
          name: `P${String(index).padStart(4, '0')}`,
          value: index + 1,
          count: 1346,
          index,
        });
      }
    }, 5);
    try {
      const result = await pending;
      const reads = readIndexes();
      expect(new Set(reads).size).toBe(total);
      expect(reads.length).toBeGreaterThan(512);
      expect(result.fresh).toBe(true);
      expect(result.partial).toBe(false);
      expect(result.count).toBe(total);
      expect(result.paramCount).toBe(1346);
      expect(result.missing).toEqual([]);
    } finally {
      clearInterval(pump);
    }
  });

  it('keeps the arrived values when the overall timeout fires with holes still open', async () => {
    const count = 1000;
    const arrived = 200;
    const { conn } = fakeLink();
    const started = Date.now();
    const pending = conn.readParamsFresh({ timeoutMs: 250, quietMs: 5000 });
    for (let index = 0; index < arrived; index += 1) {
      conn.emit('param', {
        name: `P${String(index).padStart(4, '0')}`,
        value: index + 1,
        count,
        index,
      });
    }
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.fresh).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.count).toBe(arrived);
    expect(result.paramCount).toBe(count);
    expect(result.missing).toHaveLength(count - arrived);
    expect(Object.keys(result.current)).toHaveLength(arrived);
    expect(result.current.P0000).toBe(1);
    expect(result.current.P0199).toBe(200);
  });
});

describe('POST /api/ardu/params/read', () => {
  const tmpPath = path.join(os.tmpdir(), `airvix-fresh-read-${process.pid}.sqlite`);
  let db;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the fresh dictionary, not the cached one', async () => {
    db = openDatabase(tmpPath);
    const intervalIds = [];
    const origSetInterval = globalThis.setInterval;
    globalThis.setInterval = function patchedSetInterval(...args) {
      const id = origSetInterval.apply(this, args);
      intervalIds.push(id);
      return id;
    };
    const readParamsFresh = vi.fn(async () => ({
      ok: true,
      fresh: true,
      timedOut: false,
      count: 1,
      paramCount: 1,
      current: { RTL_ALTITUDE: 150 },
    }));
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 1,
      params: { RTL_ALTITUDE: 100 },
      readParamsFresh,
      paramReadProgress: () => ({ reading: true, received: 1, expected: 400 }),
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue({ RTL_ALTITUDE: 100 });
    let registerCoreApi;
    try {
      ({ registerCoreApi } = await import('../lib/routes/core-api.mjs'));
    } finally {
      globalThis.setInterval = origSetInterval;
    }
    const app = express();
    app.use(express.json());
    registerCoreApi(app, {
      db,
      APP_VERSION: '0.0.0-test',
      getAppVersion: () => '0.0.0-test',
      upload: { single: () => (_req, _res, next) => next() },
      jetsonState: { lastSeen: null, missedBeats: 0, totalBeats: 0 },
      visionState: {},
      slamState: {},
      visionNavModeState: { mode: 'prior_mission_map' },
      companionService: null,
      arduTargetParams: { ...buildArduTargetDefaults() },
      visionProfileStore: {},
      arduCurrentParams: null,
    });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const cached = await fetch(`${base}/api/ardu/params`);
      const cachedBody = await cached.json();
      expect(cachedBody.current.RTL_ALTITUDE).toBe(100);
      expect(cachedBody.fresh).toBeUndefined();

      const fresh = await fetch(`${base}/api/ardu/params/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: true }),
      });
      const body = await fresh.json();
      expect(fresh.status).toBe(200);
      expect(body.fresh).toBe(true);
      expect(body.count).toBe(1);
      expect(body.current.RTL_ALTITUDE).toBe(150);
      expect(readParamsFresh).toHaveBeenCalledTimes(1);

      const progress = await fetch(`${base}/api/ardu/params/read-progress`);
      const progressBody = await progress.json();
      expect(progressBody.reading).toBe(true);
      expect(progressBody.received).toBe(1);
      expect(progressBody.expected).toBe(400);
    } finally {
      for (const id of intervalIds) clearInterval(id);
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(tmpPath, { force: true });
    }
  });
});
