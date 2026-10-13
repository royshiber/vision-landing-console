/**
 * Runway overlay fit on a short flight screen, and the level menu stays
 * inside the viewport.
 */
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './test-server.mjs';
import { collectTextFitFailures } from './text-fit-audit.mjs';

function pngSize(buf) {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

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
  vision: { state: 'go_around', labelHe: 'סבוב מחדש', manualArm: false, buttonReady: false },
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
    let visionOverride = null;
    let levelOverride = null;
    let landOverride = null;
    const armedVision = {
      state: 'active',
      labelHe: 'נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה',
      manualArm: true,
      buttonReady: true,
      hasLand: true,
    };
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
        level: levelOverride == null ? AWARENESS.level : levelOverride,
        vision: {
          ...(armedNow ? armedVision : (visionOverride || AWARENESS.vision)),
          ...(landOverride == null ? {} : { hasLand: landOverride }),
        },
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
    expect(await page.locator('#runwayVisionArm').innerText()).toBe('נחיתה אופטית');
    expect(await page.locator('#runwayVisionArm').isDisabled()).toBe(true);
    const disabledLook = await page.locator('#runwayVisionArm').evaluate((el) => {
      const style = getComputedStyle(el);
      return { opacity: style.opacity, cursor: style.cursor, aria: el.getAttribute('aria-disabled') };
    });
    expect(Number(disabledLook.opacity)).toBeLessThan(1);
    expect(disabledLook.cursor).toBe('not-allowed');
    expect(disabledLook.aria).toBe('true');
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
    visionOverride = { state: 'waiting', labelHe: 'ממתין', manualArm: false, buttonReady: true };
    landOverride = true;
    await page.waitForFunction(() => (
      document.getElementById('runwayVisionStateWord')?.textContent || ''
    ) === 'רמה 3 נדרשת לנחיתה אופטית');
    expect(await page.locator('#runwayVisionArm').isDisabled()).toBe(true);
    levelOverride = 3;
    landOverride = false;
    await page.waitForFunction(() => (
      document.getElementById('runwayVisionStateWord')?.textContent || ''
    ) === 'אין נחיתה במשימה');
    expect(await page.locator('#runwayVisionArm').isDisabled()).toBe(true);
    landOverride = true;
    await page.waitForFunction(() => document.getElementById('runwayVisionArm')?.disabled === false);
    const armed = page.waitForRequest((req) => req.url().includes('/api/runway/vision-arm') && req.method() === 'POST');
    await page.locator('#runwayVisionArm').click({ timeout: 4000 });
    expect((await armed).postDataJSON()).toEqual({ arm: true });
    await page.waitForFunction(() => (
      document.getElementById('runwayVisionStateWord')?.textContent || ''
    ) === 'אופטית פעילה');
    expect(await page.locator('#runwayVisionArm').innerText()).toBe('נחיתה אופטית');
    expect(await page.locator('#runwayVisionStateWord').innerText()).toBe('אופטית פעילה');
    expect(await page.locator('#runwayVisionHold').isHidden()).toBe(true);
    expect(await page.locator('#runwayVisionTakeover').isHidden()).toBe(true);

    for (const [width, height] of [[1024, 470], [1366, 630], [1536, 730]]) {
      await page.setViewportSize({ width, height });
      const placed = await page.evaluate(async (words) => {
        const stage = document.getElementById('pfdHorizonStage');
        const bar = document.getElementById('runwayVisionBar');
        const tiles = document.getElementById('runwayAwarenessTiles');
        const word = document.getElementById('runwayVisionStateWord');
        const barBox = bar.getBoundingClientRect();
        const rows = [];
        for (const value of words) {
          word.textContent = value;
          const box = word.getBoundingClientRect();
          rows.push({
            value,
            inside: box.width > 0
              && box.left >= barBox.left - 1
              && box.right <= barBox.right + 1
              && box.top >= barBox.top - 1
              && box.bottom <= barBox.bottom + 1
              && bar.contains(word)
              && !stage.contains(word),
          });
        }
        word.textContent = 'סבוב מחדש';
        const stageShort = stage.getAttribute('data-awareness-stage') === 'short';
        const stack = document.getElementById('runwayAwarenessStack');
        const stackBox = stack.getBoundingClientRect();
        const measure = [...tiles.querySelectorAll('.runway-awareness-tile')].map((tile) => {
          const box = tile.getBoundingClientRect();
          return { top: box.top, left: box.left, right: box.right, width: box.width };
        });
        const oneRow = measure.length >= 3
          && Math.max(...measure.map((box) => box.top)) - Math.min(...measure.map((box) => box.top)) <= 2
          && measure.every((box) => box.width < stackBox.width * 0.6 && box.width > 8);
        return { rows, stageShort, oneRow };
      }, ['ממתין', 'פעיל', 'שוחרר', 'סבוב מחדש', 'נמוך מדי להפעלה', 'נחיתת משימה: הנחיית גלגול', 'נחיתת משימה פעילה', 'משימה פעילה']);
      for (const row of placed.rows) {
        expect(row.inside, `${width}x${height} ${row.value}`).toBe(true);
      }
      const disabledSize = await page.locator('#runwayVisionArm').evaluate((el) => {
        const style = getComputedStyle(el);
        return { opacity: style.opacity, cursor: style.cursor, aria: el.getAttribute('aria-disabled'), disabled: el.disabled };
      });
      expect(disabledSize.disabled, `${width}x${height}`).toBe(true);
      expect(Number(disabledSize.opacity), `${width}x${height}`).toBeLessThan(1);
      expect(disabledSize.cursor, `${width}x${height}`).toBe('not-allowed');
      expect(disabledSize.aria, `${width}x${height}`).toBe('true');
      if (width === 1024 && height === 470) {
        expect(placed.stageShort).toBe(true);
        const clearOfIas = await page.evaluate(() => {
          const word = document.getElementById('runwayVisionStateWord');
          const tape = document.querySelector('.pfd-side-tape--left');
          const a = word?.getBoundingClientRect();
          const b = tape?.getBoundingClientRect();
          if (!a || !b || a.width < 1 || b.width < 1) return false;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return !(w > 0 && h > 0);
        });
        expect(clearOfIas, 'state text overlaps the IAS box').toBe(true);
        const armClearsState = await page.evaluate(() => {
          const word = document.getElementById('runwayVisionStateWord')?.getBoundingClientRect();
          const arm = document.getElementById('runwayVisionArm')?.getBoundingClientRect();
          if (!word || !arm || word.width < 1 || arm.width < 1) return false;
          const w = Math.min(word.right, arm.right) - Math.max(word.left, arm.left);
          const h = Math.min(word.bottom, arm.bottom) - Math.max(word.top, arm.top);
          return !(w > 0 && h > 0);
        });
        expect(armClearsState, 'arm button covers the state text').toBe(true);
        const armLanes = await page.evaluate(() => {
          const word = document.getElementById('runwayVisionStateWord');
          const previous = word.textContent;
          word.textContent = 'רמה 3 נדרשת לנחיתה אופטית';
          function hits(a, b) {
            if (!a || !b || a.width < 1 || b.width < 1) return false;
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            return w > 0 && h > 0;
          }
          function textBox(el) {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect();
          }
          const arm = document.getElementById('runwayVisionArm')?.getBoundingClientRect();
          const alt = document.querySelector('.pfd-side-tape--right')?.getBoundingClientRect();
          const note = document.getElementById('horizonNoData');
          const glyphs = note ? textBox(note) : null;
          const wordBox = word.getBoundingClientRect();
          word.textContent = previous;
          return {
            alt: !hits(arm, alt),
            note: !hits(arm, glyphs),
            word: !hits(arm, wordBox),
          };
        });
        expect(armLanes.alt, 'arm overlaps the ALT box').toBe(true);
        expect(armLanes.note, 'arm overlaps אין נתונים').toBe(true);
        expect(armLanes.word, 'arm overlaps the state text').toBe(true);
        expect(placed.oneRow, 'offset heading and hazard share one line').toBe(true);
        const disabledHere = await page.locator('#runwayVisionArm').evaluate((el) => {
          const style = getComputedStyle(el);
          return { opacity: style.opacity, cursor: style.cursor, aria: el.getAttribute('aria-disabled'), disabled: el.disabled };
        });
        expect(disabledHere.disabled).toBe(true);
        expect(Number(disabledHere.opacity)).toBeLessThan(1);
        expect(disabledHere.cursor).toBe('not-allowed');
        expect(disabledHere.aria).toBe('true');
        const offsetText = await page.locator('#runwayOffsetValue').innerText();
        const headingText = await page.locator('#runwayHeadingValue').innerText();
        expect(offsetText).toMatch(/[→←]/);
        expect(offsetText).toMatch(/1\.4/);
        expect(offsetText).toMatch(/מ׳/);
        expect(offsetText).not.toMatch(/ימינה|שמאלה|צד/);
        expect(headingText).toMatch(/[→←]/);
        expect(headingText).toMatch(/3/);
        expect(headingText).not.toMatch(/ימינה|שמאלה/);
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
      const png = await page.locator('#pfdHorizonStage').screenshot();
      const image = pngSize(png);
      const shot = await page.evaluate(() => {
        const stage = document.getElementById('pfdHorizonStage').getBoundingClientRect();
        const canvas = document.getElementById('horizonCanvas').getBoundingClientRect();
        const left = document.querySelector('.pfd-side-tape--left').getBoundingClientRect();
        const right = document.querySelector('.pfd-side-tape--right').getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const rel = (box) => ({
          left: (box.left - stage.left) * dpr,
          top: (box.top - stage.top) * dpr,
          right: (box.right - stage.left) * dpr,
          bottom: (box.bottom - stage.top) * dpr,
        });
        return {
          dpr,
          stage: { width: stage.width * dpr, height: stage.height * dpr },
          canvas: rel(canvas),
          left: rel(left),
          right: rel(right),
          tiles: [...document.querySelectorAll('#runwayAwarenessTiles .runway-awareness-tile')].map((el) => ({
            id: el.dataset.awarenessTile,
            ...rel(el.getBoundingClientRect()),
          })),
        };
      });
      expect(Math.abs(image.width - shot.stage.width), `${width}x${height} png`).toBeLessThanOrEqual(2);
      expect(Math.abs(image.height - shot.stage.height), `${width}x${height} png`).toBeLessThanOrEqual(2);
      expect(shot.tiles.map((tile) => tile.id)).toEqual(['offset', 'heading', 'hazard']);
      const horizon = shot.canvas.right - shot.canvas.left > 8 ? shot.canvas : {
        left: 0, top: 0, right: image.width, bottom: image.height,
      };
      for (const tile of shot.tiles) {
        expect(tile.top, `${width} ${tile.id}`).toBeGreaterThanOrEqual(horizon.top - 1);
        expect(tile.left, `${width} ${tile.id}`).toBeGreaterThanOrEqual(Math.max(0, horizon.left) - 1);
        expect(tile.right, `${width} ${tile.id}`).toBeLessThanOrEqual(Math.min(image.width, horizon.right) + 1);
        expect(tile.bottom, `${width} ${tile.id}`).toBeLessThanOrEqual(Math.min(image.height, horizon.bottom) + 1);
        expect(tile.left, `${width} ${tile.id} tape`).toBeGreaterThanOrEqual(shot.left.right - 1);
        expect(tile.right, `${width} ${tile.id} tape`).toBeLessThanOrEqual(shot.right.left + 1);
      }
      if (width === 1366 && height === 630) {
        const chipClear = await page.evaluate(() => {
          const word = document.getElementById('runwayVisionStateWord');
          const previous = word.textContent;
          word.textContent = 'רמה 3 נדרשת לנחיתה אופטית';
          const text = word.getBoundingClientRect();
          const chips = document.getElementById('horizonQuick')?.getBoundingClientRect();
          word.textContent = previous;
          if (!chips || text.width < 1 || chips.width < 1) return { clear: false, text, chips };
          const w = Math.min(text.right, chips.right) - Math.max(text.left, chips.left);
          const h = Math.min(text.bottom, chips.bottom) - Math.max(text.top, chips.top);
          return { clear: !(w > 0 && h > 0), top: text.top, chipBottom: chips.bottom };
        });
        expect(chipClear.clear, `level-3 text collides with the top status chips ${JSON.stringify(chipClear)}`).toBe(true);
      }
      if (width === 1024 && height === 470) {
        const tops = shot.tiles.map((tile) => tile.top);
        expect(Math.max(...tops) - Math.min(...tops), 'screenshot row').toBeLessThanOrEqual(2);
      }
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
    await page.setViewportSize({ width: 1024, height: 470 });
    armedNow = false;
    visionOverride = { state: 'waiting', labelHe: 'ממתין', manualArm: false, buttonReady: false };
    await page.waitForFunction(() => (
      document.getElementById('runwayVisionStateWord')?.textContent || ''
    ) === 'אין מסלול במסגרת');
    expect(await page.locator('#runwayVisionStateWord').innerText()).toBe('אין מסלול במסגרת');
    expect(await page.locator('#runwayVisionArm').isDisabled()).toBe(true);
    visionOverride = armedVision;
    await page.waitForFunction(() => (
      document.getElementById('runwayVisionStateWord')?.textContent || ''
    ) === 'אופטית פעילה');
    const shortFit = await page.evaluate(collectTextFitFailures, 1);
    const shortRunway = (shortFit.fails || []).filter((row) => /runway/i.test(`${row.who} ${row.text}`));
    expect(shortRunway.length, JSON.stringify(shortRunway)).toBe(0);
    expect(await page.locator('#runwayVisionStateWord').innerText()).toBe('אופטית פעילה');
    expect(await page.locator('#runwayVisionArm').innerText()).toBe('נחיתה אופטית');
    armedNow = false;
    visionOverride = {
      state: 'active',
      optical: false,
      labelHe: 'נחיתת משימה: הנחיית גלגול',
      manualArm: false,
      buttonReady: true,
      hasLand: true,
      blockHe: 'נמוך מדי להפעלה',
    };
    await page.waitForFunction(() => (
      document.getElementById('runwayVisionStateWord')?.textContent || ''
    ) === 'נחיתת משימה: הנחיית גלגול');
    expect(await page.locator('#runwayVisionArm').innerText()).toBe('משימה פעילה');
    expect(await page.locator('#runwayVisionStateWord').innerText()).not.toBe('נמוך מדי להפעלה');
    const chipClear = await page.evaluate(() => {
      const stage = document.getElementById('pfdHorizonStage');
      const canvas = document.getElementById('horizonCanvas');
      const arm = document.getElementById('runwayVisionArm');
      const armBox = arm.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const height = canvas.height / dpr;
      const scaleY = canvasBox.height / height;
      const scaleX = canvasBox.width / (canvas.width / dpr);
      const ctx = canvas.getContext('2d');
      ctx.font = '700 11px "Space Grotesk", sans-serif';
      const chipW = Math.ceil(ctx.measureText('R —').width) + 8;
      const chipH = 16;
      const chip = {
        left: canvasBox.left + 4 * scaleX,
        top: canvasBox.top + (height - 6 - chipH) * scaleY,
        right: canvasBox.left + (4 + chipW) * scaleX,
        bottom: canvasBox.top + (height - 6) * scaleY,
      };
      const hits = armBox.left < chip.right && armBox.right > chip.left
        && armBox.top < chip.bottom && armBox.bottom > chip.top;
      const range = document.createRange();
      range.selectNodeContents(arm);
      const lines = range.getClientRects().length;
      return {
        hits,
        lines,
        nowrap: getComputedStyle(arm).whiteSpace,
        height: Math.round(armBox.height),
        width: Math.round(armBox.width),
        short: stage.getAttribute('data-awareness-stage') === 'short',
      };
    });
    expect(chipClear.short).toBe(true);
    expect(chipClear.lines, JSON.stringify(chipClear)).toBe(1);
    expect(chipClear.nowrap).toBe('nowrap');
    expect(chipClear.hits, JSON.stringify(chipClear)).toBe(false);
    const sizes = [[360, 640], [360, 800], [1024, 470], [1366, 630], [1536, 730]];
    const readyVision = {
      state: 'waiting',
      optical: false,
      labelHe: 'ממתין',
      manualArm: false,
      buttonReady: true,
      hasLand: true,
    };
    const missionVision = {
      state: 'active',
      optical: false,
      labelHe: 'נחיתת משימה: הנחיית גלגול',
      manualArm: false,
      buttonReady: true,
      hasLand: true,
    };
    async function horizonClear(label) {
      return page.evaluate((name) => {
        function hits(a, b) {
          if (!a || !b || a.width < 1 || b.width < 1) return false;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return w > 1 && h > 1;
        }
        const shell = document.getElementById('pfdHorizonShell');
        const stage = document.getElementById('pfdHorizonStage');
        const bar = document.getElementById('runwayVisionBar');
        const tiles = document.getElementById('runwayAwarenessTiles');
        const movers = [document.getElementById('runwayVisionArm'), document.getElementById('runwayVisionState')];
        const horizon = [...shell.querySelectorAll('*')].filter((el) => {
          if (el.hidden || movers.some((mover) => mover === el || mover.contains(el))) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const box = el.getBoundingClientRect();
          return box.width > 1 && box.height > 1;
        });
        const overlaps = [];
        for (const mover of movers) {
          const box = mover.getBoundingClientRect();
          for (const el of horizon) {
            if (!hits(box, el.getBoundingClientRect())) continue;
            overlaps.push(`${mover.id} ∩ ${el.id || el.className.toString().slice(0, 24)}`);
          }
        }
        const style = getComputedStyle(bar);
        return {
          name,
          overlaps,
          outside: !shell.contains(bar) && !stage.contains(bar),
          tilesOnly: stage.contains(tiles) && !bar.contains(tiles),
          height: style.height,
          parent: bar.parentElement?.id || bar.parentElement?.className?.toString?.() || '',
        };
      }, label);
    }
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      armedNow = false;
      visionOverride = readyVision;
      await page.waitForFunction(() => document.getElementById('runwayVisionArm')?.textContent === 'נחיתה אופטית');
      const ready = await horizonClear(`ready ${width}x${height}`);
      expect(ready.overlaps, JSON.stringify(ready)).toEqual([]);
      expect(ready.outside, JSON.stringify(ready)).toBe(true);
      expect(ready.tilesOnly, JSON.stringify(ready)).toBe(true);
      expect(ready.height, JSON.stringify(ready)).toBe('36px');
      visionOverride = missionVision;
      await page.waitForFunction(() => {
        const text = document.getElementById('runwayVisionArm')?.textContent || '';
        return text === 'משימה פעילה' || text === 'נחיתת משימה פעילה';
      });
      const mission = await horizonClear(`mission ${width}x${height}`);
      expect(mission.overlaps, JSON.stringify(mission)).toEqual([]);
      expect(mission.outside, JSON.stringify(mission)).toBe(true);
      expect(mission.tilesOnly, JSON.stringify(mission)).toBe(true);
      expect(mission.height, JSON.stringify(mission)).toBe('36px');
    }
    const headerClear = await page.evaluate(() => {
      function hits(a, b) {
        if (!a || !b || a.width < 1 || b.width < 1) return false;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return w > 0 && h > 0;
      }
      function glyphs(el) {
        if (!el) return null;
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect();
      }
      const armEl = document.getElementById('runwayVisionArm');
      const arm = armEl.getBoundingClientRect();
      const word = document.getElementById('runwayVisionStateWord').getBoundingClientRect();
      const stage = document.getElementById('pfdHorizonStage').getBoundingClientRect();
      const headers = [...document.querySelectorAll('#runwayAwarenessTiles .runway-awareness-k')].map((el) => ({
        text: el.textContent,
        box: el.getBoundingClientRect(),
      }));
      const note = glyphs(document.getElementById('horizonNoData'));
      const left = document.querySelector('.pfd-side-tape--left')?.getBoundingClientRect();
      const right = document.querySelector('.pfd-side-tape--right')?.getBoundingClientRect();
      const canvas = document.getElementById('horizonCanvas');
      const canvasBox = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const height = canvas.height / dpr;
      const scaleY = canvasBox.height / height;
      const scaleX = canvasBox.width / (canvas.width / dpr);
      const ctx = canvas.getContext('2d');
      ctx.font = '700 11px "Space Grotesk", sans-serif';
      const chipW = Math.ceil(ctx.measureText('R —').width) + 8;
      const chip = {
        left: canvasBox.left + 4 * scaleX,
        top: canvasBox.top + (height - 6 - 16) * scaleY,
        right: canvasBox.left + (4 + chipW) * scaleX,
        bottom: canvasBox.top + (height - 6) * scaleY,
        width: chipW * scaleX,
        height: 16 * scaleY,
      };
      return {
        covered: headers.filter((row) => hits(arm, row.box)).map((row) => row.text),
        note: hits(arm, note),
        left: hits(arm, left),
        right: hits(arm, right),
        chip: hits(arm, chip),
        besideState: Math.abs(arm.top - word.top) <= 8,
        inStage: stage.top <= arm.top && arm.bottom <= stage.bottom && stage.left <= arm.left && arm.right <= stage.right,
        parent: armEl.parentElement?.id || '',
      };
    });
    expect(headerClear.covered, JSON.stringify(headerClear)).toEqual([]);
    expect(headerClear.note, JSON.stringify(headerClear)).toBe(false);
    expect(headerClear.left, JSON.stringify(headerClear)).toBe(false);
    expect(headerClear.right, JSON.stringify(headerClear)).toBe(false);
    expect(headerClear.chip, JSON.stringify(headerClear)).toBe(false);
    expect(headerClear.besideState, JSON.stringify(headerClear)).toBe(true);
    expect(headerClear.inStage, JSON.stringify(headerClear)).toBe(false);
    expect(headerClear.parent, JSON.stringify(headerClear)).toBe('runwayVisionBar');
    const missionFit = await page.evaluate(collectTextFitFailures, 1);
    const missionRunway = (missionFit.fails || []).filter((row) => /runway/i.test(`${row.who} ${row.text}`));
    expect(missionRunway.length, JSON.stringify(missionRunway)).toBe(0);
  }, 30000);
});
