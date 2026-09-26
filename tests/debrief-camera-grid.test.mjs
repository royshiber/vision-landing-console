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
    expect(html).toContain('data-debrief-cam="cam0"');
    expect(html).toContain('data-debrief-cam="cam1"');
    expect(html).toContain('data-debrief-cam="a8"');
    expect(html).toContain('id="flightVideo"');
    expect(html).toContain('אין אות');
    expect(css).toMatch(/\.debrief-cam-tile\[data-mono="1"\][\s\S]*filter:\s*grayscale\(1\)/);
    expect(css).toMatch(/object-fit:\s*contain/);
    expect(js).toContain('vlc.horizon.bgCamera.v1');
    expect(js).toContain('בלי מצלמה');
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

  async function setOpen(ids) {
    for (const id of ['cam0', 'cam1', 'a8']) {
      const pressed = await page.getAttribute(`[data-debrief-cam="${id}"]`, 'aria-pressed');
      const want = ids.includes(id);
      if ((pressed === 'true') !== want) await page.click(`[data-debrief-cam="${id}"]`);
    }
  }

  it('fills, splits, and stacks cameras and remembers the choice', async () => {
    await openDebrief();
    await setOpen(['cam0']);
    let box = await page.evaluate(() => {
      const grid = document.getElementById('debriefCamGrid');
      const tile = document.querySelector('.debrief-cam-tile[data-cam="cam0"]');
      const note = tile.querySelector('.debrief-cam-nosignal');
      const img = tile.querySelector('.debrief-cam-live');
      const gr = grid.getBoundingClientRect();
      const tr = tile.getBoundingClientRect();
      return {
        count: grid.dataset.count,
        note: note.textContent,
        noteHidden: note.hidden,
        imgHidden: img.hidden,
        mono: getComputedStyle(tile.querySelector('.debrief-cam-media') || tile).filter,
        tileW: tr.width,
        gridW: gr.width,
        stored: localStorage.getItem('vlc.debrief.cameras.v1'),
      };
    });
    expect(box.count).toBe('1');
    expect(box.note).toBe('אין אות');
    expect(box.noteHidden).toBe(false);
    expect(box.imgHidden).toBe(true);
    expect(box.tileW / box.gridW).toBeGreaterThan(0.9);
    await page.screenshot({ path: path.join(shotDir, 'grid-1.png') });

    await setOpen(['cam0', 'cam1']);
    box = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.debrief-cam-tile')].filter((el) => !el.hidden);
      const rs = tiles.map((el) => el.getBoundingClientRect());
      return {
        count: document.getElementById('debriefCamGrid').dataset.count,
        n: tiles.length,
        sideBySide: Math.abs(rs[0].top - rs[1].top) < 8
          && (rs[0].right <= rs[1].left + 8 || rs[1].right <= rs[0].left + 8),
        similar: Math.abs(rs[0].width - rs[1].width) < 12,
      };
    });
    expect(box.count).toBe('2');
    expect(box.n).toBe(2);
    expect(box.sideBySide).toBe(true);
    expect(box.similar).toBe(true);
    await page.screenshot({ path: path.join(shotDir, 'grid-2.png') });

    await setOpen(['cam0', 'cam1', 'a8']);
    box = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.debrief-cam-tile')].filter((el) => !el.hidden);
      const rs = tiles.map((el) => ({ cam: el.dataset.cam, ...el.getBoundingClientRect().toJSON() }));
      const big = rs.find((r) => r.cam === 'cam0');
      const small = rs.filter((r) => r.cam !== 'cam0');
      return {
        count: document.getElementById('debriefCamGrid').dataset.count,
        bigTaller: big.height > small[0].height + 20,
        stacked: small[1].top >= small[0].bottom - 8,
        contain: getComputedStyle(tiles[0].querySelector('.debrief-cam-media')).objectFit,
      };
    });
    expect(box.count).toBe('3');
    expect(box.bigTaller).toBe(true);
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
    await openDebrief();
    await setOpen(['cam0', 'a8']);
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
    expect(menu.text).toContain('Cam0');
    expect(menu.text).toContain('A8');
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
});
