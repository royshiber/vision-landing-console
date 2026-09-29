/**
 * Slider edits become a pending FC write: the write button enables, the
 * confirm lists old → new, and a SITL PARAM_SET read-back matches.
 * The SITL case skips unless RUN_SITL_E2E=1 and an arduplane binary exists.
 * Writes stay on loopback TCP 5760. No real flight controller.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.env.ARDUPLANE_SITL || '/tmp/ardupilot/build/sitl/bin/arduplane';
const SITL_ENABLED = process.env.RUN_SITL_E2E === '1' && fs.existsSync(BINARY);
const HOME = '32.0853,34.7818,15,90';
const children = [];

function track(child) {
  children.push(child);
  return child;
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}

afterAll(() => {
  for (const child of children) stopChild(child);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, host, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${host}:${port} did not open`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last != null && last !== false) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)?.slice(0, 500)}`);
}

function tail(buf, max = 4000) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  return text.length > max ? text.slice(-max) : text;
}

async function api(base, method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function startConsole(port, dbPath) {
  const logs = { out: Buffer.alloc(0) };
  const child = track(spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_PATH: dbPath,
      COMPANION_MODE: 'off',
      JETSON_COMPANION_BASE_URL: '',
      GEMINI_API_KEY: '',
    },
  }));
  const push = (chunk) => {
    logs.out = Buffer.concat([logs.out, chunk]).subarray(-16000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.logs = logs;
  return child;
}

describe('landing slider pending write', () => {
  let consoleProc = null;

  afterAll(() => {
    stopChild(consoleProc);
  });

  it('enables כתיבה לבקר, confirms the exact change, and does not report אין שינוי', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-slider-ui-${process.pid}.sqlite`);
    consoleProc = startConsole(port, dbPath);
    const base = `http://127.0.0.1:${port}`;
    await waitUntil(async () => {
      try {
        const health = await api(base, 'GET', '/api/health');
        return health.status === 200 ? true : null;
      } catch {
        return null;
      }
    }, 20000, 'console health');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let posts = 0;
    try {
      await page.addInitScript(() => {
        try {
          localStorage.removeItem('visionLandingProfile');
          sessionStorage.clear();
        } catch { /* ignore */ }
      });
      await page.route(/\/api\/ardu\/params(?:\?|$)/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            connected: true,
            mavlinkConnected: true,
            armed: false,
            paramCount: 1,
            current: { LAND_SPEED: 50 },
          }),
        });
      });
      await page.route(/\/api\/ardu\/params\/write$/, async (route) => {
        posts += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, verified: {}, message: 'אין שינוי' }),
        });
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.click('#arduReadBtn');
      await page.waitForFunction(() => (document.getElementById('arduWriteStatus')?.textContent || '').includes('הושלמה'));
      const slider = page.locator('#rng_approach_speed_ms');
      await slider.waitFor({ state: 'attached' });
      const before = await slider.inputValue();
      await slider.fill('29');
      await page.waitForFunction(() => document.getElementById('arduWriteBtn')?.disabled === false);
      const banner = await page.locator('#paramSyncBanner').innerText();
      expect(banner).toContain('יש שינוי');
      expect(banner).toContain('approach_speed_ms');
      expect(banner).toContain(before);
      expect(banner).toContain('29');
      expect(banner).not.toContain('אין שינוי');
      expect(await page.locator('#jetsonToolState').innerText()).toBe('יש שינוי');
      expect(await page.locator('#fcToolState').innerText()).toBe('יש שינוי');
      await page.click('#arduWriteBtn');
      await page.waitForSelector('#applyConfirmModal:not(.hidden)');
      const confirm = await page.locator('#applyConfirmBody').innerText();
      expect(await page.locator('#applyConfirmTitle').innerText()).toContain('כתיבה לבקר');
      expect(confirm).toContain('approach_speed_ms');
      expect(confirm).toContain(before);
      expect(confirm).toContain('29');
      await page.click('#applyConfirmOkBtn');
      await page.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('approach_speed_ms'));
      const result = await page.locator('#paramWriteResult').innerText();
      expect(result).toContain('approach_speed_ms');
      expect(result).toContain('29');
      expect(result).toContain('אומת');
      expect(result).not.toContain('אין שינוי');
      expect(posts).toBe(0);
      const saved = await api(base, 'GET', '/api/vision/config');
      expect(saved.json.profile.approach_speed_ms).toBe(29);
    } finally {
      await browser.close();
    }
  }, 60000);
});

describe.skipIf(!SITL_ENABLED)('slider write against ArduPlane SITL', () => {
  it('moves a slider, confirms, sends PARAM_SET, and the read-back matches', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-slider-sitl-${process.pid}.sqlite`);
    const sitlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-slider-sitl-'));
    const consoleProc = startConsole(port, dbPath);
    const sitlLogs = { out: Buffer.alloc(0) };
    const sitl = track(spawn(BINARY, [
      '--model', 'plane',
      '--speedup', '1',
      '--home', HOME,
      '--serial0', 'tcp:5760',
      '-w',
    ], {
      cwd: sitlDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sitlDir },
    }));
    const sitlPush = (chunk) => {
      sitlLogs.out = Buffer.concat([sitlLogs.out, chunk]).subarray(-12000);
    };
    sitl.stdout.on('data', sitlPush);
    sitl.stderr.on('data', sitlPush);
    const base = `http://127.0.0.1:${port}`;
    let browser = null;
    try {
      await waitUntil(async () => {
        try {
          const health = await api(base, 'GET', '/api/health');
          return health.status === 200 ? true : null;
        } catch {
          return null;
        }
      }, 20000, 'console health');
      await waitForPort(5760, '127.0.0.1', 30000);
      const connected = await api(base, 'POST', '/api/links/connect', {
        role: 'radio',
        type: 'tcp',
        host: '127.0.0.1',
        port: 5760,
        preset: 'simulator',
      });
      expect(connected.status, JSON.stringify(connected.json)).toBe(200);
      const id = connected.json.id;
      const live = await waitUntil(async () => {
        const { json } = await api(base, 'GET', `/api/connections/${id}/status`);
        const row = json?.connection?.liveStatus;
        if (!row?.simulator || row.armed !== false || !(Number(row.heartbeatCount) > 0)) return null;
        if (row.type !== 'tcp' || row.host !== '127.0.0.1' || row.port !== 5760) return null;
        return row;
      }, 45000, 'simulator heartbeat');
      expect(live.simulator).toBe(true);
      const sliderSpecs = {
        LIM_PITCH_CD: { min: 500, max: 4500, step: 50 },
        RLL2SRV_RMAX: { min: 0, max: 180, step: 1 },
        LIM_ROLL_CD: { min: 500, max: 6500, step: 50 },
        LAND_SPEED: { min: 10, max: 300, step: 1 },
      };
      const loaded = await waitUntil(async () => {
        const asked = await api(base, 'POST', `/api/connections/${id}/request-params`);
        if (asked.status !== 200) return null;
        const { json } = await api(base, 'GET', `/api/connections/${id}/params`);
        const bag = json?.params || {};
        const name = Object.keys(sliderSpecs).find((key) => Number.isFinite(Number(bag[key])));
        if (!name || Object.keys(bag).length < 50) return null;
        return { name, value: Number(bag[name]), count: Object.keys(bag).length };
      }, 90000, 'FC slider param');
      const param = loaded.name;
      const spec = sliderSpecs[param];
      const original = loaded.value;
      const stepped = original + spec.step;
      const next = stepped > spec.max ? original - spec.step : stepped;

      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(() => {
        try { localStorage.removeItem('visionLandingProfile'); } catch { /* ignore */ }
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.selectOption('#paramSubtabSelect', 'ardu-jetson');
      await page.click('#arduReadBtn');
      await page.waitForFunction(() => (document.getElementById('arduWriteStatus')?.textContent || '').includes('הושלמה'));
      await page.waitForSelector(`#ardu_rng_${param}`, { state: 'attached' });
      const slider = page.locator(`#ardu_rng_${param}`);
      await slider.evaluate((el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, next);
      await page.waitForFunction(() => document.getElementById('arduWriteBtn')?.disabled === false);
      const banner = await page.locator('#paramSyncBanner').innerText();
      expect(banner).toContain(param);
      expect(banner).toContain('יש שינוי');
      expect(banner).not.toContain('אין שינוי');
      await page.click('#arduWriteBtn');
      await page.waitForSelector('#applyConfirmModal:not(.hidden)');
      const confirm = await page.locator('#applyConfirmBody').innerText();
      expect(confirm).toContain(param);
      expect(confirm).toContain(String(next));
      await page.click('#applyConfirmOkBtn');
      await page.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('אומת'));
      const result = await page.locator('#paramWriteResult').innerText();
      expect(result).toContain(param);
      expect(result).toContain(String(next));
      expect(result).toContain('אומת');
      expect(result).not.toContain('נכשל');
      const seen = await waitUntil(async () => {
        const { json } = await api(base, 'GET', `/api/connections/${id}/params`);
        const value = Number(json?.params?.[param]);
        return Math.abs(value - next) < 0.02 ? value : null;
      }, 12000, `${param} read-back`);
      expect(Math.abs(seen - next)).toBeLessThan(0.02);
      await api(base, 'POST', '/api/ardu/params/write', { params: { [param]: original } });
    } catch (err) {
      throw new Error(`${err.message}\n${tail(sitlLogs.out)}\n${tail(consoleProc.logs?.out)}`);
    } finally {
      await browser?.close();
      await api(base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
      stopChild(sitl);
      stopChild(consoleProc);
    }
  }, 180000);
});
