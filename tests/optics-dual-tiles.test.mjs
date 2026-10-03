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
    await page.click('[data-tab="optics"]');
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
            pressed: document.querySelector('[data-debrief-cam="a8"]')?.getAttribute('aria-pressed'),
            camToggles: document.querySelectorAll('[data-debrief-cam="cam0"], [data-debrief-cam="cam1"]').length,
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
        expect(box.pressed).toBe('false');
        expect(box.camToggles).toBe(2);
        expect(box.sideBySide).toBe(true);
        expect(box.legacy).toBeNull();
        expect(box.gimbal).toBe(true);
      } finally {
        await page.close();
      }
    }, 30000);
  }

  it('keeps both tiles and uses #opticsCam1Btn for the settings tab', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
    try {
      await openOptics(page);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam0"]').isHidden()).toBe(false);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam1"]').isHidden()).toBe(false);
      await page.click('#opticsCam1Btn');
      expect(await page.getAttribute('#opticsCam1Btn', 'aria-selected')).toBe('true');
      expect(await page.locator('.debrief-cam-tile[data-cam="cam1"]').isHidden()).toBe(false);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam0"]').isHidden()).toBe(false);
      await page.click('[data-debrief-cam="a8"]');
      await page.waitForFunction(() => document.getElementById('debriefCamGrid').dataset.count === '3');
      expect(await page.locator('.debrief-cam-tile[data-cam="a8"]').isHidden()).toBe(false);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam0"]').isHidden()).toBe(false);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam1"]').isHidden()).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it('lights only the gimbal when it is the only stored camera', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
    try {
      await page.addInitScript(() => {
        localStorage.setItem('vlc.debrief.cameras.v2', '[]');
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="optics"]');
      await page.waitForSelector('#debriefCamGrid[data-count="0"]');
      expect(await page.locator('#debriefCamEmpty').innerText()).toBe('בחרו מצלמה');
      await page.locator('[data-debrief-cam="a8"]').click();
      const only = await page.evaluate(() => ({
        stored: JSON.parse(localStorage.getItem('vlc.debrief.cameras.v2') || 'null'),
        pressed: {
          cam0: document.querySelector('[data-debrief-cam="cam0"]')?.getAttribute('aria-pressed'),
          cam1: document.querySelector('[data-debrief-cam="cam1"]')?.getAttribute('aria-pressed'),
          gimbal: document.querySelector('[data-debrief-cam="a8"]')?.getAttribute('aria-pressed'),
        },
        hidden: {
          cam0: document.querySelector('.debrief-cam-tile[data-cam="cam0"]')?.hidden,
          cam1: document.querySelector('.debrief-cam-tile[data-cam="cam1"]')?.hidden,
          gimbal: document.querySelector('.debrief-cam-tile[data-cam="a8"]')?.hidden,
        },
      }));
      expect(only.stored).toEqual(['a8']);
      expect(only.pressed).toEqual({ cam0: 'false', cam1: 'false', gimbal: 'true' });
      expect(only.hidden).toEqual({ cam0: true, cam1: true, gimbal: false });

      await page.locator('[data-debrief-cam="cam0"]').click();
      await page.locator('[data-debrief-cam="cam1"]').click();
      await page.locator('[data-debrief-cam="cam0"]').click();
      await page.locator('[data-debrief-cam="cam1"]').click();
      const left = await page.evaluate(() => ({
        stored: JSON.parse(localStorage.getItem('vlc.debrief.cameras.v2') || 'null'),
        pressed: {
          cam0: document.querySelector('[data-debrief-cam="cam0"]')?.getAttribute('aria-pressed'),
          cam1: document.querySelector('[data-debrief-cam="cam1"]')?.getAttribute('aria-pressed'),
          gimbal: document.querySelector('[data-debrief-cam="a8"]')?.getAttribute('aria-pressed'),
        },
      }));
      expect(left.stored).toEqual(['a8']);
      expect(left.pressed).toEqual({ cam0: 'false', cam1: 'false', gimbal: 'true' });
    } finally {
      await page.close();
    }
  }, 30000);

  it('keeps the first camera when a second is chosen and paints the gimbal frame', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route(/\/api\/jetson\/v1\/cameras\/cam3\/frame/, (route) => {
        route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
      });
      await openOptics(page);
      await page.locator('[data-debrief-cam="cam1"]').click();
      expect(await page.locator('.debrief-cam-tile[data-cam="cam0"]').isHidden()).toBe(false);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam1"]').isHidden()).toBe(true);
      await page.locator('[data-debrief-cam="cam1"]').click();
      expect(await page.locator('.debrief-cam-tile[data-cam="cam0"]').isHidden()).toBe(false);
      expect(await page.locator('.debrief-cam-tile[data-cam="cam1"]').isHidden()).toBe(false);
      await page.locator('[data-debrief-cam="a8"]').click();
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-cam="a8"] .debrief-cam-live');
        const src = img?.getAttribute('src') || '';
        const cam0 = document.querySelector('.debrief-cam-tile[data-cam="cam0"]');
        const cam1 = document.querySelector('.debrief-cam-tile[data-cam="cam1"]');
        return img && img.hidden === false && img.naturalWidth > 0
          && src.includes('/api/jetson/v1/cameras/cam3/frame')
          && cam0 && !cam0.hidden
          && cam1 && !cam1.hidden;
      });
      await page.locator('[data-debrief-cam="cam0"]').click();
      const left = await page.evaluate(() => ({
        cam0: document.querySelector('.debrief-cam-tile[data-cam="cam0"]')?.hidden,
        cam1: document.querySelector('.debrief-cam-tile[data-cam="cam1"]')?.hidden,
        gimbal: document.querySelector('.debrief-cam-tile[data-cam="a8"]')?.hidden,
        pressed: {
          cam1: document.querySelector('[data-debrief-cam="cam1"]')?.getAttribute('aria-pressed'),
          gimbal: document.querySelector('[data-debrief-cam="a8"]')?.getAttribute('aria-pressed'),
        },
      }));
      expect(left.cam0).toBe(true);
      expect(left.cam1).toBe(false);
      expect(left.gimbal).toBe(false);
      expect(left.pressed.cam1).toBe('true');
      expect(left.pressed.gimbal).toBe('true');
    } finally {
      await page.close();
    }
  }, 30000);

  it('on a phone, choosing a camera shows that picture and marks only that button', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const hits = { cam0: 0, cam1: 0, cam3: 0 };
      await page.route(/\/api\/jetson\/v1\/cameras\/cam[013]\/frame/, (route) => {
        const url = route.request().url();
        if (url.includes('/cameras/cam0/frame')) hits.cam0 += 1;
        else if (url.includes('/cameras/cam1/frame')) hits.cam1 += 1;
        else if (url.includes('/cameras/cam3/frame')) hits.cam3 += 1;
        else return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
      });
      await page.route(/\/api\/jetson\/v1\/cam1\/stream\.mjpg/, (route) => {
        route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="optics"]');
      await page.waitForSelector('#debriefCamGrid');
      await page.evaluate((detail) => {
        document.dispatchEvent(new CustomEvent('vlc-companion-cameras', { detail }));
      }, {
        cameras: {
          cam0: { camera_ok: true, state: 'streaming', fps: 30, has_frame: true, frame_count: 4 },
          cam1: { camera_ok: true, state: 'streaming', fps: 30, has_frame: true, frame_count: 4 },
          cam3: { camera_ok: true, state: 'streaming', fps: 15, has_frame: true, frame_count: 2 },
        },
      });

      await page.locator('[data-debrief-cam="a8"]').click();
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-cam="a8"] .debrief-cam-live');
        const src = img?.getAttribute('src') || '';
        return img && img.hidden === false && img.naturalWidth > 0
          && src.includes('/api/jetson/v1/cameras/cam3/frame')
          && document.querySelector('.debrief-cam-tile[data-cam="cam0"]')?.hidden === true
          && document.querySelector('.debrief-cam-tile[data-cam="cam1"]')?.hidden === true;
      });
      const marked = await page.evaluate(() => {
        const btn = (id) => document.querySelector(`[data-debrief-cam="${id}"]`);
        const bg = (id) => getComputedStyle(btn(id)).backgroundColor;
        const gimbalTab = document.getElementById('opticsGimbalBtn');
        const cam0Tab = document.getElementById('opticsCam0Btn');
        return {
          labels: [...document.querySelectorAll('#optics .debrief-cam-toggle')].map((el) => el.textContent.trim()),
          pressed: {
            cam0: btn('cam0').getAttribute('aria-pressed'),
            cam1: btn('cam1').getAttribute('aria-pressed'),
            gimbal: btn('a8').getAttribute('aria-pressed'),
          },
          bg: { cam0: bg('cam0'), cam1: bg('cam1'), gimbal: bg('a8') },
          settings: gimbalTab?.getAttribute('aria-selected'),
          settingsBg: getComputedStyle(gimbalTab).backgroundColor,
          idleBg: getComputedStyle(cam0Tab).backgroundColor,
        };
      });
      expect(marked.labels).toEqual(['קדמית', 'מטה', 'גימבל']);
      expect(marked.pressed).toEqual({ cam0: 'false', cam1: 'false', gimbal: 'true' });
      expect(marked.bg.gimbal).toBe('rgb(15, 118, 110)');
      expect(marked.bg.gimbal).not.toBe(marked.bg.cam0);
      expect(marked.bg.gimbal).not.toBe(marked.bg.cam1);
      expect(marked.settings).toBe('true');
      expect(marked.settingsBg).toBe('rgb(15, 118, 110)');
      expect(marked.settingsBg).not.toBe(marked.idleBg);

      await page.locator('[data-debrief-cam="cam0"]').click();
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-cam="cam0"] .debrief-cam-live');
        const src = img?.getAttribute('src') || '';
        return img && img.hidden === false && img.naturalWidth > 0
          && src.includes('/api/jetson/v1/cameras/cam0/frame')
          && !src.includes('/cameras/cam3/')
          && document.querySelector('.debrief-cam-tile[data-cam="a8"]')?.hidden === true
          && document.querySelector('[data-debrief-cam="cam0"]')?.getAttribute('aria-pressed') === 'true'
          && document.querySelector('[data-debrief-cam="a8"]')?.getAttribute('aria-pressed') === 'false';
      });

      await page.locator('[data-debrief-cam="cam1"]').click();
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-cam="cam1"] .debrief-cam-live');
        const src = img?.getAttribute('src') || '';
        return img && img.hidden === false && img.naturalWidth > 0
          && src.includes('/api/jetson/v1/cameras/cam1/frame')
          && document.querySelector('.debrief-cam-tile[data-cam="cam0"]')?.hidden === true
          && document.querySelector('[data-debrief-cam="cam1"]')?.getAttribute('aria-pressed') === 'true'
          && document.querySelector('[data-debrief-cam="cam0"]')?.getAttribute('aria-pressed') === 'false';
      });
      expect(hits.cam0).toBeGreaterThan(0);
      expect(hits.cam1).toBeGreaterThan(0);
      expect(hits.cam3).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('on a phone, a missing gimbal frame stays אין אות', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.route(/\/api\/jetson\/v1\/cameras\/cam3\/frame/, (route) => {
        route.fulfill({ status: 404, contentType: 'application/json', body: '{"reason":"no_frame"}' });
      });
      await page.route(/\/api\/jetson\/v1\/cameras\/cam0\/frame/, (route) => {
        route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
      });
      await page.addInitScript(() => {
        localStorage.setItem('vlc.debrief.cameras.v2', JSON.stringify(['cam0']));
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="optics"]');
      await page.waitForSelector('#debriefCamGrid');
      await page.evaluate((detail) => {
        document.dispatchEvent(new CustomEvent('vlc-companion-cameras', { detail }));
      }, {
        cameras: {
          cam0: { camera_ok: true, state: 'streaming', fps: 30, has_frame: true, frame_count: 4 },
        },
      });
      await page.locator('[data-debrief-cam="a8"]').click();
      await page.waitForFunction(() => {
        const tile = document.querySelector('.debrief-cam-tile[data-cam="a8"]');
        const img = tile?.querySelector('.debrief-cam-live');
        const note = tile?.querySelector('.debrief-cam-nosignal');
        const src = img?.getAttribute('src') || '';
        return tile && tile.hidden === false
          && img && img.hidden === true
          && src === ''
          && note && note.hidden === false
          && note.textContent === 'אין אות'
          && document.querySelector('.debrief-cam-tile[data-cam="cam0"]')?.hidden === true
          && document.querySelector('[data-debrief-cam="a8"]')?.getAttribute('aria-pressed') === 'true';
      });
    } finally {
      await page.close();
    }
  }, 30000);
});
