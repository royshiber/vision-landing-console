import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { buildArduTargetDefaults } from '../lib/param-schema.mjs';
import { emptyParamList, noteParamListValue, fcFormReadout } from '../lib/fc-param-read.mjs';
import {
  MavlinkConnection,
  parseMavlinkFrames,
  MSG_PARAM_REQUEST_LIST,
  MSG_PARAM_SET,
} from '../lib/mavlink-connection.mjs';
import * as mavlinkConnection from '../lib/mavlink-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function appReadout() {
  const src = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
  const start = src.indexOf('function fcValuesDiffer');
  const end = src.indexOf('function arduFieldReadout');
  const chunk = src.slice(start, end);
  return new Function(`${chunk}\nreturn fcFormReadout;`)();
}

describe('fc param list', () => {
  it('stays incomplete until every announced name arrives', () => {
    let bucket = noteParamListValue(emptyParamList(), { name: 'LAND_SPEED', value: 77, count: 2 });
    expect(bucket.complete).toBe(false);
    expect(bucket.values).toEqual({ LAND_SPEED: 77 });
    bucket = noteParamListValue(bucket, { name: 'LIM_PITCH_CD', value: 1500, count: 2 });
    expect(bucket.complete).toBe(true);
    expect(bucket.values.GONE).toBeUndefined();
  });

  it('does not invent a value for a name that is not in the list', () => {
    const live = fcFormReadout({ LAND_SPEED: 77 }, 'LAND_SPEED', 50);
    expect(live).toEqual({ state: 'live', live: 77, saved: 50 });
    const same = fcFormReadout({ LAND_SPEED: 50 }, 'LAND_SPEED', 50);
    expect(same.saved).toBeNull();
    const missing = fcFormReadout({ LAND_SPEED: 77 }, 'NOT_ON_FW', 50);
    expect(missing.state).toBe('missing');
    expect(missing.live).toBeNull();
    expect(missing.saved).toBe(50);
    expect(fcFormReadout(null, 'LAND_SPEED', 50).state).toBe('unread');
  });
});

describe('קריאה on the params page', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
  const readFn = src.slice(src.indexOf('async function readFcParams'), src.indexOf('if (arduReadBtn)'));
  const missingCard = src.slice(src.indexOf('function renderArduMissingCard'), src.indexOf('function renderArduFieldCard'));
  const card = src.slice(src.indexOf('function renderArduFieldCard'), src.indexOf('function renderArduParamForm'));

  it('fails when קריאה only reads the cache', () => {
    expect(readFn).toContain('/api/ardu/params?record=1&fresh=1');
    expect(readFn).not.toMatch(/fetch\('\/api\/ardu\/params\?record=1'\)/);
    expect(readFn).toContain('d.fresh === false');
    expect(readFn).not.toMatch(/\/api\/ardu\/params\/write|PARAM_SET|setParam/);
  });

  it('shows the live value and does not paint a missing name as a number', () => {
    const fromApp = appReadout();
    expect(fromApp({ LAND_SPEED: 77 }, 'LAND_SPEED', 50)).toEqual(fcFormReadout({ LAND_SPEED: 77 }, 'LAND_SPEED', 50));
    expect(fromApp({ LAND_SPEED: 77 }, 'NOT_ON_FW', 50).live).toBeNull();
    expect(card).toContain('arduControlValue(f)');
    expect(card).toContain("state === 'missing'");
    expect(card).toContain('${savedHtml}');
    expect(card).not.toMatch(/const v = isVirtual \? companionLinkState\[f\.key\] : arduTargetState\[f\.key\]/);
    const savedHtml = src.slice(src.indexOf('function arduSavedTargetHtml'), src.indexOf('function renderArduFcPresenceBadge'));
    expect(missingCard).toContain('חסר');
    expect(missingCard).toContain('arduSavedTargetHtml');
    expect(savedHtml).toContain('יעד שמור');
    expect(missingCard).not.toContain('<input');
    expect(missingCard).not.toContain('<select');
    expect(missingCard).not.toContain('arduTargetState');
  });
});

describe('requestParamList', () => {
  it('sends PARAM_REQUEST_LIST, replaces the cache, and does not send PARAM_SET', async () => {
    const conn = new MavlinkConnection({ id: 1, type: 'tcp', host: '127.0.0.1', port: 5760 });
    conn.connected = true;
    conn.sysId = 1;
    conn.params = { LAND_SPEED: 50, GONE: 1 };
    conn._socket = { write() {} };
    const frames = [];
    const setParam = vi.spyOn(conn, 'setParam');
    conn._send = (buf) => { frames.push(buf); };
    const pending = conn.requestParamList({ timeoutMs: 500 });
    conn.emit('param', { name: 'LAND_SPEED', value: 77, count: 2 });
    conn.emit('param', { name: 'LIM_PITCH_CD', value: 1500, count: 2 });
    const listed = await pending;
    expect(listed.complete).toBe(true);
    expect(listed.params).toEqual({ LAND_SPEED: 77, LIM_PITCH_CD: 1500 });
    expect(conn.params.GONE).toBeUndefined();
    expect(setParam).not.toHaveBeenCalled();
    const parsed = parseMavlinkFrames(Buffer.concat(frames));
    expect(parsed.map((frame) => frame.msgId)).toEqual([MSG_PARAM_REQUEST_LIST]);
    expect(parsed.some((frame) => frame.msgId === MSG_PARAM_SET)).toBe(false);
  });

  it('leaves the cache in place when the list does not finish', async () => {
    const conn = new MavlinkConnection({ id: 2, type: 'tcp', host: '127.0.0.1', port: 5760 });
    conn.connected = true;
    conn.params = { LAND_SPEED: 50, GONE: 1 };
    conn._socket = { write() {} };
    conn._send = () => {};
    const pending = conn.requestParamList({ timeoutMs: 30 });
    conn.emit('param', { name: 'LAND_SPEED', value: 77, count: 2 });
    await expect(pending).rejects.toMatchObject({ code: 'incomplete' });
    expect(conn.params).toEqual({ LAND_SPEED: 50, GONE: 1 });
  });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function startCoreApi(db) {
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

function startUiServer(port) {
  const sqlite = path.join(os.tmpdir(), `airvix-fc-read-ui-${port}.sqlite`);
  fs.rmSync(sqlite, { force: true });
  return spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: sqlite,
      GEMINI_API_KEY: '',
      COMPANION_MODE: 'off',
    },
    stdio: 'ignore',
  });
}

async function waitHealth(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy at ${base}`);
}

describe('params page קריאה', () => {
  const port = 4046;
  const base = `http://127.0.0.1:${port}`;
  let serverProc = null;

  afterAll(() => {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  it('shows the live FC value, keeps the saved target beside it, and marks a missing name', async () => {
    serverProc = startUiServer(port);
    await waitHealth(base);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const reads = [];
    let writes = 0;
    try {
      await page.addInitScript(() => {
        try { sessionStorage.clear(); localStorage.clear(); } catch { /* ignore */ }
      });
      await page.route(/\/api\/ardu\/params(?:\?|$)/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        const fresh = route.request().url().includes('fresh=1');
        reads.push(route.request().url());
        const body = fresh
          ? {
            ok: true,
            fresh: true,
            complete: true,
            connected: true,
            mavlinkConnected: true,
            armed: false,
            paramCount: 1,
            current: { SR4_EXT_STAT: 10 },
          }
          : {
            ok: true,
            fresh: false,
            connected: true,
            mavlinkConnected: true,
            armed: false,
            paramCount: 2,
            current: { SR4_EXT_STAT: 5, LAND_SPEED: 50 },
          };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      });
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/api/ardu/params/write')) writes += 1;
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.selectOption('#paramSubtabSelect', 'ardu-jetson');
      await page.waitForSelector('#ardu_rng_SR4_EXT_STAT');
      expect(await page.locator('#ardu_rng_SR4_EXT_STAT').inputValue()).toBe('5');
      expect(await page.locator('[data-ardu-key="LAND_SPEED"] input').count()).toBeGreaterThan(0);
      await page.click('#arduReadBtn');
      await page.waitForFunction(() => (document.getElementById('arduWriteStatus')?.textContent || '').includes('הושלמה'));
      expect(reads.some((url) => url.includes('fresh=1'))).toBe(true);
      expect(await page.locator('#ardu_rng_SR4_EXT_STAT').inputValue()).toBe('10');
      expect(await page.locator('#ardu_val_SR4_EXT_STAT').innerText()).toBe('10');
      const saved = await page.locator('article[data-ardu-key="SR4_EXT_STAT"] .ardu-saved-target').innerText();
      expect(saved).toContain('יעד שמור');
      expect(saved).toContain('5');
      const missing = page.locator('[data-ardu-key="LAND_SPEED"]');
      expect(await missing.getAttribute('data-fc-state')).toBe('missing');
      expect(await missing.locator('input, select').count()).toBe(0);
      const missingText = await missing.innerText();
      expect(missingText).toContain('חסר');
      expect(missingText).toContain('יעד שמור');
      expect(missingText).toContain('50');
      expect(missingText).not.toMatch(/חסר\s*50/);
      expect(writes).toBe(0);
      const fit = await page.locator('article[data-ardu-key="SR4_EXT_STAT"]').evaluate((el) => {
        const nodes = [...el.querySelectorAll('.param-value, .ardu-saved-target, .param-title, .ardu-fc-presence')];
        return nodes.filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)
          .map((node) => node.textContent);
      });
      expect(fit).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60000);
});

describe('GET /api/ardu/params?fresh=1', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-fc-read-${Date.now()}.sqlite`);
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

  it('does not return the in-memory cache', async () => {
    const setParam = vi.fn();
    const conn = {
      connected: true,
      id: 7,
      lastBaseMode: 0,
      params: { LAND_SPEED: 50, GONE: 1 },
      setParam,
      requestParamList: vi.fn(async () => ({
        params: { LAND_SPEED: 77 },
        count: 1,
        complete: true,
      })),
    };
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue(conn);
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockImplementation(() => conn.params);

    const handle = await startCoreApi(db);
    try {
      const stale = await fetch(`${handle.base}/api/ardu/params?record=1`);
      const staleJson = await stale.json();
      expect(stale.status).toBe(200);
      expect(staleJson.current.LAND_SPEED).toBe(50);
      expect(staleJson.current.GONE).toBe(1);
      expect(staleJson.fresh).toBe(false);
      expect(conn.requestParamList).not.toHaveBeenCalled();

      const fresh = await fetch(`${handle.base}/api/ardu/params?record=1&fresh=1`);
      const freshJson = await fresh.json();
      expect(fresh.status).toBe(200);
      expect(conn.requestParamList).toHaveBeenCalledTimes(1);
      expect(freshJson.fresh).toBe(true);
      expect(freshJson.complete).toBe(true);
      expect(freshJson.current).toEqual({ LAND_SPEED: 77 });
      expect(freshJson.current.GONE).toBeUndefined();
      expect(setParam).not.toHaveBeenCalled();
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('does not publish a partial list as the firmware', async () => {
    const conn = {
      connected: true,
      id: 7,
      lastBaseMode: 0,
      params: { LAND_SPEED: 50, GONE: 1 },
      setParam: vi.fn(),
      requestParamList: vi.fn(async () => {
        const err = new Error('הקריאה לא הושלמה');
        err.code = 'incomplete';
        throw err;
      }),
    };
    vi.spyOn(mavlinkConnection, 'getActiveConnection').mockReturnValue(conn);
    vi.spyOn(mavlinkConnection, 'getConnectionParams').mockImplementation(() => conn.params);
    const handle = await startCoreApi(db);
    try {
      const fresh = await fetch(`${handle.base}/api/ardu/params?fresh=1`);
      const body = await fresh.json();
      expect(fresh.status).toBe(504);
      expect(body.current).toBeNull();
      expect(body.complete).toBe(false);
      const cache = await fetch(`${handle.base}/api/ardu/params`);
      const cached = await cache.json();
      expect(cached.current.GONE).toBe(1);
      expect(cached.current.LAND_SPEED).toBe(50);
      expect(conn.setParam).not.toHaveBeenCalled();
    } finally {
      await stopCoreApi(handle);
    }
  });
});
