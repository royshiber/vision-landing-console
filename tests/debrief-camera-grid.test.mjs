import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/flight-layout/cameras';
const PORT = '4032';
const BASE = `http://127.0.0.1:${PORT}`;
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

describe('Debrief camera grid and horizon menu — source', () => {
  it('offers Cam0, Cam1 and A8 without colorizing the mono sensor', () => {
    expect(html).toContain('data-cam="cam0"');
    expect(html).toContain('data-cam="cam1"');
    expect(html).toContain('data-debrief-cam="cam0"');
    expect(html).toContain('data-debrief-cam="cam1"');
    expect(html).toContain('data-debrief-cam="a8"');
    expect(html).toContain('id="opticsCam0Btn"');
    expect(html).toContain('id="opticsCam1Btn"');
    expect(html).toContain('id="flightVideo"');
    expect(html).toContain('אין אות');
    expect(css).toMatch(/\.debrief-cam-tile\[data-mono="1"\][\s\S]*filter:\s*grayscale\(1\)/);
    expect(css).toMatch(/object-fit:\s*contain/);
    expect(js).toContain('vlc.horizon.bgCamera.v1');
    expect(js).toContain('בלי מצלמה');
    expect(js).toContain('/api/jetson/v1/cameras/cam3/frame');
    expect(js).toContain('menuitemcheckbox');
    expect(js).toContain("addEventListener('contextmenu'");
  });
});

describe('Debrief camera grid and horizon menu — live', () => {
  let serverProc = null;
  let browser = null;
  let page = null;

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-cams-${PORT}.sqlite` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function openDebrief() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#debriefCamGrid');
  }

  async function setGimbal(on) {
    const pressed = await page.getAttribute('[data-debrief-cam="a8"]', 'aria-pressed');
    if ((pressed === 'true') !== on) await page.click('[data-debrief-cam="a8"]');
  }

  it('fills both cameras, stacks the gimbal, and remembers the choice', async () => {
    await openDebrief();
    await setGimbal(false);
    let box = await page.evaluate(() => {
      const grid = document.getElementById('debriefCamGrid');
      const tiles = [...document.querySelectorAll('.debrief-cam-tile')].filter((el) => !el.hidden);
      const tile = document.querySelector('.debrief-cam-tile[data-cam="cam0"]');
      const note = tile.querySelector('.debrief-cam-nosignal');
      const img = tile.querySelector('.debrief-cam-live');
      const rs = tiles.map((el) => el.getBoundingClientRect());
      return {
        count: grid.dataset.count,
        n: tiles.length,
        note: note.textContent,
        noteHidden: note.hidden,
        imgHidden: img.hidden,
        mono: getComputedStyle(tile.querySelector('.debrief-cam-media') || tile).filter,
        sideBySide: Math.abs(rs[0].top - rs[1].top) < 8
          && (rs[0].right <= rs[1].left + 8 || rs[1].right <= rs[0].left + 8),
        similar: Math.abs(rs[0].width - rs[1].width) < 12,
        stored: localStorage.getItem('vlc.debrief.cameras.v1'),
      };
    });
    expect(box.count).toBe('2');
    expect(box.n).toBe(2);
    expect(box.note).toBe('אין אות');
    expect(box.noteHidden).toBe(false);
    expect(box.imgHidden).toBe(true);
    expect(box.sideBySide).toBe(true);
    expect(box.similar).toBe(true);
    expect(box.stored).toBeNull();
    await page.screenshot({ path: path.join(shotDir, 'grid-2.png') });

    await setGimbal(true);
    box = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.debrief-cam-tile')].filter((el) => !el.hidden);
      const rs = tiles.map((el) => ({ cam: el.dataset.cam, ...el.getBoundingClientRect().toJSON() }));
      const gimbal = rs.find((r) => r.cam === 'a8');
      const small = rs.filter((r) => r.cam !== 'a8');
      const grid = document.getElementById('debriefCamGrid').getBoundingClientRect();
      const span = Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left));
      return {
        count: document.getElementById('debriefCamGrid').dataset.count,
        bigTaller: gimbal.height > small[0].height + 20 && gimbal.height > small[1].height + 20,
        filled: span > grid.width * 0.92,
        main: gimbal.width * gimbal.height > small[0].width * small[0].height
          && gimbal.width * gimbal.height > small[1].width * small[1].height,
        stacked: small[1].top >= small[0].bottom - 8,
        contain: getComputedStyle(tiles[0].querySelector('.debrief-cam-media')).objectFit,
      };
    });
    expect(box.count).toBe('3');
    expect(box.bigTaller).toBe(true);
    expect(box.filled).toBe(true);
    expect(box.main).toBe(true);
    expect(box.stacked).toBe(true);
    expect(box.contain).toBe('contain');
    await page.screenshot({ path: path.join(shotDir, 'grid-3.png') });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#debriefCamGrid[data-count="3"]');
    expect(await page.locator('.debrief-cam-tile:not([hidden])').count()).toBe(3);
  }, 30000);

  it('stacks two cameras on a narrow viewport', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('vlc.debrief.cameras.v2', JSON.stringify(['cam0', 'cam1'])));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#debriefCamGrid');
    const box = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.debrief-cam-tile')].filter((el) => !el.hidden);
      const rs = tiles.map((el) => el.getBoundingClientRect());
      return { stacked: rs[1].top >= rs[0].bottom - 8, similar: Math.abs(rs[0].height - rs[1].height) < 16 };
    });
    expect(box.stacked).toBe(true);
    expect(box.similar).toBe(true);
    await page.screenshot({ path: path.join(shotDir, 'grid-2-narrow.png') });
  }, 20000);

  it('opens a horizon camera menu that stays inside the viewport', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="terrain"]');
    await page.waitForSelector('#pfdHorizonStage', { state: 'visible' });
    const stage = await page.locator('#pfdHorizonStage').boundingBox();
    await page.mouse.click(stage.x + stage.width - 8, stage.y + 8, { button: 'right' });
    await page.waitForSelector('#horizonCameraMenu:not([hidden])');
    const menu = await page.evaluate(() => {
      const el = document.getElementById('horizonCameraMenu');
      const r = el.getBoundingClientRect();
      return {
        text: el.innerText,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    expect(menu.text).toContain('בלי מצלמה');
    expect(menu.text).toContain('קדמית');
    expect(menu.text).toContain('מטה');
    expect(menu.text).toContain('גימבל');
    expect(menu.text).not.toContain('A8');
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(menu.vw + 1);
    expect(menu.bottom).toBeLessThanOrEqual(menu.vh + 1);
    await page.screenshot({ path: path.join(shotDir, 'horizon-menu.png') });
    await page.keyboard.press('Escape');
    expect(await page.locator('#horizonCameraMenu').isHidden()).toBe(true);

    await page.mouse.click(stage.x + 20, stage.y + stage.height / 2, { button: 'left' });
    expect(await page.locator('#horizonCameraMenu').isHidden()).toBe(true);

    await page.locator('#horizonCameraMenu').evaluate(() => {});
    await page.mouse.click(stage.x + stage.width - 8, stage.y + 8, { button: 'right' });
    await page.locator('[data-horizon-cam="cam0"]').click();
    const after = await page.evaluate(() => ({
      stored: localStorage.getItem('vlc.horizon.bgCamera.v1'),
      note: document.getElementById('horizonCameraNote')?.hidden === false,
      noteText: document.getElementById('horizonCameraNote')?.textContent,
      imgHidden: document.getElementById('horizonCameraBg')?.hidden,
    }));
    expect(after.stored).toBe('cam0');
    expect(after.note).toBe(true);
    expect(after.noteText).toBe('אין אות');
    expect(after.imgHidden).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => localStorage.getItem('vlc.horizon.bgCamera.v1'))).toBe('cam0');
    expect(await page.locator('#horizonCameraNote').isVisible()).toBe(true);
  }, 40000);

  it('keeps the first horizon camera when the gimbal is chosen and paints its frame', async () => {
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABmX/9k=',
      'base64',
    );
    await page.route(/\/api\/jetson\/v1\/cameras\/cam3\/frame/, (route) => {
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg });
    });
    await page.evaluate(() => localStorage.setItem('vlc.horizon.bgCamera.v1', 'none'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="terrain"]');
    await page.waitForSelector('#pfdHorizonStage', { state: 'visible' });
    const stage = await page.locator('#pfdHorizonStage').boundingBox();
    await page.mouse.click(stage.x + stage.width - 8, stage.y + 8, { button: 'right' });
    await page.waitForSelector('#horizonCameraMenu:not([hidden])');
    await page.locator('[data-horizon-cam="cam0"]').click();
    if (await page.locator('#horizonCameraMenu').isHidden()) {
      await page.mouse.click(stage.x + stage.width - 8, stage.y + 8, { button: 'right' });
      await page.waitForSelector('#horizonCameraMenu:not([hidden])');
    }
    await page.locator('[data-horizon-cam="a8"]').click();
    const both = await page.evaluate(() => ({
      cam0: document.querySelector('[data-horizon-cam="cam0"]')?.getAttribute('aria-checked'),
      gimbal: document.querySelector('[data-horizon-cam="a8"]')?.getAttribute('aria-checked'),
      stored: JSON.parse(localStorage.getItem('vlc.horizon.bgCamera.v1') || 'null'),
      labels: [...document.querySelectorAll('[data-horizon-cam]')].map((el) => el.textContent),
    }));
    expect(both.cam0).toBe('true');
    expect(both.gimbal).toBe('true');
    expect(both.stored).toEqual(['cam0', 'a8']);
    expect(both.labels).toEqual(['בלי מצלמה', 'קדמית', 'מטה', 'גימבל']);
    await page.waitForFunction(() => {
      const img = document.querySelector('#horizonCameraStack [data-horizon-slot="a8"] .pfd-horizon-camera');
      const src = img?.dataset.liveFrame || img?.getAttribute('src') || '';
      return Boolean(img) && img.hidden === false && img.naturalWidth > 0 && src.includes('/api/jetson/v1/cameras/cam3/frame');
    });
    const ink = await page.evaluate(() => {
      const item = document.querySelector('[data-horizon-cam="a8"]');
      const menu = document.getElementById('horizonCameraMenu');
      const label = document.querySelector('#horizonCameraStack [data-horizon-slot="a8"] .horizon-cam-tile-label');
      const cs = (el) => {
        const s = getComputedStyle(el);
        return { color: s.color, bg: s.backgroundColor, size: parseFloat(s.fontSize) };
      };
      return { item: cs(item), menu: cs(menu), label: label ? cs(label) : null };
    });
    expect(ink.item.color).toBe('rgb(248, 250, 252)');
    expect(ink.item.size).toBeGreaterThanOrEqual(11);
    expect(ink.label.color).toBe('rgb(248, 250, 252)');
    expect(ink.label.size).toBeGreaterThanOrEqual(11);
    await page.screenshot({ path: path.join(shotDir, 'horizon-gimbal-with-cam0.png') });

    await page.locator('[data-horizon-cam="cam0"]').click();
    const left = await page.evaluate(() => ({
      cam0: document.querySelector('[data-horizon-cam="cam0"]')?.getAttribute('aria-checked'),
      gimbal: document.querySelector('[data-horizon-cam="a8"]')?.getAttribute('aria-checked'),
      stored: localStorage.getItem('vlc.horizon.bgCamera.v1'),
    }));
    expect(left.cam0).toBe('false');
    expect(left.gimbal).toBe('true');
    expect(left.stored).toBe('a8');
    await page.waitForFunction(() => {
      const img = document.getElementById('horizonCameraBg');
      const shell = document.getElementById('pfdHorizonShell');
      const stage = document.getElementById('pfdHorizonStage');
      const src = img?.dataset.liveFrame || img?.getAttribute('src') || '';
      const ir = img?.getBoundingClientRect();
      const sr = stage?.getBoundingClientRect();
      return img && img.hidden === false && img.naturalWidth > 0
        && src.includes('/api/jetson/v1/cameras/cam3/frame')
        && shell?.classList.contains('pfd-horizon-shell--video-active')
        && ir && sr && ir.width > sr.width * 0.9 && ir.height > sr.height * 0.9;
    });
    await page.screenshot({ path: path.join(shotDir, 'horizon-gimbal-frame.png') });
  }, 40000);

  it('keeps אין אות or the last gimbal picture after a second miss', async () => {
    await page.unroute(/\/api\/jetson\/v1\/cameras\/cam3\/frame/).catch(() => {});
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABmX/9k=',
      'base64',
    );
    let serveJpeg = true;
    await page.route(/\/api\/jetson\/v1\/cameras\/cam3\/frame/, (route) => {
      if (serveJpeg) {
        route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg });
        return;
      }
      route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no_frame"}' });
    });
    await page.addInitScript(() => {
      localStorage.setItem('vlc.debrief.cameras.v2', JSON.stringify(['a8']));
      localStorage.setItem('vlc.horizon.bgCamera.v1', 'none');
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('.debrief-cam-tile[data-cam="a8"]:not([hidden])');
    const live = {
      mode: 'real',
      reachable: true,
      vision: {
        cameras: {
          cam3: { camera_ok: true, state: 'streaming', fps: 20, last_frame_age_ms: 30, frame_count: 4, has_frame: true },
        },
      },
    };
    const paint = () => page.evaluate((detail) => {
      document.dispatchEvent(new CustomEvent('vlc-companion-cameras', { detail }));
    }, live);
    await page.waitForFunction(() => {
      const img = document.querySelector('.debrief-cam-tile[data-cam="a8"] .debrief-cam-live');
      return Number(img?.dataset.seen || 0) > 0 && img.hidden === false;
    });
    serveJpeg = false;
    await page.waitForFunction(() => {
      const img = document.querySelector('.debrief-cam-tile[data-cam="a8"] .debrief-cam-live');
      return Number(img?.dataset.misses || 0) === 1;
    });
    const one = await page.evaluate(() => {
      const tile = document.querySelector('.debrief-cam-tile[data-cam="a8"]');
      const img = tile.querySelector('.debrief-cam-live');
      const note = tile.querySelector('.debrief-cam-nosignal');
      return { misses: Number(img.dataset.misses || 0), imgHidden: img.hidden, noteHidden: note.hidden, src: Boolean(img.getAttribute('src')) };
    });
    expect(one.misses).toBe(1);
    expect(one.imgHidden).toBe(false);
    expect(one.noteHidden).toBe(true);
    expect(one.src).toBe(true);
    await page.waitForTimeout(750);
    await paint();
    await page.waitForFunction(() => {
      const img = document.querySelector('.debrief-cam-tile[data-cam="a8"] .debrief-cam-live');
      return Number(img?.dataset.misses || 0) >= 2;
    });
    await paint();
    await page.locator('.debrief-cam-tile[data-cam="a8"]').screenshot({
      path: path.join(shotDir, 'gimbal-second-miss.png'),
    });
    const two = await page.evaluate(() => {
      const tile = document.querySelector('.debrief-cam-tile[data-cam="a8"]');
      const img = tile.querySelector('.debrief-cam-live');
      const note = tile.querySelector('.debrief-cam-nosignal');
      const shown = img.hidden === false && Number(img.dataset.seen || 0) > 0 && Boolean(img.getAttribute('src'));
      const warned = note.hidden === false && note.textContent === 'אין אות';
      return {
        misses: Number(img.dataset.misses || 0),
        shown,
        warned,
        empty: img.hidden === true && note.hidden === true,
      };
    });
    expect(two.misses).toBeGreaterThanOrEqual(2);
    expect(two.empty).toBe(false);
    expect(two.shown || two.warned).toBe(true);
    await page.unroute(/\/api\/jetson\/v1\/cameras\/cam3\/frame/);
  }, 20000);
});
