/**
 * Overlay on the optics tile: boxes, click lock, the right-click list, next, unlock, and no stream.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTextFitFailures } from './text-fit-audit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = path.join(os.tmpdir(), `airvix-vision-shots-${process.pid}`);
mkdirSync(shotDir, { recursive: true });
const sampleJpeg = path.join(os.tmpdir(), `airvix-vision-sample-${process.pid}.jpg`);

function sampleFrame() {
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x111827:s=320x180',
    '-vf', 'drawbox=x=20:y=30:w=80:h=70:color=red@1:t=fill,drawbox=x=180:y=50:w=90:h=50:color=0x16a34a@1:t=fill',
    '-frames:v', '1', sampleJpeg,
  ], { stdio: 'ignore' });
  return readFileSync(sampleJpeg);
}

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

const TRACKS = [
  { id: 1, class: 'person', label_he: 'אדם', confidence: 0.92, bbox: [20, 30, 80, 70], age: 4 },
  { id: 2, class: 'car', label_he: 'רכב', confidence: 0.61, bbox: [180, 50, 90, 50], age: 2 },
];

function payload(state, camera) {
  const active = state.enabled === true && state.camera === camera;
  const live = state.mode === 'tracks' && active;
  let reason = 'הזיהוי כבוי';
  if (state.mode === 'nostream' && active) reason = 'אין נתון על זרם המצלמות';
  else if (live) reason = '';
  return {
    ok: true,
    enabled: state.enabled === true,
    camera,
    selected_camera: state.camera,
    backend: 'cpu',
    stream: live,
    frame_width: 320,
    frame_height: 180,
    tracks: live ? TRACKS : [],
    lock: state.lock && state.lock.camera === camera ? state.lock : null,
    gimbal_steer: {
      enabled: state.steer === true,
      sent: false,
      blocked: true,
      reason_he: state.steer ? 'הגימבל לא עונה. היגוי לא נשלח.' : 'היגוי הגימבל כבוי',
      flight_commands: false,
    },
    reason_he: reason,
    flight_commands: false,
    performance: { measured: false },
  };
}

async function boot() {
  const port = await freePort();
  const dbPath = path.join(os.tmpdir(), `airvix-vision-${process.pid}.sqlite`);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: dbPath,
      COMPANION_MODE: 'off',
      JETSON_COMPANION_BASE_URL: '',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 20000) {
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) { up = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    proc.kill('SIGTERM');
    throw new Error('server did not start');
  }
  return { proc, base };
}

describe('vision track overlay', () => {
  let proc = null;
  let browser = null;
  let base = '';

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('draws boxes, locks from a click and from the list, then steps and unlocks', async () => {
    const started = await boot();
    proc = started.proc;
    base = started.base;
    const state = { enabled: true, camera: 'cam0', lock: null, steer: false, mode: 'tracks' };
    const jpeg = sampleFrame();
    let frameSeq = 1;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/api/jetson/v1/cameras/cam0/frame**', async (route) => {
      frameSeq += 1;
      await route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'x-airvix-frame-seq': String(frameSeq) },
        body: jpeg,
      });
    });
    await page.route('**/api/jetson/v1/vision/**', async (route) => {
      const url = new URL(route.request().url());
      const request = route.request();
      if (request.method() === 'POST' && url.pathname.endsWith('/vision/config')) {
        const body = request.postDataJSON() || {};
        if ('enabled' in body) state.enabled = body.enabled === true;
        if (body.camera) state.camera = body.camera;
        if ('gimbal_steer' in body) state.steer = body.gimbal_steer === true;
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/vision/lock')) {
        const body = request.postDataJSON() || {};
        const camera = body.camera || state.camera;
        const rows = [...TRACKS].sort((a, b) => (body.sort === 'confidence'
          ? b.confidence - a.confidence
          : a.label_he.localeCompare(b.label_he, 'he') || a.id - b.id));
        if (body.action === 'unlock') state.lock = null;
        else if (body.action === 'next') {
          const ids = rows.map((row) => row.id);
          const current = state.lock?.id;
          const pick = current != null && ids.includes(current) ? ids[(ids.indexOf(current) + 1) % ids.length] : ids[0];
          const chosen = rows.find((row) => row.id === pick);
          state.lock = { ...chosen, camera };
        } else if (body.id != null) {
          const chosen = rows.find((row) => row.id === Number(body.id));
          state.lock = chosen ? { ...chosen, camera } : state.lock;
        }
      }
      const camera = url.searchParams.get('camera') || state.camera;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, lane: 'NEW', data: payload(state, camera) }),
      });
    });
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    const stageCount = await page.locator('[data-camera-stage="cam0"]').count();
    expect(stageCount, 'no camera stage found').toBeGreaterThan(0);
    await page.waitForSelector('[data-camera-stage="cam0"]');
    await page.evaluate(() => {
      const detail = {
        cameras: {
          cam0: { camera_ok: true, enabled: true, state: 'streaming', fps: 10, has_frame: true, frame_count: 4, last_frame_age_ms: 40 },
        },
      };
      const push = () => document.dispatchEvent(new CustomEvent('vlc-companion-cameras', { detail }));
      push();
      setInterval(push, 200);
    });
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-api="cam0"] .debrief-cam-live');
      const stage = document.querySelector('[data-camera-stage="cam0"]');
      const canvas = stage?.querySelector('.vision-box-layer');
      return img && !img.hidden && img.naturalWidth === 320
        && stage?.dataset.visionTracks === '1,2'
        && canvas && canvas.hidden !== true && canvas.dataset.hit === '1';
    }, null, { timeout: 15000 });
    const host = page.locator('[data-camera-stage="cam0"]').first();
    await page.screenshot({ path: `${shotDir}/vision-overlay.png` });
    const point = await page.evaluate(() => {
      const stage = document.querySelector('[data-camera-stage="cam0"]');
      const img = stage.querySelector('img');
      const rect = img.getBoundingClientRect();
      const scale = Math.min(rect.width / 320, rect.height / 180);
      const ox = rect.x + (rect.width - 320 * scale) / 2;
      const oy = rect.y + (rect.height - 180 * scale) / 2;
      return { x: ox + (20 + 40) * scale, y: oy + (30 + 35) * scale };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionLock === '1');
    await page.screenshot({ path: `${shotDir}/vision-lock.png` });
    await host.click({ button: 'right', position: { x: 24, y: 24 } });
    await page.waitForSelector('#visionTrackMenu:not([hidden])');
    await page.screenshot({ path: `${shotDir}/vision-object-list.png` });
    const report = await page.evaluate(collectTextFitFailures, 1);
    const visionFails = (report.fails || []).filter((row) => /vision/.test(row.who));
    expect(visionFails).toEqual([]);
    await page.locator('#visionTrackMenu [data-vision-id="2"]').click();
    await page.waitForFunction(() => document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionLock === '2');
    await host.click({ button: 'right', position: { x: 24, y: 24 } });
    await page.locator('#visionTrackMenu [data-vision-action="next"]').click();
    await page.waitForFunction(() => {
      const id = document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionLock;
      return id === '1';
    });
    await host.click({ button: 'right', position: { x: 24, y: 24 } });
    await page.locator('#visionTrackMenu [data-vision-action="unlock"]').click();
    await page.waitForFunction(() => document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionLock === '');
    expect(await page.locator('[data-camera-stage="cam0"]').first().getAttribute('data-vision-tracks')).toBe('1,2');
  }, 60000);

  it('shows the empty line and no boxes when there is no stream', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    const stage = page.locator('[data-camera-stage="cam0"]').first();
    expect(await page.locator('[data-camera-stage="cam0"]').count(), 'no camera stage found').toBeGreaterThan(0);
    await page.waitForFunction(() => document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionReason === 'אין נתון על זרם המצלמות');
    expect(await stage.getAttribute('data-vision-tracks')).toBe('');
    expect(await stage.locator('.vision-box-layer').getAttribute('hidden')).not.toBeNull();
    await page.screenshot({ path: `${shotDir}/vision-no-stream.png` });
    const state = { enabled: true, camera: 'cam0', lock: null, steer: false, mode: 'nostream' };
    await page.route('**/api/jetson/v1/vision/**', async (route) => {
      const camera = new URL(route.request().url()).searchParams.get('camera') || 'cam0';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, lane: 'NEW', data: payload(state, camera) }),
      });
    });
    await page.waitForFunction(() => document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionReason === 'אין נתון על זרם המצלמות');
    state.mode = 'off';
    state.enabled = false;
    await page.waitForFunction(() => document.querySelector('[data-camera-stage="cam0"]')?.dataset.visionReason === 'הזיהוי כבוי');
    expect(await stage.locator('.vision-box-note').innerText()).toBe('הזיהוי כבוי');
    await page.close();
  }, 30000);

  it('keeps the menu on screen at 1280x720 near the bottom of the down camera', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const rows = Array.from({ length: 14 }, (_, index) => ({
      id: index + 1,
      class: index % 2 ? 'car' : 'person',
      label_he: index % 2 ? 'רכב' : 'אדם',
      confidence: 0.9 - index * 0.01,
      bbox: [10, 10, 20, 20],
      age: 3,
    }));
    await page.route('**/api/jetson/v1/vision/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          lane: 'NEW',
          data: {
            ok: true,
            enabled: true,
            camera: 'cam1',
            selected_camera: 'cam1',
            stream: true,
            tracks: rows,
            lock: null,
            reason_he: '',
            frame_width: 320,
            frame_height: 180,
            gimbal_steer: { enabled: false, sent: false, blocked: true, reason_he: 'היגוי הגימבל כבוי', flight_commands: false },
            flight_commands: false,
          },
        }),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    const stage = page.locator('[data-camera-stage="cam1"]').first();
    expect(await stage.count(), 'no camera stage found').toBeGreaterThan(0);
    await stage.evaluate((node) => node.scrollIntoView({ block: 'end', inline: 'nearest' }));
    const rect = await stage.boundingBox();
    expect(rect && rect.height).toBeGreaterThan(8);
    const clickY = Math.min((rect?.y || 0) + (rect?.height || 0) - 6, 712);
    await page.mouse.click((rect?.x || 0) + Math.min(20, (rect?.width || 40) / 2), clickY, { button: 'right' });
    await page.waitForSelector('#visionTrackMenu:not([hidden])');
    const fit = await page.evaluate(() => {
      const menu = document.getElementById('visionTrackMenu');
      const steer = menu.querySelector('[data-vision-action="steer"]');
      const kicker = [...menu.querySelectorAll('.vision-menu-kicker')].find((node) => node.textContent === 'היגוי');
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const box = menu.getBoundingClientRect();
      steer.scrollIntoView({ block: 'nearest' });
      const btn = steer.getBoundingClientRect();
      return {
        contained: box.top >= -1 && box.left >= -1 && box.bottom <= viewH + 1 && box.right <= viewW + 1,
        reachable: btn.height > 0 && btn.top >= -1 && btn.bottom <= viewH + 1 && btn.top >= box.top - 1 && btn.bottom <= box.bottom + 1,
        overflow: getComputedStyle(menu).overflowY,
        hasSteerGroup: Boolean(kicker),
        bottom: box.bottom,
        viewH,
      };
    });
    expect(fit.hasSteerGroup).toBe(true);
    expect(fit.contained).toBe(true);
    expect(fit.reachable).toBe(true);
    expect(fit.bottom).toBeLessThanOrEqual(720);
    expect(['auto', 'scroll']).toContain(fit.overflow);
    await page.close();
  }, 30000);

  it('asks with a live detection stream and keeps the lock beside a refused return home', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const posts = [];
    const flightPosts = [];
    const quietPosts = [];
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() !== 'POST') return;
      if (url.includes('/api/links/work') || url.includes('/api/flight-engineer/tts')) quietPosts.push(url);
      if (url.includes('/api/assist/message')) posts.push(req.postDataJSON());
      if (url.includes('/api/assist/voice-flight') || url.includes('/api/mavlink/') || url.includes('/vision/lock') || url.includes('/vision/config')) {
        flightPosts.push(url);
      }
    });
    await page.route('**/api/jetson/v1/vision/**', async (route) => {
      const camera = new URL(route.request().url()).searchParams.get('camera') || 'cam0';
      const live = camera === 'cam0';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          lane: 'NEW',
          data: {
            ok: true,
            enabled: live,
            camera,
            selected_camera: live ? 'cam0' : null,
            backend: live ? 'cpu' : 'off',
            stream: live,
            tracks: live ? [
              { id: 7, class: 'person', label_he: 'אדם', confidence: 0.91, bbox: [8, 10, 18, 30], age: 6 },
              { id: 8, class: 'car', label_he: 'רכב', confidence: 0.64, bbox: [50, 28, 30, 16], age: 6 },
            ] : [],
            lock: live ? { id: 7, class: 'person', label_he: 'אדם', camera: 'cam0' } : null,
            reason_he: live ? '' : 'הזיהוי כבוי',
            gimbal_steer: { enabled: false, sent: false, blocked: true, reason_he: 'היגוי הגימבל כבוי', flight_commands: false },
            flight_commands: false,
          },
        }),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const state = window.__vlcVisionAskState?.();
      return state?.stream === true
        && state.enabled === true
        && state.model === true
        && state.tracks?.length === 2
        && state.lock?.id === 7;
    }, null, { timeout: 15000 });
    expect(quietPosts).toEqual([]);
    await page.click('[data-tab="control"]');
    const railHidden = await page.locator('#assistRail').getAttribute('hidden');
    if (railHidden !== null) await page.click('#assistToggleBtn');
    await page.waitForSelector('#assistRail:not([hidden]) #assistInput', { state: 'visible' });
    const ask = async (text) => {
      await page.locator('#assistInput').fill(text);
      await page.locator('#assistSendBtn').click();
    };
    await ask('מה אתה מזהה');
    await page.waitForFunction(() => (document.querySelector('#assistMessages')?.textContent || '').includes('מזהים אדם 1, רכב 1'));
    await ask('כמה אנשים אתה רואה');
    await page.waitForFunction(() => (document.querySelector('#assistMessages')?.textContent || '').includes('רואים אדם אחד'));
    const detect = posts.find((row) => row?.text === 'מה אתה מזהה');
    expect(detect?.context?.vision?.stream).toBe(true);
    expect(detect?.context?.vision?.enabled).toBe(true);
    expect(detect?.context?.vision?.tracks?.map((row) => row.label_he)).toEqual(['אדם', 'רכב']);
    expect(detect?.context?.vision?.lock).toEqual({ id: 7 });
    const beforeFlight = flightPosts.length;
    await ask('נעל על האדם ותחזור הביתה');
    await page.waitForFunction(() => {
      const text = document.querySelector('#assistMessages')?.textContent || '';
      return text.includes('הנעילה על האדם בתוכנית') && text.includes('חזרה הביתה נדחתה') && text.includes('לא נשלח דבר');
    });
    expect(posts.some((row) => row?.text === 'נעל על האדם ותחזור הביתה')).toBe(true);
    expect(flightPosts.length).toBe(beforeFlight);
    const beforeArm = posts.length;
    await ask('חימוש');
    await page.waitForFunction(() => (document.querySelector('#assistMessages')?.textContent || '').includes('חימוש ונטרול חסומים'));
    await ask('נטרול');
    await page.waitForFunction(() => {
      const text = document.querySelector('#assistMessages')?.textContent || '';
      return text.split('חימוש ונטרול חסומים').length >= 3;
    });
    expect(posts.length).toBe(beforeArm);
    expect(flightPosts).toEqual([]);
    await page.close();
  }, 60000);
});
