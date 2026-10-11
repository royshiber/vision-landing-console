/**
 * READ must replace a dirty field with the flight controller value.
 * Runs only when RUN_SITL_E2E=1 and an arduplane binary exists.
 * Writes stay on loopback SITL. No ARM, DISARM, LAND, or real flight controller.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './test-server.mjs';
import { claimSitlInstance, sitlMavlinkPort, sitlSidePorts } from './sitl-instance.mjs';
import {
  buildMavlink2Frame,
  buildParamSetPayload,
  MAV_PARAM_TYPE,
  MSG_PARAM_REQUEST_LIST,
  MSG_PARAM_REQUEST_READ,
  parseMavlinkStream,
} from '../lib/mavlink-connection.mjs';

const BINARY = process.env.ARDUPLANE_SITL || '/tmp/ardupilot/build/sitl/bin/arduplane';
const ENABLED = process.env.RUN_SITL_E2E === '1' && fs.existsSync(BINARY);
const HOME = '32.0853,34.7818,15,90';
const PARAM = 'WP_RADIUS';
const children = [];

function track(child) {
  children.push(child);
  return child;
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

afterAll(() => {
  for (const child of children) stopChild(child);
});

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

async function pageState(page) {
  return page.evaluate(() => ({
    status: document.getElementById('arduWriteStatus')?.textContent || '',
    writeDisabled: document.getElementById('arduWriteBtn')?.disabled ?? null,
    writeTitle: document.getElementById('arduWriteBtn')?.title || '',
    banner: document.getElementById('paramSyncBanner')?.innerText || '',
    field: document.querySelector('#fcGroupList [data-param-key="WP_RADIUS"] .fc-group-next')?.value || '',
    fieldDisabled: document.querySelector('#fcGroupList [data-param-key="WP_RADIUS"] .fc-group-next')?.disabled ?? null,
    fault: document.getElementById('paramToolFaultText')?.textContent || '',
    result: document.getElementById('paramWriteResult')?.innerText || '',
  })).catch((err) => ({ evaluate: err.message }));
}

async function waitPage(page, fn, arg, timeout, label) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (err) {
    const state = await pageState(page);
    throw new Error(`${label}: ${err.message} ${JSON.stringify(state)}`);
  }
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

function startTap(listenPort, upstreamPort) {
  const counts = { request: 0 };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
    const fail = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseMavlinkStream(buf);
      buf = buf.subarray(parsed.consumed);
      for (const frame of parsed.frames) {
        if (frame.msgId === MSG_PARAM_REQUEST_LIST || frame.msgId === MSG_PARAM_REQUEST_READ) {
          counts.request += 1;
        }
      }
      if (!upstream.destroyed) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!socket.destroyed) socket.write(chunk);
    });
    socket.on('error', fail);
    upstream.on('error', fail);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      resolve({
        counts,
        reset() { counts.request = 0; },
        close() { server.close(); },
      });
    });
  });
}

function gcsHeartbeat(seq) {
  const payload = Buffer.alloc(9);
  payload.writeUInt32LE(0, 0);
  payload[4] = 6;
  payload[5] = 8;
  payload[6] = 0;
  payload[7] = 4;
  payload[8] = 3;
  return buildMavlink2Frame(0, payload, seq);
}

function paramNameFromValue(payload) {
  if (!payload || payload.length < 9) return null;
  const name = payload.slice(8, payload.length - 1).toString('utf8').replace(/\0/g, '').trim();
  if (!name) return null;
  return { name, value: payload.readFloatLE(0) };
}

async function setParamOnLink(port, name, value) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buf = Buffer.alloc(0);
  let seq = 0;
  const echo = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no PARAM_VALUE echo for ${name} on ${port}`)), 10000);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseMavlinkStream(buf);
      buf = buf.subarray(parsed.consumed);
      for (const frame of parsed.frames) {
        if (frame.msgId !== 22) continue;
        const row = paramNameFromValue(frame.payload);
        if (row?.name === name && Math.abs(row.value - value) < 0.05) {
          clearTimeout(timer);
          resolve(row.value);
        }
      }
    });
  });
  const beat = setInterval(() => {
    if (!socket.destroyed) socket.write(gcsHeartbeat(seq));
    seq += 1;
  }, 400);
  socket.write(gcsHeartbeat(seq));
  seq += 1;
  const payload = buildParamSetPayload(name, value, MAV_PARAM_TYPE.REAL32, 1, 1);
  socket.write(buildMavlink2Frame(23, payload, seq));
  try {
    return await echo;
  } finally {
    clearInterval(beat);
    socket.destroy();
  }
}

describe.skipIf(!ENABLED)('params tab fresh READ against ArduPlane SITL', () => {
  it('writes WP_RADIUS, drops a later edit on READ, and shows a direct SITL change', async () => {
    const dbPath = path.join(os.tmpdir(), `airvix-fresh-read-sitl-${process.pid}.sqlite`);
    const sitlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-fresh-read-sitl-'));
    const sitlSlot = claimSitlInstance();
    const sitlPort = await sitlMavlinkPort(sitlSlot.instance);
    const tapPort = await sitlMavlinkPort(sitlSlot.instance);
    const sidePort = sitlSidePorts(sitlSlot.instance)[0];
    const tap = await startTap(tapPort, sitlPort);
    const consoleProc = await startTestServer({
      env: {
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        GEMINI_API_KEY: '',
        SIMULATOR_TCP_PORT: String(tapPort),
      },
    });
    track(consoleProc.child);
    const base = consoleProc.base;
    const sitlLogs = { out: Buffer.alloc(0) };
    const sitl = track(spawn(BINARY, [
      '-I', String(sitlSlot.instance),
      '--model', 'plane',
      '--speedup', '1',
      '--home', HOME,
      '--serial0', `tcp:${sitlPort}`,
      '-w',
    ], {
      cwd: sitlDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sitlDir },
    }));
    const push = (chunk) => {
      sitlLogs.out = Buffer.concat([sitlLogs.out, chunk]).subarray(-12000);
    };
    sitl.stdout.on('data', push);
    sitl.stderr.on('data', push);
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
      await waitForPort(sitlPort, '127.0.0.1', 30000);
      const connected = await api(base, 'POST', '/api/links/connect', {
        role: 'radio',
        type: 'tcp',
        host: '127.0.0.1',
        port: tapPort,
        simulatorPort: tapPort,
        preset: 'simulator',
      });
      expect(connected.status, JSON.stringify(connected.json)).toBe(200);
      const id = connected.json.id;
      const live = await waitUntil(async () => {
        const { json } = await api(base, 'GET', `/api/connections/${id}/status`);
        const row = json?.connection?.liveStatus;
        if (!row?.simulator || row.armed !== false || !(Number(row.heartbeatCount) > 0)) return null;
        if (row.type !== 'tcp' || row.host !== '127.0.0.1' || row.port !== tapPort) return null;
        return row;
      }, 45000, 'simulator heartbeat');
      expect(live.simulator).toBe(true);

      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      let overwriteAsked = '';
      page.on('dialog', async (dialog) => {
        overwriteAsked = dialog.message();
        await dialog.accept();
      });
      await page.addInitScript(() => {
        try { localStorage.removeItem('visionLandingProfile'); } catch { /* ignore */ }
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.click('#arduReadBtn');
      await waitPage(page, () => (
        document.getElementById('arduWriteStatus')?.textContent || ''
      ).includes('הושלמה'), null, 60000, 'first read');
      await page.selectOption('#paramSubtabSelect', 'ardu-nav');
      const field = () => page.locator(`#fcGroupList [data-param-key="${PARAM}"] .fc-group-next`);
      await field().waitFor({ state: 'visible', timeout: 15000 });
      expect(await field().isDisabled()).toBe(false);
      const original = Number(await field().inputValue());
      expect(Number.isFinite(original)).toBe(true);
      const x = Math.abs(original - 150) < 0.05 ? 160 : 150;
      const y = Math.abs(x - 80) < 0.05 ? 90 : 80;
      const z = [original, x, y].some((n) => Math.abs(n - 40) < 0.05) ? 55 : 40;

      await field().evaluate((el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, x);
      await waitPage(page, () => document.getElementById('arduWriteBtn')?.disabled === false, null, 10000, 'write enabled');
      await page.click('#arduWriteBtn');
      await page.waitForSelector('#applyConfirmModal:not(.hidden)');
      await page.click('#applyConfirmOkBtn');
      await waitPage(page, () => (document.getElementById('paramWriteResult')?.textContent || '').includes('אומת'), null, 20000, 'write verified');
      const written = await page.locator('#paramWriteResult').innerText();
      expect(written).toContain(PARAM);
      expect(written).toContain(String(x));
      expect(written).toContain('אומת');
      expect(written).not.toContain('לא נכתב דבר');

      await field().evaluate((el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, y);
      await waitPage(page, (next) => {
        const el = document.querySelector('#fcGroupList [data-param-key="WP_RADIUS"] .fc-group-next');
        return el && Math.abs(Number(el.value) - next) < 0.05;
      }, y, 10000, 'dirty field');
      await page.evaluate(() => {
        const el = document.getElementById('arduWriteStatus');
        if (el) el.textContent = '';
      });
      await page.click('#arduReadBtn');
      const overwrite = page.locator('#fcReadOverwriteOk');
      let replaced = false;
      try {
        await overwrite.waitFor({ state: 'visible', timeout: 1500 });
        replaced = true;
      } catch {
        replaced = false;
      }
      if (replaced) {
        const asked = await page.locator('#fcReadOverwriteText').innerText();
        expect(asked).toContain('יש שינויים שלא נכתבו לבקר. להחליף אותם בערכים מהבקר?');
        await overwrite.click();
      }
      await waitPage(page, (opts) => {
        const line = document.getElementById('arduWriteStatus')?.textContent || '';
        if (!line.includes('הושלמה')) return false;
        if (!opts.didReplace) return true;
        const el = document.querySelector('#fcGroupList [data-param-key="WP_RADIUS"] .fc-group-next');
        return el && Math.abs(Number(el.value) - opts.want) < 0.05;
      }, { want: x, didReplace: replaced }, 60000, 'read after dirty edit');

      const beforeExternal = await api(base, 'GET', `/api/connections/${id}/params`);
      expect(Math.abs(Number(beforeExternal.json.params?.[PARAM]) - x), 'cache after verified write').toBeLessThan(0.05);
      await waitForPort(sidePort, '127.0.0.1', 10000);
      const echoed = await setParamOnLink(sidePort, PARAM, z);
      expect(Math.abs(echoed - z), 'direct SITL echo').toBeLessThan(0.05);

      tap.reset();
      await page.evaluate(() => {
        const el = document.getElementById('arduWriteStatus');
        if (el) el.textContent = '';
      });
      await page.click('#arduReadBtn');
      const overwriteAgain = page.locator('#fcReadOverwriteOk');
      try {
        await overwriteAgain.waitFor({ state: 'visible', timeout: 1500 });
        await overwriteAgain.click();
      } catch {
        /* no unsaved edit on this read */
      }
      await waitPage(page, (want) => {
        const el = document.querySelector('#fcGroupList [data-param-key="WP_RADIUS"] .fc-group-next');
        return el && Math.abs(Number(el.value) - want) < 0.05;
      }, z, 60000, 'read shows external value');
      expect(Math.abs(Number(await field().inputValue()) - z)).toBeLessThan(0.05);
      expect(tap.counts.request).toBeGreaterThan(0);
    } catch (err) {
      throw new Error(`${err.message}\n${tail(sitlLogs.out)}`);
    } finally {
      await browser?.close();
      tap.close();
      await api(base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
      stopChild(sitl);
      stopChild(consoleProc.child);
      sitlSlot.release();
    }
  }, 240000);
});
