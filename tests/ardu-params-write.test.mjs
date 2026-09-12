import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { buildArduTargetDefaults } from '../lib/param-schema.mjs';
import {
  WRITE_BULK_CAP,
  rejectIfOverBulkCap,
  resolveRequestedWriteParams,
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
  it('sends only requested dirty keys that differ from live FC params', () => {
    const items = selectChangedEditableParams(
      { LAND_SPEED: 75, EK3_ENABLE: 1 },
      { LAND_SPEED: 50, EK3_ENABLE: 1 },
    );
    expect(items).toEqual([{ param: 'LAND_SPEED', value: 75 }]);
  });

  it('sends requested keys when live dictionary is empty — does not invent current', () => {
    const items = selectChangedEditableParams({ LAND_SPEED: 75 }, {});
    expect(items).toEqual([{ param: 'LAND_SPEED', value: 75 }]);
  });

  it('returns empty when no dirty keys are requested', () => {
    expect(selectChangedEditableParams({}, { LAND_SPEED: 50, SR7_EXT_STAT: 2 })).toEqual([]);
    expect(selectChangedEditableParams(null, { LAND_SPEED: 50 })).toEqual([]);
    expect(selectChangedEditableParams(undefined, { LAND_SPEED: 50 })).toEqual([]);
  });

  it('does not walk the full target template when only one key is dirty', () => {
    const template = buildArduTargetDefaults();
    const live = { ...template, LAND_SPEED: 40, SR7_EXT_STAT: 2, SR8_POSITION: 4 };
    const items = selectChangedEditableParams({ LAND_SPEED: 91 }, live);
    expect(items).toEqual([{ param: 'LAND_SPEED', value: 91 }]);
    expect(items.some((i) => i.param.startsWith('SR'))).toBe(false);
    expect(items.some((i) => i.param.startsWith('SERIAL'))).toBe(false);
  });
});

describe('resolveRequestedWriteParams / rejectIfOverBulkCap', () => {
  it('reads only body.params and treats empty body as no dirty keys', () => {
    expect(resolveRequestedWriteParams({})).toEqual({});
    expect(resolveRequestedWriteParams(null)).toEqual({});
    expect(resolveRequestedWriteParams({ params: { LAND_SPEED: 91 } })).toEqual({ LAND_SPEED: 91 });
  });

  it('rejects over the hard cap unless confirmBulk is true', () => {
    const items = Array.from({ length: WRITE_BULK_CAP + 1 }, (_, i) => ({
      param: `P${i}`,
      value: i,
    }));
    const blocked = rejectIfOverBulkCap(items, false);
    expect(blocked?.code).toBe('bulk_cap');
    expect(blocked?.count).toBe(WRITE_BULK_CAP + 1);
    expect(blocked?.cap).toBe(40);
    expect(rejectIfOverBulkCap(items, true)).toBeNull();
    expect(rejectIfOverBulkCap(items.slice(0, WRITE_BULK_CAP), false)).toBeNull();
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* wal */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* shm */ }
  });

  it('empty body writes nothing and does not call setParam', async () => {
    const setParam = vi.fn(async (param, value) => ({ ok: true, param, value }));
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 1,
      params: { LAND_SPEED: 50, SR7_EXT_STAT: 2, SERIAL5_PROTOCOL: 2 },
      setParam,
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue({
      LAND_SPEED: 50,
      SR7_EXT_STAT: 2,
      SERIAL5_PROTOCOL: 2,
    });

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
      expect(body.written).toBe(0);
      expect(body.message).toBe('אין שינוי');
      expect(setParam).not.toHaveBeenCalled();
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('writes only dirty keys from body.params', async () => {
    const setParam = vi.fn(async (param, value) => ({ ok: true, param, value }));
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 1,
      params: { LAND_SPEED: 50, SR7_EXT_STAT: 2, SR8_POSITION: 4 },
      setParam,
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue({
      LAND_SPEED: 50,
      SR7_EXT_STAT: 2,
      SR8_POSITION: 4,
    });

    const handle = await startCoreApi(db, {
      arduTargetParams: { ...buildArduTargetDefaults(), LAND_SPEED: 91 },
    });
    try {
      const res = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { LAND_SPEED: 91 } }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.simulated).toBe(false);
      expect(body.via).toBe('mavlink');
      expect(body.written).toBe(1);
      expect(setParam).toHaveBeenCalledTimes(1);
      expect(setParam).toHaveBeenCalledWith('LAND_SPEED', 91, expect.objectContaining({ timeoutMs: 4000 }));
      expect(body.verified.LAND_SPEED).toBe(91);
      expect(setParam.mock.calls.some((c) => String(c[0]).startsWith('SR'))).toBe(false);
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('aborts when dirty items exceed the bulk cap without confirmBulk', async () => {
    const setParam = vi.fn(async (param, value) => ({ ok: true, param, value }));
    const defaults = buildArduTargetDefaults();
    const keys = Object.keys(defaults).slice(0, WRITE_BULK_CAP + 1);
    const live = Object.fromEntries(keys.map((k) => [k, -1]));
    const params = Object.fromEntries(keys.map((k) => [k, defaults[k]]));
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 1,
      params: live,
      setParam,
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue(live);

    const handle = await startCoreApi(db, {
      arduTargetParams: { ...defaults },
    });
    try {
      const res = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.code).toBe('bulk_cap');
      expect(body.count).toBeGreaterThan(WRITE_BULK_CAP);
      expect(setParam).not.toHaveBeenCalled();
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('writes over the cap when confirmBulk is true', async () => {
    const setParam = vi.fn(async (param, value) => ({ ok: true, param, value }));
    const params = {};
    for (let p = 1; p <= 8; p += 1) {
      params[`SERIAL${p}_PROTOCOL`] = 2;
      params[`SERIAL${p}_BAUD`] = 57;
      params[`SR${p}_EXT_STAT`] = 5;
      params[`SR${p}_POSITION`] = 10;
      params[`SR${p}_RC_CHAN`] = 5;
      params[`SR${p}_EXTRA1`] = 10;
    }
    expect(Object.keys(params).length).toBeGreaterThan(WRITE_BULK_CAP);
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: true,
      lastBaseMode: 0,
      id: 1,
      params: {},
      setParam,
    });
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockReturnValue({});

    const handle = await startCoreApi(db, {
      arduTargetParams: { ...buildArduTargetDefaults() },
    });
    try {
      const res = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params, confirmBulk: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(setParam).toHaveBeenCalled();
      expect(setParam.mock.calls.length).toBe(Object.keys(params).length);
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('labels simulated:true and writes only dirty keys when disconnected', async () => {
    const setParam = vi.fn();
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue({
      connected: false,
      lastBaseMode: 0,
      setParam,
    });
    const handle = await startCoreApi(db, { arduCurrentParams: { LAND_SPEED: 50 } });
    try {
      const empty = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const emptyBody = await empty.json();
      expect(empty.status).toBe(200);
      expect(emptyBody.written).toBe(0);
      expect(emptyBody.message).toBe('אין שינוי');
      expect(setParam).not.toHaveBeenCalled();

      const res = await fetch(`${handle.base}/api/ardu/params/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { LAND_SPEED: 91 } }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.simulated).toBe(true);
      expect(body.via).toBe('offline');
      expect(body.written).toBe(1);
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

describe('Parameters UI WRITE sends dirty keys only', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  it('pins APP_VERSION at 1.02.300 after dirty-only WRITE', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.300'");
    expect(pkg.version).toBe('1.02.300');
  });

  it('collects session-dirty params and posts them as body.params', () => {
    expect(js).toContain('function collectDirtyArduParams()');
    expect(js).toContain('function captureArduWriteBaseline()');
    expect(js).toContain('body: JSON.stringify({ params: dirtyParams })');
    expect(js).not.toMatch(/fetch\('\/api\/ardu\/params\/write'[\s\S]{0,220}body: '\{\}'/);
    expect(js).toContain("d.code === 'bulk_cap'");
    expect(js).toContain('WRITE לרחפן שולח רק מה שערכת בסשן זה');
  });
});
