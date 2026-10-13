import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { qaShotDir } from './shot-dir.mjs';
import { startTestServer } from './test-server.mjs';

const shotDir = qaShotDir('horizon-video-toggles');
const IDS = ['horizonVideoToggle', 'annotatedVisionToggle', 'liveCameraToggle'];
const COPY = {
  horizonVideoToggle: ['תמונת שידור באופק', 'שידור חי מהמצלמה הראשונה שמשדרת, או כתובת שמורה'],
  annotatedVisionToggle: ['ראייה מסומנת', 'זרם מסומן ממחשב המשימה, בסלולר בלבד'],
  liveCameraToggle: ['פריימים חיים', 'שלושה פריימים: קדמית, מטה וגימבל'],
};

describe('horizon video rows are switches in the camera-row style', () => {
  let serverProc = null;
  let browser = null;
  let page = null;
  let base = '';

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    const started = await startTestServer({
      env: (port) => ({ SQLITE_PATH: `/tmp/airvix-horizon-toggles-${port}.sqlite` }),
    });
    serverProc = started.child;
    base = started.base;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="terrain"]');
    await page.waitForSelector('#pfdHorizonStage', { state: 'visible' });
    const stage = await page.locator('#pfdHorizonStage').boundingBox();
    await page.mouse.click(stage.x + stage.width / 2, stage.y + Math.min(80, stage.height - 8), { button: 'right' });
    await page.waitForSelector('#horizonCameraMenu:not([hidden])');
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  it('shows a switch, a short explanation, and the same on-state as a camera row', async () => {
    await page.locator('[data-horizon-cam="cam3"]').click();
    await page.locator('#pfdHorizonStage').click({ button: 'right' });
    await page.waitForSelector('#horizonCameraMenu:not([hidden])');
    await page.locator('#annotatedVisionToggle').click();
    await page.mouse.move(0, 0);

    const face = await page.evaluate((ids) => {
      const bg = (el) => getComputedStyle(el).backgroundColor;
      const cam = document.querySelector('[data-horizon-cam="cam3"]');
      const rows = ids.map((id) => {
        const btn = document.getElementById(id);
        const sw = btn.querySelector('.horizon-menu-switch');
        const swBox = sw.getBoundingClientRect();
        const knobOn = getComputedStyle(sw, '::after').insetInlineStart;
        return {
          id,
          role: btn.getAttribute('role'),
          pressed: btn.getAttribute('aria-pressed'),
          label: btn.querySelector('.horizon-menu-label')?.textContent || '',
          desc: btn.querySelector('.horizon-menu-desc')?.textContent || '',
          stateWords: btn.querySelector('.horizon-menu-state')?.textContent || '',
          switchBox: { w: swBox.width, h: swBox.height },
          knob: knobOn,
          bg: bg(btn),
          overflowX: btn.scrollWidth - btn.clientWidth,
          overflowY: btn.scrollHeight - btn.clientHeight,
          cursor: getComputedStyle(btn).cursor,
        };
      });
      return { camBg: bg(cam), rows };
    }, IDS);

    expect(face.camBg).toBe('rgb(15, 118, 110)');
    const on = face.rows.find((row) => row.id === 'annotatedVisionToggle');
    const off = face.rows.find((row) => row.id === 'horizonVideoToggle');
    expect(on.pressed).toBe('true');
    expect(on.bg).toBe(face.camBg);
    expect(on.knob).not.toBe(off.knob);
    expect(off.pressed).toBe('false');
    expect(off.bg).not.toBe(face.camBg);
    for (const row of face.rows) {
      expect(row.role).toBe('menuitemcheckbox');
      expect(row.label).toBe(COPY[row.id][0]);
      expect(row.desc).toBe(COPY[row.id][1]);
      expect(row.stateWords).toBe('');
      expect(row.switchBox.w).toBeGreaterThanOrEqual(40);
      expect(row.switchBox.h).toBeGreaterThanOrEqual(20);
      expect(row.cursor).toBe('pointer');
      expect(row.overflowX).toBeLessThanOrEqual(1);
      expect(row.overflowY).toBeLessThanOrEqual(1);
    }
    const file = path.join(shotDir, 'horizon-video-toggles.png');
    await page.locator('#horizonCameraMenu').screenshot({ path: file });
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
  }, 20000);
});
