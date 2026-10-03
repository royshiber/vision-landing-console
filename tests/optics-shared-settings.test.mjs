/**
 * Both cameras share one settings form. The gimbal panel stays off
 * until a gimbal answers, and a Playwright mock never touches a real FC.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMERA_UNSUPPORTED_HE, cameraControlSupported } from '../public/modules/camera-settings.mjs';
import { gimbalMoveBody, setGimbalMoveSpeed } from '../public/modules/gimbal-pad.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/screenshots';

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

function contrastRatio(a, b) {
  const parse = (color) => {
    const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return [1, 2, 3].map((i) => {
      const x = Number(m[i]) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
  };
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return 0;
  const hi = Math.max(lum(A), lum(B));
  const lo = Math.min(lum(A), lum(B));
  return (hi + 0.05) / (lo + 0.05);
}

describe('shared camera settings', () => {
  it('keeps the same actions and only disables what the companion lacks', () => {
    for (const kind of ['record', 'detections', 'calibration', 'snapshot']) {
      expect(cameraControlSupported('cam0', kind)).toBe(true);
    }
    expect(cameraControlSupported('cam1', 'snapshot')).toBe(true);
    expect(cameraControlSupported('cam1', 'record')).toBe(false);
    expect(cameraControlSupported('cam1', 'detections')).toBe(false);
    expect(cameraControlSupported('cam1', 'calibration')).toBe(true);
    expect(CAMERA_UNSUPPORTED_HE.record).toBe('המצלמה הזו לא מקליטה');
    setGimbalMoveSpeed(25);
    expect(gimbalMoveBody('up')).toEqual({ yaw: 0, pitch: -25 });
    setGimbalMoveSpeed(40);
    expect(gimbalMoveBody('up')).toEqual({ yaw: 0, pitch: -40 });
  });
});

describe('optics cameras and gimbal panel', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('fits both cameras at 1024x600 and mocks the gimbal without a vehicle', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-optics-${process.pid}.sqlite`);
    proc = spawn(process.execPath, ['server.js'], {
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
    expect(up).toBe(true);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
    const posts = [];
    let gimbal = { present: false, mode: null, control_enabled: false };
    await page.route('**/api/jetson/v1/status/gimbal', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(gimbal),
    }));
    await page.route('**/api/jetson/v1/gimbal/**', async (route) => {
      posts.push({ url: route.request().url(), body: route.request().postData() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, sent: true }),
      });
    });
    await page.route('**/api/jetson/v1/cam1/status', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        camera_ok: true,
        has_frame: true,
        state: 'live',
        fps: 10,
        width: 1280,
        height: 800,
        ae: { enabled: false },
        exposure_us: 2000,
        gain: 16,
      }),
    }));
    await page.route('**/api/jetson/v1/cam1/stream.mjpg**', (route) => route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUTEhIVFhUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAADAAIEBQYHCP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A1e1h0AAAAA//9k=', 'base64'),
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#cam0Fov');
    await page.waitForSelector('#cam1Record', { state: 'attached' });

    const cam0 = await page.evaluate(() => {
      const groups = (id) => [...document.querySelectorAll(`[data-camera-settings="${id}"] [data-settings-group]`)]
        .map((el) => el.getAttribute('data-settings-group'));
      const optics = document.getElementById('optics');
      const calib = document.querySelector('#optics .optics-calib');
      const solve = document.getElementById('cam0CalibStart');
      const snap = document.getElementById('cam0Snap');
      return {
        groups: groups('cam0'),
        cam1: groups('cam1'),
        snapGroup: snap?.closest('[data-settings-group]')?.getAttribute('data-settings-group'),
        opticsScroll: optics.scrollHeight - optics.clientHeight,
        calibScroll: calib.scrollHeight - calib.clientHeight,
        calibOverflow: getComputedStyle(calib).overflowY,
        solveBottom: solve.getBoundingClientRect().bottom,
        vh: window.innerHeight,
        notes: document.querySelectorAll('[data-camera-settings="cam0"] [data-unsupported]').length,
      };
    });
    expect(cam0.groups).toEqual(cam0.cam1);
    expect(cam0.groups).toEqual(['exposure', 'image', 'record', 'calibration']);
    expect(cam0.snapGroup).toBe('record');
    expect(cam0.notes).toBe(0);
    expect(cam0.opticsScroll).toBeLessThan(8);
    expect(cam0.calibScroll).toBeLessThan(2);
    expect(cam0.calibOverflow).not.toBe('auto');
    expect(cam0.calibOverflow).not.toBe('scroll');
    expect(cam0.solveBottom).toBeLessThanOrEqual(cam0.vh);
    const pad = await page.evaluate(() => {
      const btn = document.querySelector('.gimbal-pad-btn[data-gimbal="center"]');
      const cs = getComputedStyle(btn);
      return { color: cs.color, background: cs.backgroundColor, opacity: cs.opacity };
    });
    expect(Number(pad.opacity)).toBe(1);
    expect(contrastRatio(pad.color, pad.background)).toBeGreaterThanOrEqual(4.5);
    const fov = await page.evaluate(() => {
      const input = document.getElementById('cam0Fov');
      const wrap = input.closest('.optics-stepper');
      const steps = [...wrap.querySelectorAll('.optics-step')];
      const speed = document.getElementById('gimbalSpeed');
      const speedSteps = [...speed.closest('.optics-stepper').querySelectorAll('.optics-step')];
      const box = input.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        value: input.value,
        over: input.scrollWidth - input.clientWidth,
        labels: steps.map((btn) => btn.getAttribute('aria-label')),
        centered: getComputedStyle(input).textAlign,
        appearance: getComputedStyle(input).appearance,
        hit: hit === input || input.contains(hit),
        speedDisabled: speed.disabled,
        speedStepsDisabled: speedSteps.every((btn) => btn.disabled),
        gimbalDisabled: [...document.querySelectorAll('.gimbal-pad-btn')].every((btn) => btn.disabled),
      };
    });
    expect(fov.value).toBe('120');
    expect(fov.over).toBeLessThanOrEqual(1);
    expect(fov.labels).toEqual(['הפחיתו', 'הגדילו']);
    expect(fov.centered).toBe('center');
    expect(fov.appearance).toBe('textfield');
    expect(fov.hit).toBe(true);
    expect(fov.speedDisabled).toBe(true);
    expect(fov.speedStepsDisabled).toBe(true);
    expect(fov.gimbalDisabled).toBe(true);
    await page.locator('#cam0Fov').locator('xpath=../button[@data-optics-step="1"]').click();
    expect(await page.locator('#cam0Fov').inputValue()).toBe('121');

    await page.click('#opticsCam1Btn');
    await page.waitForSelector('#cam1Panel:not([hidden])');
    const cam1 = await page.evaluate(() => {
      const panel = document.getElementById('cam1Panel');
      const start = document.getElementById('cam1CalibStart');
      return {
        snapGroup: document.getElementById('cam1Snap')?.closest('[data-settings-group]')?.getAttribute('data-settings-group'),
        record: document.getElementById('cam1Record')?.disabled === true,
        detect: document.getElementById('cam1OverlayToggle')?.disabled === true,
        start: start?.textContent || '',
        corners: document.getElementById('cam1CalibCols')?.value,
        square: document.getElementById('cam1CalibSquare')?.value,
        note: document.querySelector('[data-camera-settings="cam1"]')?.innerText || '',
        bottom: Math.max(panel.getBoundingClientRect().bottom, start.getBoundingClientRect().bottom),
        vh: window.innerHeight,
        calibScroll: document.querySelector('#optics .optics-calib').scrollHeight
          - document.querySelector('#optics .optics-calib').clientHeight,
      };
    });
    expect(cam1.snapGroup).toBe('record');
    expect(cam1.record).toBe(true);
    expect(cam1.detect).toBe(true);
    expect(cam1.start).toBe('התחל כיול');
    expect(cam1.corners).toBe('9');
    expect(cam1.square).toBe('25');
    expect(cam1.note).toContain('המצלמה הזו לא מקליטה');
    expect(cam1.note).toContain('אין זיהויים במצלמה הזו');
    expect(cam1.note).not.toContain('אין כיול במצלמה הזו');
    expect(cam1.bottom).toBeLessThanOrEqual(cam1.vh + 1);
    expect(cam1.calibScroll).toBeLessThan(2);
    await page.waitForFunction(() => document.getElementById('cam1Snap')?.disabled === false);
    expect(await page.locator('#cam1Record').isDisabled()).toBe(true);
    expect(await page.locator('#cam1Snap').isDisabled()).toBe(false);

    await page.click('#opticsGimbalBtn');
    await page.waitForSelector('#gimbalSettings:not([hidden])');
    await page.waitForFunction(() => (document.getElementById('gimbalSettingsReason')?.textContent || '').includes('אין מענה מהגימבל'));
    expect(await page.locator('#gimbalSettingsCenter').isDisabled()).toBe(true);
    expect(await page.locator('#gimbalTrack').isDisabled()).toBe(true);
    expect(await page.locator('#gimbalTrackNote').innerText()).toContain('מעקב עדיין לא זמין');
    expect(posts).toEqual([]);
    await page.screenshot({ path: path.join(shotDir, 'optics-gimbal-down-1024x600.png'), animations: 'disabled' });

    gimbal = {
      present: true,
      mode: 'follow',
      control_enabled: false,
      attitude: { yaw: 12.5, pitch: -3.2 },
      zoom: 1,
    };
    await page.waitForFunction(() => (document.getElementById('gimbalPadReason')?.textContent || '').includes('שליטת הגימבל כבויה'));
    expect(await page.locator('#gimbalPad [data-gimbal="up"]').isDisabled()).toBe(true);
    expect(await page.locator('#gimbalPad [data-gimbal="down"]').isDisabled()).toBe(true);
    expect(await page.locator('#gimbalPad [data-gimbal="center"]').isDisabled()).toBe(true);
    expect(await page.locator('#gimbalPad [data-gimbal="zoom-in"]').isDisabled()).toBe(true);
    expect(await page.locator('#gimbalPad [data-gimbal="zoom-out"]').isDisabled()).toBe(true);
    expect(posts).toEqual([]);

    gimbal = {
      present: true,
      mode: 'follow',
      control_enabled: true,
      attitude: { yaw: 12.5, pitch: -3.2 },
      zoom: 1,
    };
    await page.waitForFunction(() => document.getElementById('gimbalSettingsCenter')?.disabled === false);
    expect(await page.locator('#gimbalSettingsYaw').innerText()).toContain('12.5');
    expect(await page.locator('#gimbalSettingsPitch').innerText()).toContain('-3.2');
    expect(await page.locator('#gimbalTrack').isDisabled()).toBe(true);
    await page.fill('#gimbalSpeed', '25');
    await page.dispatchEvent('#gimbalSpeed', 'input');
    await page.dispatchEvent('#gimbalSpeed', 'change');
    expect(await page.locator('#gimbalSpeed').getAttribute('data-speed')).toBe('25');
    await page.click('#gimbalSettingsCenter');
    await page.click('#gimbalSettingsSnap');
    await page.click('#gimbalSettingsRecord');
    await page.click('#gimbalSettingsMode');
    await page.locator('#gimbalPad [data-gimbal="up"]').dispatchEvent('pointerdown');
    const waitPosts = Date.now();
    while (!posts.some((row) => row.url.endsWith('/gimbal/angle') && String(row.body || '').includes('"pitch":-25')) && Date.now() - waitPosts < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const urls = posts.map((row) => row.url);
    expect(urls.some((url) => url.endsWith('/gimbal/center'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/gimbal/photo'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/gimbal/record'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/gimbal/mode'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/gimbal/rate'))).toBe(false);
    const angle = posts.find((row) => row.url.endsWith('/gimbal/angle') && String(row.body || '').includes('"pitch":-25'));
    expect(angle?.body || '').toContain('"yaw":0');
    expect(posts.some((row) => String(row.body || '').includes('"pitch":0'))).toBe(false);
    await page.locator('#gimbalPad [data-gimbal="up"]').dispatchEvent('pointerup');
    const afterRelease = posts.length;
    await new Promise((r) => setTimeout(r, 350));
    expect(posts.slice(afterRelease).some((row) => String(row.body || '').includes('"pitch":0'))).toBe(false);
    await page.locator('#gimbalPad [data-gimbal="zoom-in"]').dispatchEvent('pointerdown');
    const waitZoom = Date.now();
    while (!posts.some((row) => row.url.endsWith('/gimbal/zoom') && String(row.body || '').includes('"zoom":1')) && Date.now() - waitZoom < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(posts.some((row) => row.url.endsWith('/gimbal/zoom') && String(row.body || '').includes('"zoom":1'))).toBe(true);
    await page.locator('#gimbalPad [data-gimbal="zoom-out"]').dispatchEvent('pointerdown');
    const waitZoomOut = Date.now();
    while (!posts.some((row) => row.url.endsWith('/gimbal/zoom') && String(row.body || '').includes('"zoom":-1')) && Date.now() - waitZoomOut < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(posts.some((row) => row.url.endsWith('/gimbal/zoom') && String(row.body || '').includes('"zoom":-1'))).toBe(true);
    await page.locator('#gimbalPad [data-gimbal="zoom-out"]').dispatchEvent('pointerup');
    expect(posts.some((row) => String(row.body || '').includes('track'))).toBe(false);
    await page.screenshot({ path: path.join(shotDir, 'optics-gimbal-live-1024x600.png'), animations: 'disabled' });
    await page.click('#opticsCam0Btn');
    await page.screenshot({ path: path.join(shotDir, 'optics-cam0-1024x600.png'), animations: 'disabled' });
    await page.click('#opticsCam1Btn');
    await page.screenshot({ path: path.join(shotDir, 'optics-cam1-1024x600.png'), animations: 'disabled' });
  }, 60000);
});
