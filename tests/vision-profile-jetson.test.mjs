/**
 * Optical landing profile is stored on the Jetson companion.
 * A slider does not change the file until כתיבה לג׳טסון reads the save back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './test-server.mjs';
import { JETSON_NUMERIC_SCHEMA, rejectJetsonProfile } from '../lib/param-schema.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companionDir = path.join(repoRoot, 'scripts/jetson-companion');
const SIZES = [[360, 640], [360, 800], [1024, 470], [1366, 630], [1536, 730]];
const OFFLINE = 'הג׳טסון לא מחובר — לא ניתן לקרוא או לשמור';

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

function pythonJson(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', code], {
      cwd: companionDir,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (codeStatus) => {
      if (codeStatus !== 0) {
        reject(new Error(err || out || `python ${codeStatus}`));
        return;
      }
      resolve(JSON.parse(out));
    });
  });
}

describe('jetson landing profile store', () => {
  it('shares bounds with the console schema and rejects values outside them', async () => {
    const pySchema = await pythonJson('import json, landing_profile\nprint(json.dumps(landing_profile.schema()))');
    expect(pySchema).toEqual(JETSON_NUMERIC_SCHEMA);
    expect(rejectJetsonProfile({ motor_hold_s: 9 }).ok).toBe(false);
    expect(rejectJetsonProfile({ motor_hold_s: 9 }).rejected.motor_hold_s).toBe('out_of_range');
    const rejected = await pythonJson(
      'import json, landing_profile\nprint(json.dumps(landing_profile.reject({"motor_hold_s": 9})))',
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.rejected.motor_hold_s).toBe('out_of_range');
  });

  it('writes atomically, reads back, and keeps the file across a new process', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-landing-profile-'));
    try {
      const wrote = await pythonJson(
        'import json, landing_profile\nprint(json.dumps(landing_profile.put({"profile": {"motor_hold_s": 0.8}})))',
        { VLC_COMPANION_DATA: dir },
      );
      expect(wrote[0]).toBe(200);
      expect(wrote[1].profile.motor_hold_s).toBe(0.8);
      const again = await pythonJson(
        'import json, landing_profile\nprint(json.dumps({"read": landing_profile.read(), "landing": landing_profile.for_landing()}))',
        { VLC_COMPANION_DATA: dir },
      );
      expect(again.read.profile.motor_hold_s).toBe(0.8);
      expect(again.landing.profile.motor_hold_s).toBe(0.8);
      expect(again.landing.present).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves authenticated GET and PUT and keeps the profile after the companion restarts', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-landing-http-'));
    const token = 'landing-profile-test-token';
    async function start() {
      const port = await freePort();
      const child = spawn('python3', ['companion_agent.py'], {
        cwd: companionDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          HOME: dir,
          VLC_COMPANION_DATA: dir,
          VLC_COMPANION_TOKEN: token,
          VLC_HTTP_BIND: '127.0.0.1',
          VLC_HTTP_PORT: String(port),
          VLC_SKIP_RELAY: '1',
          VLC_UPLINK_BOOT: '0',
          VLC_GIMBAL_POLL: '0',
          VLC_FC_READ_ONLY: '1',
        },
      });
      let log = '';
      child.stdout?.on('data', (chunk) => { log += chunk; });
      child.stderr?.on('data', (chunk) => { log += chunk; });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(log || 'companion did not listen'));
        }, 25000);
        const tick = () => {
          if (log.includes('HTTP keep-alive')) {
            clearTimeout(timer);
            resolve();
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });
      await ready;
      return { child, port, log: () => log };
    }
    const first = await start();
    try {
      const base = `http://127.0.0.1:${first.port}`;
      const denied = await fetch(`${base}/api/v1/landing/profile`);
      expect(denied.status).toBe(401);
      const put = await fetch(`${base}/api/v1/landing/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Companion-Token': token },
        body: JSON.stringify({ profile: { motor_hold_s: 0.8 } }),
      });
      expect(put.status).toBe(200);
      const read = await fetch(`${base}/api/v1/landing/profile`, { headers: { 'X-Companion-Token': token } });
      expect((await read.json()).profile.motor_hold_s).toBe(0.8);
      const bounds = await fetch(`${base}/api/v1/landing/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Companion-Token': token },
        body: JSON.stringify({ profile: { motor_hold_s: 99 } }),
      });
      expect(bounds.status).toBe(400);
      expect((await bounds.json()).rejected.motor_hold_s).toBe('out_of_range');
    } finally {
      first.child.kill('SIGTERM');
    }
    const second = await start();
    try {
      const read = await fetch(`http://127.0.0.1:${second.port}/api/v1/landing/profile`, {
        headers: { 'X-Companion-Token': token },
      });
      const body = await read.json();
      expect(body.profile.motor_hold_s).toBe(0.8);
      const landing = await fetch(`http://127.0.0.1:${second.port}/api/v1/status/landing`, {
        headers: { 'X-Companion-Token': token },
      });
      const status = await landing.json();
      expect(status.profile.motor_hold_s).toBe(0.8);
      expect(status.profile_present).toBe(true);
    } finally {
      second.child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70000);
});

function controlTextFit() {
  const root = document.getElementById('control');
  const fails = [];
  if (!root) return fails;
  root.querySelectorAll('*').forEach((el) => {
    if (el.closest('[hidden]')) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)') return;
    if (el.clientWidth < 2 || el.clientHeight < 2) return;
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const fontPx = Number.parseFloat(style.fontSize) || 0;
    const who = el.id ? `#${el.id}` : String(el.className || el.tagName).slice(0, 48);
    if (fontPx < 10.5) fails.push({ who, reason: 'small', text: text.slice(0, 40), fontPx });
    if (el.scrollWidth - el.clientWidth > 1) fails.push({ who, reason: 'width', text: text.slice(0, 40) });
    if (el.scrollHeight - el.clientHeight > 1) fails.push({ who, reason: 'height', text: text.slice(0, 40) });
  });
  return fails.slice(0, 8);
}

describe('parameters tab jetson profile', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('marks an unsaved slider, saves on the jetson, and leaves the card alone after an FC read', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-profile-ui-'));
    const started = await startTestServer({
      env: {
        SQLITE_PATH: path.join(dir, 'console.sqlite'),
        COMPANION_MODE: 'mock',
        JETSON_COMPANION_BASE_URL: '',
        VLC_LANDING_PROFILE_DIR: dir,
        GEMINI_API_KEY: '',
      },
    });
    proc = started.child;
    const base = started.base;
    const seed = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 6.3 } }),
    });
    expect(seed.ok).toBe(true);

    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      try { localStorage.removeItem('visionLandingProfile'); } catch { /* ignore */ }
    });
    await page.route(/\/api\/ardu\/params\/read$/, async (route) => {
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
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="control"]');
    await page.waitForFunction(() => document.getElementById('rng_motor_hold_s')?.value === '6.3');
    expect(await page.locator('.param-tool-title').nth(0).innerText()).toContain('פרמטרי נחיתה אופטית (ג׳טסון)');
    expect(await page.locator('.param-tool-title').nth(1).innerText()).toContain('פרמטרי בקר (FC)');

    await page.locator('#rng_motor_hold_s').fill('0.8');
    await page.waitForFunction(() => document.querySelector('[data-param-key="motor_hold_s"]')?.classList.contains('param-card--dirty'));
    const held = await (await fetch(`${base}/api/vision/landing-profile`)).json();
    expect(held.profile.motor_hold_s).toBe(6.3);
    const card = page.locator('[data-param-key="motor_hold_s"]');
    expect(await card.locator('.param-card-dirty').innerText()).toBe('לא נשמר — 0.8 (שמור: 6.3)');
    expect(await page.locator('#arduWriteBtn').isDisabled()).toBe(true);
    expect(await page.locator('#jetsonToolState').innerText()).toBe('שינוי לא נשמר (1)');

    await page.locator('#jetsonProfileWriteBtn').click();
    await page.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('נשמר בג׳טסון ואומת'));
    const saved = await (await fetch(`${base}/api/vision/landing-profile`)).json();
    expect(saved.profile.motor_hold_s).toBe(0.8);
    expect(await page.locator('#paramWriteResult').innerText()).not.toContain('נכתב לבקר ואומת');

    await page.locator('#rng_motor_hold_s').fill('1.2');
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => (document.querySelector('[data-param-key="motor_hold_s"] .param-card-fc-note')?.textContent || '').includes('לא נקרא מהבקר'));
    expect(await page.locator('#rng_motor_hold_s').inputValue()).toBe('1.2');
    const afterRead = await (await fetch(`${base}/api/vision/landing-profile`)).json();
    expect(afterRead.profile.motor_hold_s).toBe(0.8);

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.locator('#jetsonToolState').click();
      const fit = await page.evaluate(controlTextFit);
      expect(fit, `${width}x${height}`).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${width}x${height}`).toBeLessThanOrEqual(1);
    }
  }, 60000);

  it('shows the offline line and does not store a slider move when the jetson is down', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-profile-off-'));
    const started = await startTestServer({
      env: {
        SQLITE_PATH: path.join(dir, 'console.sqlite'),
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        GEMINI_API_KEY: '',
      },
    });
    const { chromium } = await import('playwright');
    const browserOff = await chromium.launch({ headless: true });
    try {
      const page = await browserOff.newPage({ viewport: { width: 1024, height: 470 } });
      await page.goto(started.base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.waitForFunction((text) => document.getElementById('jetsonOfflineNote')?.textContent === text && document.getElementById('jetsonOfflineNote')?.hidden === false, OFFLINE);
      expect(await page.locator('#jetsonProfileWriteBtn').isDisabled()).toBe(true);
      await page.locator('#rng_motor_hold_s').fill('0.8');
      const missed = await fetch(`${started.base}/api/vision/landing-profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: { motor_hold_s: 0.8 } }) });
      expect(missed.status).toBe(503);
      expect((await missed.json()).message).toBe(OFFLINE);
      const fit = await page.evaluate(controlTextFit);
      expect(fit).toEqual([]);
    } finally {
      await browserOff.close();
      started.child.kill('SIGTERM');
    }
  }, 40000);

  it('offers a one-time move when only the console still has a profile', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-profile-move-'));
    const started = await startTestServer({
      env: {
        SQLITE_PATH: path.join(dir, 'console.sqlite'),
        COMPANION_MODE: 'mock',
        JETSON_COMPANION_BASE_URL: '',
        VLC_LANDING_PROFILE_DIR: dir,
        GEMINI_API_KEY: '',
      },
    });
    try {
      const legacy = await fetch(`${started.base}/api/vision/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { motor_hold_s: 4.5 } }),
      });
      expect(legacy.ok).toBe(true);
      const offered = await (await fetch(`${started.base}/api/vision/landing-profile`)).json();
      expect(offered.present).toBe(false);
      expect(offered.migrationOffered).toBe(true);
      const moved = await fetch(`${started.base}/api/vision/landing-profile/migrate`, { method: 'POST' });
      expect(moved.ok).toBe(true);
      const after = await (await fetch(`${started.base}/api/vision/landing-profile`)).json();
      expect(after.profile.motor_hold_s).toBe(4.5);
      expect(after.migrationOffered).toBe(false);
    } finally {
      started.child.kill('SIGTERM');
    }
  }, 30000);
});
