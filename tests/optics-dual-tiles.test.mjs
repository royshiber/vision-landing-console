import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4036';
const BASE = `http://127.0.0.1:${PORT}`;
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABmX/9k=',
  'base64',
);
const LIVE = {
  cameras: {
    cam0: { camera_ok: true, state: 'streaming', fps: 30, has_frame: true, frame_count: 4 },
    cam1: { camera_ok: true, state: 'streaming', fps: 30, has_frame: true, frame_count: 4 },
  },
};

describe('Optics CAM0 and CAM1 tiles', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT,
        SQLITE_PATH: `/tmp/airvix-dual-tiles-${PORT}.sqlite`,
        COMPANION_MODE: 'off',
      },
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
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function openOptics(page) {
    const frames = { cam0: 0, cam1: 0 };
    await page.route(/\/api\/jetson\/v1\/cameras\/cam[01]\/frame/, (route) => {
      const url = route.request().url();
      if (url.includes('/cameras/cam0/frame')) frames.cam0 += 1;
      if (url.includes('/cameras/cam1/frame')) frames.cam1 += 1;
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
    });
    await page.route(/\/api\/jetson\/v1\/cam1\/stream\.mjpg/, (route) => {
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
    });
    await page.addInitScript(() => {
      localStorage.setItem('vlc.debrief.cameras.v1', JSON.stringify(['cam0']));
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="recordings"]');
    await page.waitForSelector('#debriefCamGrid');
    await page.evaluate((detail) => {
      document.dispatchEvent(new CustomEvent('vlc-companion-cameras', { detail }));
    }, LIVE);
    await page.waitForFunction(() => {
      const src = (cam) => document.querySelector(`[data-cam="${cam}"] .debrief-cam-live`)?.getAttribute('src') || '';
      return src('cam1').includes('/api/jetson/v1/cameras/cam1/frame');
    });
    const sawBoth = await page.evaluate((detail) => {
      document.dispatchEvent(new CustomEvent('vlc-companion-cameras', { detail }));
      const src = (cam) => document.querySelector(`[data-cam="${cam}"] .debrief-cam-live`)?.getAttribute('src') || '';
      return src('cam0').includes('/api/jetson/v1/cameras/cam0/frame')
        && src('cam1').includes('/api/jetson/v1/cameras/cam1/frame');
    }, LIVE);
    if (!sawBoth) throw new Error('both tiles did not request frames');
    return frames;
  }

  for (const [width, height] of [[1024, 576], [1440, 900]]) {
    it(`shows CAM0 and CAM1 side by side and both request frames at ${width}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        const frames = await openOptics(page);
        expect(frames.cam0).toBeGreaterThan(0);
        expect(frames.cam1).toBeGreaterThan(0);
        const box = await page.evaluate(() => {
          const tiles = ['cam0', 'cam1'].map((id) => document.querySelector(`.debrief-cam-tile[data-cam="${id}"]`));
          const rs = tiles.map((el) => el.getBoundingClientRect());
          return {
            count: document.getElementById('debriefCamGrid').dataset.count,
            hidden: tiles.map((el) => el.hidden),
            pressed: ['cam0', 'cam1', 'a8'].map((id) => document.querySelector(`[data-debrief-cam="${id}"]`).getAttribute('aria-pressed')),
            sideBySide: Math.abs(rs[0].top - rs[1].top) < 8
              && rs[0].width > 40
              && rs[1].width > 40
              && (rs[0].right <= rs[1].left + 8 || rs[1].right <= rs[0].left + 8),
            legacy: localStorage.getItem('vlc.debrief.cameras.v1'),
            gimbal: document.getElementById('gimbalPad') != null,
          };
        });
        expect(box.count).toBe('2');
        expect(box.hidden).toEqual([false, false]);
        expect(box.pressed).toEqual(['true', 'true', 'false']);
        expect(box.sideBySide).toBe(true);
        expect(box.legacy).toBeNull();
        expect(box.gimbal).toBe(true);
      } finally {
        await page.close();
      }
    }, 30000);
  }

  it('toggles each pill and #opticsCam1Btn opens the CAM1 tile', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
    try {
      const frames = await openOptics(page);
      const before = frames.cam1;
      await page.click('[data-debrief-cam="cam1"]');
      await page.waitForFunction(() => document.querySelector('.debrief-cam-tile[data-cam="cam1"]').hidden === true);
      expect(await page.getAttribute('[data-debrief-cam="cam1"]', 'aria-pressed')).toBe('false');

      await page.click('#opticsCam1Btn');
      await page.waitForFunction(() => {
        const tile = document.querySelector('.debrief-cam-tile[data-cam="cam1"]');
        const src = tile.querySelector('.debrief-cam-live')?.getAttribute('src') || '';
        return tile.hidden === false && src.includes('/api/jetson/v1/cameras/cam1/frame');
      });
      expect(await page.getAttribute('#opticsCam1Btn', 'aria-selected')).toBe('true');
      expect(await page.getAttribute('[data-debrief-cam="cam1"]', 'aria-pressed')).toBe('true');
      expect(frames.cam1).toBeGreaterThan(before);

      await page.click('[data-debrief-cam="a8"]');
      await page.waitForFunction(() => document.getElementById('debriefCamGrid').dataset.count === '3');
      expect(await page.locator('.debrief-cam-tile[data-cam="a8"]').isHidden()).toBe(false);

      await page.click('[data-debrief-cam="cam0"]');
      await page.waitForFunction(() => document.querySelector('.debrief-cam-tile[data-cam="cam0"]').hidden === true);
      expect(await page.getAttribute('[data-debrief-cam="cam0"]', 'aria-pressed')).toBe('false');
      expect(await page.locator('.debrief-cam-tile[data-cam="cam1"]').isHidden()).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);
});
