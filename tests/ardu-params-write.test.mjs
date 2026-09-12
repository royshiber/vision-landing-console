import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import { buildArduTargetDefaults } from '../lib/param-schema.mjs';
import {
  selectChangedEditableParams,
  writeEditableParamsViaMavlink,
} from '../lib/ardu-params-write.mjs';
import * as mavlinkConnection from '../lib/mavlink-connection.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function emptyRouteCtx(db, arduTargetParams = { ...buildArduTargetDefaults() }) {
  return {
    db,
    APP_VERSION: '0.0.0-test',
    getAppVersion: () => '0.0.0-test',
    upload: { single: () => (_req, _res, next) => next() },
    jetsonState: { lastSeen: null, missedBeats: 0, totalBeats: 0 },
    visionState: {},
    slamState: {},
    visionNavModeState: { mode: 'prior_mission_map' },
    companionService: null,
    arduTargetParams,
    visionProfileStore: {},
    arduCurrentParams: null,
  };
}

async function startCoreApi(db, ctxExtra = {}) {
  const intervalIds = [];
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = function patchedSetInterval(...args) {
    const id = origSetInterval.apply(this, args);
    intervalIds.push(id);
    return id;
  };
  try {
    const { registerCoreApi } = await import('../lib/routes/core-api.mjs');
    const app = express();
    app.use(express.json());
    registerCoreApi(app, { ...emptyRouteCtx(db), ...ctxExtra });
    const server = await listen(app);
    const addr = server.address();
    return { server, base: `http://127.0.0.1:${addr.port}`, intervalIds };
  } finally {
    globalThis.setInterval = origSetInterval;
  }
}

async function stopCoreApi(handle) {
  for (const id of handle.intervalIds) clearInterval(id);
  if (handle.server) await new Promise((resolve) => handle.server.close(resolve));
}

describe('selectChangedEditableParams', () => {
  it('sends only values that differ from live FC params', () => {
    const items = selectChangedEditableParams(
      { LAND_SPEED: 75, EK3_ENABLE: 1 },
      { LAND_SPEED: 50, EK3_ENABLE: 1 },
    );
    expect(items).toEqual([{ param: 'LAND_SPEED', value: 75 }]);
  });

  it('sends all targets when live dictionary is empty — does not invent current', () => {
    const items = selectChangedEditableParams({ LAND_SPEED: 75 }, {});
    expect(items).toEqual([{ param: 'LAND_SPEED', value: 75 }]);
  });
});

describe('writeEditableParamsViaMavlink', () => {
  it('calls setParam per changed param and keeps per-param results', async () => {
    const setParam = vi.fn(async (param, value) => {
      if (param === 'EK3_ENABLE') throw new Error('PARAM_SET timeout for EK3_ENABLE');
      return { ok: true, param, value };
    });
    const r = await writeEditableParamsViaMavlink(
      { setParam },
      [
        { param: 'LAND_SPEED', value: 75 },
        { param: 'EK3_ENABLE', value: 1 },
      ],
    );
    expect(setParam).toHaveBeenCalledTimes(2);
    expect(setParam).toHaveBeenNthCalledWith(1, 'LAND_SPEED', 75, expect.objectContaining({ timeoutMs: 4000 }));
    expect(r.written).toEqual(['LAND_SPEED']);
    expect(r.failed).toEqual([{ param: 'EK3_ENABLE', error: 'PARAM_SET timeout for EK3_ENABLE' }]);
    expect(r.verified).toEqual({ LAND_SPEED: 75 });
  });
});

describe('POST /api/ardu/params/write', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-ardu-write-${Date.now()}.sqlite`);
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* wal */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* shm */ }
  });

  it('calls mavConn.setParam when MAVLink is connected and disarmed', async () => {
    const setParam = vi.fn(async (param, value) => ({ ok: true, param, value }));
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 1,
      params: { LAND_SPEED: 50 },
      setParam,
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue({ LAND_SPEED: 50 });

    const handle = await startCoreApi(db, {
      arduTargetParams: { ...buildArduTargetDefaults(), LAND_SPEED: 91 },
    });
    try {
      const res = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.simulated).toBe(false);
      expect(body.via).toBe('mavlink');
      expect(setParam).toHaveBeenCalled();
      expect(setParam.mock.calls.some((c) => c[0] === 'LAND_SPEED' && c[1] === 91)).toBe(true);
      expect(body.verified.LAND_SPEED).toBe(91);
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('labels simulated:true and does not call setParam when disconnected', async () => {
    const setParam = vi.fn();
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: false,
      lastBaseMode: 0,
      setParam,
    });
    const handle = await startCoreApi(db);
    try {
      const res = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.simulated).toBe(true);
      expect(body.via).toBe('offline');
      expect(setParam).not.toHaveBeenCalled();
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('GET live empty params does not invent a simulated current dictionary', async () => {
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 7,
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue({});
    const handle = await startCoreApi(db, { arduCurrentParams: { LAND_SPEED: 99 } });
    try {
      const res = await fetch(`${handle.base}/api/ardu/params`);
      const body = await res.json();
      expect(body.mavlinkConnected).toBe(true);
      expect(body.connected).toBe(false);
      expect(body.current).toBeNull();
      expect(body.paramCount).toBe(0);
      expect(body.current?.LAND_SPEED).toBeUndefined();
    } finally {
      await stopCoreApi(handle);
    }
  });
});
