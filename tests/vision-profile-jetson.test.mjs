/**
 * Optical landing profile is stored on the Jetson companion.
 * A slider does not change the file until כתיבה לג׳טסון reads the save back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
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
      const chrome = await page.evaluate(() => ({
        dir: document.getElementById('control')?.getAttribute('dir'),
        migrate: getComputedStyle(document.getElementById('jetsonMigrateBtn')).display,
        backup: document.getElementById('visionConfigWriteBtn')?.textContent || '',
      }));
      expect(chrome.dir, `${width}x${height}`).toBe('rtl');
      expect(chrome.migrate, `${width}x${height}`).toBe('none');
      expect(chrome.backup, `${width}x${height}`).toBe('שמירת גיבוי בקונסולה');
    }
  }, 60000);

  it('does not call a missing companion configuration a lost connection', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-profile-off-'));
    const started = await startTestServer({
      env: {
        SQLITE_PATH: path.join(dir, 'console.sqlite'),
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        GEMINI_API_KEY: '',
      },
    });
    try {
      const missed = await fetch(`${started.base}/api/vision/landing-profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { motor_hold_s: 0.8 } }),
      });
      const body = await missed.json();
      expect(missed.status).toBe(503);
      expect(body.reason).toBe('unconfigured');
      expect(body.message).not.toBe(OFFLINE);
    } finally {
      started.child.kill('SIGTERM');
    }
  }, 30000);

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
      expect(after.migrated).toBe(true);
    } finally {
      started.child.kill('SIGTERM');
    }
  }, 30000);
});

const TIMEOUT_HE = 'הג׳טסון לא ענה בזמן — לא נשמר';
const ERROR_HE = 'הג׳טסון החזיר שגיאה — לא נשמר';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startRealCompanion(dir, token) {
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
  await new Promise((resolve, reject) => {
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
      setTimeout(tick, 40);
    };
    tick();
  });
  return { child, port };
}

async function startFaultProxy(targetPort, token) {
  let fault = 'pass';
  const server = http.createServer(async (req, res) => {
    try {
      if (fault === 'hang') return;
      if (fault === '500' && req.method === 'PUT') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 700));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`http://127.0.0.1:${targetPort}${req.url}`, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          'x-companion-token': req.headers['x-companion-token'] || token,
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      let text = await upstream.text();
      if (req.method === 'GET' && String(req.url).includes('landing/profile') && (fault === 'mismatch' || fault === 'lie' || fault === 'drop')) {
        const json = JSON.parse(text);
        const profile = json.profile && typeof json.profile === 'object' ? json.profile : null;
        if (profile) {
          if (fault === 'drop') delete profile.xtrack_gain;
          if (fault === 'mismatch') {
            for (const key of Object.keys(profile)) {
              const n = Number(profile[key]);
              if (Number.isFinite(n)) profile[key] = n + 1;
            }
          }
          if (fault === 'lie' && Object.prototype.hasOwnProperty.call(profile, 'motor_hold_s')) profile.motor_hold_s = 7;
        }
        text = JSON.stringify(json);
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: String(err?.message || err) }));
    }
  });
  const port = await listen(server);
  return { port, setFault(next) { fault = next; }, close() { server.close(); } };
}

describe('landing profile through companion_agent.py', () => {
  const token = 'landing-qa-token';
  let dir = '';
  let companion = null;
  let proxy = null;
  let consoleProc = null;
  let base = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'airvix-real-profile-'));
    companion = await startRealCompanion(dir, token);
    proxy = await startFaultProxy(companion.port, token);
    const started = await startTestServer({
      env: {
        SQLITE_PATH: path.join(dir, 'console.sqlite'),
        COMPANION_MODE: 'real',
        JETSON_COMPANION_BASE_URL: `http://127.0.0.1:${proxy.port}`,
        VLC_COMPANION_TOKEN: token,
        COMPANION_TIMEOUT_MS: '1200',
        GEMINI_API_KEY: '',
      },
    });
    consoleProc = started.child;
    base = started.base;
  }, 40000);

  afterAll(async () => {
    try { consoleProc?.kill('SIGTERM'); } catch { /* ignore */ }
    try { proxy?.close(); } catch { /* ignore */ }
    try { companion?.child.kill('SIGTERM'); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    proxy.setFault('pass');
    rmSync(path.join(dir, 'landing-profile.json'), { force: true });
  });

  async function seedConsole(profile) {
    const res = await fetch(`${base}/api/vision/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    expect(res.ok).toBe(true);
  }

  it('rejects an unknown key and a non-number with their own words', async () => {
    const unknown = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { nope: 1 } }),
    });
    const unknownBody = await unknown.json();
    expect(unknown.status).toBe(400);
    expect(unknownBody.message).toContain('פרמטר לא מוכר');
    expect(unknownBody.message).toContain('nope');
    expect(unknownBody.message).not.toBe('הערך מחוץ לטווח');
    const text = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 'לא' } }),
    });
    const textBody = await text.json();
    expect(text.status).toBe(400);
    expect(textBody.message).toContain('ערך לא מספרי');
    expect(textBody.message).toContain('motor_hold_s');
  });

  it('fails the server read-back when the jetson value is not what was written', async () => {
    proxy.setFault('lie');
    const res = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 5 } }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.mismatch).toContain('motor_hold_s');
    expect(body.actual.motor_hold_s).toBe(7);
    expect(body.ok).toBe(false);
  });

  it('returns 409 when a migrated key is dropped or changed', async () => {
    await seedConsole({ flare_alt_m: 8, xtrack_gain: 0.5, motor_hold_s: 2 });
    proxy.setFault('mismatch');
    const changed = await fetch(`${base}/api/vision/landing-profile/migrate`, { method: 'POST' });
    const changedBody = await changed.json();
    expect(changed.status).toBe(409);
    expect(changedBody.mismatch).toContain('flare_alt_m');
    expect(changedBody.actual.flare_alt_m).toBe(9);
    expect(changedBody.message).not.toContain('נשמר בג׳טסון ואומת');
    rmSync(path.join(dir, 'landing-profile.json'), { force: true });
    proxy.setFault('drop');
    const dropped = await fetch(`${base}/api/vision/landing-profile/migrate`, { method: 'POST' });
    const droppedBody = await dropped.json();
    expect(dropped.status).toBe(409);
    expect(droppedBody.mismatch).toContain('xtrack_gain');
    expect(droppedBody.actual.xtrack_gain).toBeNull();
  });

  it('blocks migration when the jetson already has a profile', async () => {
    const first = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 3 } }),
    });
    expect(first.ok).toBe(true);
    await seedConsole({ motor_hold_s: 4 });
    const conflict = await fetch(`${base}/api/vision/landing-profile/migrate`, { method: 'POST' });
    const body = await conflict.json();
    expect(conflict.status).toBe(409);
    expect(body.message).toContain('כבר יש פרופיל בג׳טסון');
  });

  it('does not treat one bad stored value as an empty profile', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, 'landing-profile.json'), JSON.stringify({
      present: true,
      profile: { flare_alt_m: 99, motor_hold_s: 2.5 },
    }));
    const seen = await (await fetch(`${base}/api/vision/landing-profile`)).json();
    expect(seen.present).toBe(true);
    expect(seen.migrationOffered).toBe(false);
    expect(seen.rejected.flare_alt_m).toBe('out_of_range');
    await seedConsole({ motor_hold_s: 4 });
    const moved = await fetch(`${base}/api/vision/landing-profile/migrate`, { method: 'POST' });
    expect(moved.status).toBe(409);
    const wiped = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 3 } }),
    });
    expect(wiped.status).toBe(409);
    const disk = JSON.parse(readFileSync(path.join(dir, 'landing-profile.json'), 'utf8'));
    expect(disk.profile.flare_alt_m).toBe(99);
    expect(disk.profile.motor_hold_s).toBe(2.5);
  });

  it('keeps a verified console copy as a read-only backup', async () => {
    await seedConsole({ motor_hold_s: 4.5, flare_alt_m: 8 });
    const moved = await fetch(`${base}/api/vision/landing-profile/migrate`, { method: 'POST' });
    expect(moved.ok).toBe(true);
    const again = await fetch(`${base}/api/vision/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 1, flare_alt_m: 3 } }),
    });
    const saved = await again.json();
    expect(saved.landingProfileReadonly).toBe(true);
    expect(saved.profile.motor_hold_s).toBe(4.5);
    expect(saved.profile.flare_alt_m).toBe(8);
    const second = await fetch(`${base}/api/vision/landing-profile/migrate`, { method: 'POST' });
    expect(second.status).toBe(409);
  });

  it('uses a different line for a jetson 500 and for a timeout', async () => {
    proxy.setFault('500');
    const failed = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 2 } }),
    });
    const failedBody = await failed.json();
    expect(failed.status).toBe(502);
    expect(failedBody.message).toBe(ERROR_HE);
    expect(failedBody.reason).toBe('error');
    proxy.setFault('hang');
    const timed = await fetch(`${base}/api/vision/landing-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 2 } }),
    });
    const timedBody = await timed.json();
    expect(timed.status).toBe(504);
    expect(timedBody.message).toBe(TIMEOUT_HE);
    expect(timedBody.message).not.toBe(OFFLINE);
  }, 20000);

  it('shows בג׳טסון on a failed row and ignores a late offline response', async () => {
    const { chromium } = await import('playwright');
    const browserUi = await chromium.launch({ headless: true });
    try {
      const page = await browserUi.newPage({ viewport: { width: 1366, height: 630 } });
      let held = 0;
      let releaseHold = () => {};
      const hold = new Promise((resolve) => { releaseHold = resolve; });
      await page.route('**/api/vision/landing-profile', async (route) => {
        const method = route.request().method();
        if (method === 'GET' && held === 0) {
          held += 1;
          await hold;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, connected: false, reason: 'offline', message: OFFLINE }),
          });
          return;
        }
        await route.continue();
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.waitForFunction(() => (document.getElementById('visionConfigReadBtn')?.textContent || '').includes('קורא מהג׳טסון'));
      expect(await page.locator('#visionConfigReadBtn').isDisabled()).toBe(true);
      await page.evaluate(() => loadLandingProfileFromJetson());
      await page.waitForFunction(() => document.getElementById('jetsonToolState')?.textContent === 'נקרא מהג׳טסון');
      releaseHold();
      await page.waitForTimeout(400);
      expect(await page.locator('#jetsonToolState').innerText()).toBe('נקרא מהג׳טסון');
      expect(await page.locator('#jetsonOfflineNote').isHidden()).toBe(true);

      proxy.setFault('lie');
      await page.locator('#rng_motor_hold_s').fill('5');
      await page.locator('#jetsonProfileWriteBtn').click();
      await page.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('בג׳טסון: 7'));
      expect(await page.locator('#paramWriteResult').innerText()).not.toContain('נשמר בג׳טסון ואומת');
    } finally {
      proxy.setFault('pass');
      await browserUi.close();
    }
  }, 40000);

  it('shows the offline line only when the real companion is unreachable', async () => {
    const closed = await freePort();
    const offDir = mkdtempSync(path.join(os.tmpdir(), 'airvix-real-off-'));
    const started = await startTestServer({
      env: {
        SQLITE_PATH: path.join(offDir, 'console.sqlite'),
        COMPANION_MODE: 'real',
        JETSON_COMPANION_BASE_URL: `http://127.0.0.1:${closed}`,
        VLC_COMPANION_TOKEN: token,
        COMPANION_TIMEOUT_MS: '1200',
        GEMINI_API_KEY: '',
      },
    });
    const { chromium } = await import('playwright');
    const browserOff = await chromium.launch({ headless: true });
    try {
      const probed = await fetch(`${started.base}/api/vision/landing-profile`);
      const probedBody = await probed.json();
      expect(probed.status).toBe(503);
      expect(probedBody.reason).toBe('offline');
      expect(probedBody.message).toBe(OFFLINE);
      const page = await browserOff.newPage();
      await page.goto(started.base, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.waitForFunction((text) => {
        const note = document.getElementById('jetsonOfflineNote');
        return note && note.hidden === false && note.textContent === text;
      }, OFFLINE);
      expect(await page.locator('#jetsonToolState').innerText()).toBe('לא מחובר');
      expect(await page.locator('#jetsonProfileWriteBtn').isDisabled()).toBe(true);
      expect(await page.locator('[data-param-key="motor_hold_s"] .param-card-stale').innerText()).toBe('ערך אחרון שנקרא — לא עדכני');
      await page.evaluate(() => {
        const button = document.getElementById('jetsonMigrateBtn');
        button.hidden = false;
        button.click();
      });
      await page.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('הג׳טסון לא מחובר'));
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        const fit = await page.evaluate(controlTextFit);
        expect(fit, `${width}x${height}`).toEqual([]);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${width}x${height}`).toBeLessThanOrEqual(1);
        expect(await page.locator('#control').getAttribute('dir')).toBe('rtl');
      }
    } finally {
      await browserOff.close();
      started.child.kill('SIGTERM');
      rmSync(offDir, { recursive: true, force: true });
    }
  }, 40000);
});
