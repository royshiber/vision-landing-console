/**
 * Runway overlay fit on a short flight screen, and the level menu stays
 * inside the viewport.
 */
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './test-server.mjs';
import { collectTextFitFailures } from './text-fit-audit.mjs';

const AWARENESS = {
  ok: true,
  level: 2,
  estimate: {
    detected: true,
    offset_px: 12,
    offset_m: 1.4,
    heading_error_deg: 3,
    confidence: { offset: 0.82, heading: 0.64, along: 0.5 },
    polygon: [[10, 10], [140, 12], [150, 90], [8, 88]],
    centerline: [[75, 12], [79, 90]],
    aircraft: [96, 70],
  },
  hazards: [{ kind: 'person', label_he: 'אדם', confidence: 0.91, bbox: [40, 40, 20, 30] }],
  adviceHe: 'יש אדם על המסלול. מומלץ ללכת סביב.',
  vision: { state: 'go_around', labelHe: 'סבוב מחדש', manualArm: false },
};

describe('runway awareness layout', () => {
  let proc = null;
  let browser = null;
  let page = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('stacks the alert above the tiles on a short stage and keeps the menu on screen', async () => {
    const started = await startTestServer({
      env: (port) => ({
        SQLITE_PATH: path.join(os.tmpdir(), `airvix-runway-ui-${port}.sqlite`),
        COMPANION_MODE: 'mock',
        JETSON_COMPANION_BASE_URL: '',
      }),
      stdio: 'ignore',
    });
    proc = started.child;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1024, height: 470 } });
    let armedNow = false;
    const armedVision = { state: 'active', labelHe: 'פעיל', manualArm: true, takeoverCh: 7 };
    await page.route('**/api/runway/vision-arm', (route) => {
      armedNow = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...AWARENESS, vision: armedVision }),
      });
    });
    await page.route('**/api/runway/awareness**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...AWARENESS,
        vision: armedNow ? armedVision : AWARENESS.vision,
      }),
    }));
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.tab[data-tab="terrain"]').click();
    await page.waitForFunction(() => {
      const tiles = document.getElementById('runwayAwarenessTiles');
      const alert = document.getElementById('runwayAwarenessAlert');
      return tiles && tiles.hidden === false && alert && alert.hidden === false
        && tiles.innerText.includes('%');
    });
    const fit = await page.evaluate(() => {
      const stage = document.getElementById('pfdHorizonStage');
      const tiles = document.getElementById('runwayAwarenessTiles');
      const alert = document.getElementById('runwayAwarenessAlert');
      const stageBox = stage.getBoundingClientRect();
      const tileBox = tiles.getBoundingClientRect();
      const alertBox = alert.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(alertBox.bottom, tileBox.bottom) - Math.max(alertBox.top, tileBox.top));
      return {
        overlap,
        alertAbove: alertBox.bottom <= tileBox.top + 1,
        tilesShare: tileBox.height / stageBox.height,
        stackShare: (Math.max(alertBox.bottom, tileBox.bottom) - Math.min(alertBox.top, tileBox.top)) / stageBox.height,
        inside: tileBox.left >= stageBox.left - 1 && tileBox.right <= stageBox.right + 1
          && tileBox.bottom <= stageBox.bottom + 1 && alertBox.top >= stageBox.top - 1,
        confidence: document.getElementById('runwayOffsetValue')?.innerText || '',
        mode: stage.getAttribute('data-awareness-mode'),
        runwayLevel: stage.hasAttribute('data-runway-level'),
        runwayLane: stage.hasAttribute('data-runway-lane'),
      };
    });
    expect(fit.alertAbove).toBe(true);
    expect(fit.overlap).toBe(0);
    expect(fit.inside).toBe(true);
    expect(fit.confidence).toMatch(/%/);
    expect(fit.mode).toBe('2');
    expect(fit.runwayLevel).toBe(false);
    expect(fit.runwayLane).toBe(false);
    expect(await page.locator('#runwayVisionStateWord').innerText()).toBe('סבוב מחדש');
    expect(await page.locator('#runwayVisionArm').innerText()).toBe('חימוש ידני');
    expect(await page.locator('#runwayVisionHold').isHidden()).toBe(true);
    expect(await page.locator('#runwayVisionTakeover').isHidden()).toBe(true);

    const armHit = await page.locator('#runwayVisionArm').evaluate((el) => {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y, w: Math.round(box.width), h: Math.round(box.height),
        parent: el.parentElement?.id || '',
        hit: hit ? `${hit.tagName}#${hit.id}.${String(hit.className).slice(0, 40)}` : 'none',
      };
    });
    expect(armHit.hit, JSON.stringify(armHit)).toMatch(/BUTTON/i);
    const armed = page.waitForRequest((req) => req.url().includes('/api/runway/vision-arm') && req.method() === 'POST');
    await page.locator('#runwayVisionArm').click({ timeout: 4000 });
    expect((await armed).postDataJSON()).toEqual({ arm: true });
    await page.waitForFunction(() => document.getElementById('runwayVisionArm')?.textContent === 'בטל חימוש');
    expect(await page.locator('#runwayVisionArm').innerText()).toBe('בטל חימוש');
    expect(await page.locator('#runwayVisionHold').innerText()).toBe('גלגול: הקונסולה. עלרוד, מצערת והגה: הטייס');
    expect(await page.locator('#runwayVisionTakeover').innerText()).toBe('להשתלטות: מתג ערוץ 7 או החלפת מצב');

    for (const [width, height] of [[1024, 470], [1366, 630], [1536, 730]]) {
      await page.setViewportSize({ width, height });
      const placed = await page.evaluate(async (words) => {
        const stage = document.getElementById('pfdHorizonStage');
        const tiles = document.getElementById('runwayAwarenessTiles');
        const word = document.getElementById('runwayVisionStateWord');
        const stageBox = stage.getBoundingClientRect();
        const rows = [];
        for (const value of words) {
          word.textContent = value;
          const box = word.getBoundingClientRect();
          rows.push({
            value,
            inside: box.width > 0
              && box.left >= stageBox.left - 1
              && box.right <= stageBox.right + 1
              && box.top >= stageBox.top - 1
              && box.bottom <= stageBox.bottom + 1
              && tiles.contains(word),
          });
        }
        word.textContent = 'סבוב מחדש';
        const stageShort = stage.getAttribute('data-awareness-stage') === 'short';
        const stack = document.getElementById('runwayAwarenessStack');
        const stackBox = stack.getBoundingClientRect();
        const measure = [...tiles.querySelectorAll('.runway-awareness-tile')];
        const oneColumn = measure.length >= 3 && measure.every((tile, index) => {
          const box = tile.getBoundingClientRect();
          const prev = index === 0 ? null : measure[index - 1].getBoundingClientRect();
          return box.width >= stackBox.width - 8
            && box.right <= stageBox.right + 1
            && box.left >= stageBox.left - 1
            && (!prev || box.top >= prev.bottom - 1);
        });
        return { rows, stageShort, oneColumn };
      }, ['ממתין', 'פעיל', 'שוחרר', 'סבוב מחדש']);
      for (const row of placed.rows) {
        expect(row.inside, `${width}x${height} ${row.value}`).toBe(true);
      }
      if (width === 1024 && height === 470) {
        expect(placed.stageShort).toBe(true);
        expect(placed.oneColumn, 'offset tiles use one column').toBe(true);
      }
      const clearance = await page.evaluate(() => {
        const stage = document.getElementById('pfdHorizonStage');
        const stack = document.getElementById('runwayAwarenessStack');
        const alert = document.getElementById('runwayAwarenessAlert');
        const left = document.querySelector('.pfd-side-tape--left');
        const right = document.querySelector('.pfd-side-tape--right');
        const stageBox = stage.getBoundingClientRect();
        const stackBox = stack.getBoundingClientRect();
        const alertBox = alert.getBoundingClientRect();
        const arm = document.getElementById('runwayVisionArm');
        const offset = document.getElementById('runwayOffsetValue');
        const offsetTile = offset?.closest('.runway-awareness-tile');
        const offsetBox = offset?.getBoundingClientRect();
        const tileBox = offsetTile?.getBoundingClientRect();
        function hits(a, b) {
          if (!a || !b || a.width < 1 || b.width < 1) return false;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return w > 1 && h > 1;
        }
        const leftBox = left?.getBoundingClientRect();
        const rightBox = right?.getBoundingClientRect();
        const armBox = arm?.getBoundingClientRect();
        return {
          hitLeft: hits(stackBox, leftBox) || hits(alertBox, leftBox) || hits(armBox, leftBox),
          hitRight: hits(stackBox, rightBox) || hits(alertBox, rightBox) || hits(armBox, rightBox),
          inside: stackBox.top >= stageBox.top - 1
            && stackBox.bottom <= stageBox.bottom + 1
            && alertBox.top >= stageBox.top - 1
            && alertBox.bottom <= stageBox.bottom + 1
            && stackBox.left >= stageBox.left - 1
            && stackBox.right <= stageBox.right + 1,
          offsetInside: !!(offsetBox && tileBox
            && offsetBox.width > 0
            && offsetBox.left >= tileBox.left - 1
            && offsetBox.right <= tileBox.right + 1
            && offsetBox.top >= tileBox.top - 1
            && offsetBox.bottom <= tileBox.bottom + 1
            && tileBox.left >= stageBox.left - 1
            && tileBox.right <= stageBox.right + 1),
        };
      });
      expect(clearance.hitLeft, `${width}x${height}`).toBe(false);
      expect(clearance.hitRight, `${width}x${height}`).toBe(false);
      expect(clearance.inside, `${width}x${height}`).toBe(true);
      expect(clearance.offsetInside, `${width}x${height}`).toBe(true);
      if (width !== 1536) {
        const fitReport = await page.evaluate(collectTextFitFailures, 1);
        const runway = (fitReport.fails || []).filter((row) => /runway/i.test(`${row.who} ${row.text}`));
        expect(runway.length, `${width}x${height} ${JSON.stringify(runway)}`).toBe(0);
      }
      await page.setViewportSize({ width, height });
      const point = await page.locator('#pfdHorizonStage').evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = Math.min(rect.bottom - 24, rect.top + 80);
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          hit: hit ? `${hit.tagName}#${hit.id}.${String(hit.className)}` : 'none',
        };
      });
      expect(point.hit, `${width}x${height} ${JSON.stringify(point)}`).not.toMatch(/BUTTON/i);
      await page.mouse.click(point.x, point.y, { button: 'right' });
      await page.waitForSelector('#horizonCameraMenu:not([hidden])', { timeout: 3000 });
      const box = await page.evaluate(() => {
        const menuEl = document.getElementById('horizonCameraMenu');
        const menu = menuEl.getBoundingClientRect();
        const levels = [...menuEl.querySelectorAll('[data-awareness-level]')].map((btn) => {
          const rect = btn.getBoundingClientRect();
          return {
            level: btn.getAttribute('data-awareness-level'),
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            inside: rect.height > 8
              && rect.top >= menu.top - 1
              && rect.bottom <= menu.bottom + 1
              && rect.left >= menu.left - 1
              && rect.right <= menu.right + 1,
          };
        });
        return {
          top: menu.top,
          left: menu.left,
          right: menu.right,
          bottom: menu.bottom,
          vw: window.innerWidth,
          vh: window.innerHeight,
          levels,
          collided: !!document.querySelector('#horizonCameraMenu [data-runway-level], #pfdHorizonStage [data-runway-level]'),
        };
      });
      expect(box.collided).toBe(false);
      expect(box.levels.map((row) => row.level)).toEqual(['0', '1', '2', '3', '4']);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(box.vw + 1);
      expect(box.bottom).toBeLessThanOrEqual(box.vh + 1);
      for (const row of box.levels) {
        expect(row.inside, `${width}x${height} level ${row.level} top ${row.top} bottom ${row.bottom}`).toBe(true);
      }
      await page.keyboard.press('Escape');
    }
  }, 30000);
});
