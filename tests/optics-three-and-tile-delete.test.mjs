import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { frameArrivalIsCurrent } from '../public/modules/camera-latest-frame.mjs';
import { boxesFromDetectionList } from '../public/modules/gimbal-screen.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4044';
const BASE = `http://127.0.0.1:${PORT}`;

describe('latest frame and lock boxes', () => {
  it('drops a stale JPEG generation and keeps the newest', () => {
    expect(frameArrivalIsCurrent(2, 2)).toBe(true);
    expect(frameArrivalIsCurrent(1, 2)).toBe(false);
    expect(frameArrivalIsCurrent(0, 0)).toBe(false);
  });

  it('draws only boxes that already exist', () => {
    expect(boxesFromDetectionList(null)).toEqual([]);
    expect(boxesFromDetectionList([])).toEqual([]);
    expect(boxesFromDetectionList([{ bbox_px: [120, 80, 220, 180], label_he: 'מטרה' }])).toEqual([
      { x: 120, y: 80, w: 100, h: 100, label: 'מטרה' },
    ]);
    expect(boxesFromDetectionList([{ id: 'empty' }])).toEqual([]);
  });
});

describe('three-camera proportions and tile delete', () => {
  let serverProc = null;
  let browser = null;
  let page = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-optics-tiles-${PORT}.sqlite` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
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

  it('makes the gimbal the main square and keeps the other cameras fully inside', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('vlc.debrief.cameras.v2', JSON.stringify(['cam0', 'cam1', 'a8'])));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#debriefCamGrid[data-count="3"]');
    const box = await page.evaluate(() => {
      const grid = document.getElementById('debriefCamGrid').getBoundingClientRect();
      const tiles = [...document.querySelectorAll('.debrief-cam-tile')].filter((el) => !el.hidden);
      const rect = (cam) => {
        const el = tiles.find((tile) => tile.dataset.cam === cam);
        const r = el.getBoundingClientRect();
        const media = getComputedStyle(el.querySelector('.debrief-cam-media'));
        return {
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          fit: media.objectFit,
        };
      };
      const gimbal = rect('a8');
      const forward = rect('cam0');
      const down = rect('cam1');
      const inside = (tile) => tile.left >= grid.left - 1 && tile.right <= grid.right + 1
        && tile.top >= grid.top - 1 && tile.bottom <= grid.bottom + 1;
      const ratio = gimbal.width / gimbal.height;
      return {
        gimbal, forward, down, ratio,
        inside: inside(gimbal) && inside(forward) && inside(down),
        pressed: [...document.querySelectorAll('[data-debrief-cam]')].filter((btn) => btn.getAttribute('aria-pressed') === 'true').map((btn) => btn.dataset.debriefCam),
      };
    });
    expect(box.gimbal.height).toBeGreaterThan(box.forward.height + 20);
    expect(box.gimbal.height).toBeGreaterThan(box.down.height + 20);
    expect(box.gimbal.width).toBeGreaterThan(box.forward.width);
    expect(box.gimbal.width).toBeGreaterThan(box.down.width);
    expect(box.ratio).toBeGreaterThan(0.75);
    expect(box.ratio).toBeLessThan(1.25);
    expect(box.forward.fit).toBe('contain');
    expect(box.down.fit).toBe('contain');
    expect(box.gimbal.fit).toBe('contain');
    expect(box.inside).toBe(true);
    expect(box.down.top).toBeGreaterThanOrEqual(box.forward.bottom - 8);
    expect(box.pressed.sort()).toEqual(['a8', 'cam0', 'cam1']);
  }, 30000);

  it('right-click deletes a flight tile and does not send a command', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('visionLandingMissionDataHiddenV1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="terrain"]');
    await page.waitForSelector('[data-mission-data-slot="1"]');
    await page.evaluate(() => {
      window.__vlcFetchUrls = [];
      const orig = window.fetch.bind(window);
      window.fetch = (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        window.__vlcFetchUrls.push(String(url));
        return orig(...args);
      };
    });
    await page.locator('[data-mission-data-slot="1"]').click({ button: 'right' });
    const after = await page.evaluate(() => {
      const tile = document.querySelector('[data-mission-data-slot="1"]');
      const picker = document.getElementById('missionDataPicker');
      return {
        hidden: tile.hidden,
        pickerHidden: picker.classList.contains('hidden'),
        stored: JSON.parse(localStorage.getItem('visionLandingMissionDataHiddenV1') || '[]'),
        urls: window.__vlcFetchUrls,
      };
    });
    expect(after.hidden).toBe(true);
    expect(after.pickerHidden).toBe(true);
    expect(after.stored).toContain('1');
    expect(after.urls.some((url) => /arm|disarm|flight-mode|param-set|\/apply|\/restart|\/command/i.test(url))).toBe(false);
    await page.click('#missionDataAddBtn');
    const restored = await page.evaluate(() => document.querySelector('[data-mission-data-slot="1"]').hidden);
    expect(restored).toBe(false);
  }, 30000);
});
