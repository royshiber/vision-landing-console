import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { cameraDetailStreaming } from '../public/modules/vision-tracks.mjs';
import { clampZoomPan, zoomAroundPoint, zoomFactorFromWheel, zoomFromPinch } from '../public/modules/camera-digital-zoom.mjs';
import { placeOpticsPopover, rectsOverlap } from '../public/modules/optics-context.mjs';
import { qaShotDir } from './shot-dir.mjs';
import { startTestServer } from './test-server.mjs';

const shots = qaShotDir('optics-flight-420');

const VIEWPORTS = [
  [360, 640],
  [360, 740],
  [599, 640],
  [800, 800],
  [1024, 576],
  [1024, 640],
  [1280, 720],
  [1440, 900],
  [1920, 1080],
];

describe('digital camera zoom', () => {
  it('keeps the cursor point fixed and clamps the pan to the stage', () => {
    const next = zoomAroundPoint({
      scale: 1, tx: 0, ty: 0, px: 40, py: 20, nextScale: 2, width: 100, height: 80,
    });
    expect(next.scale).toBe(2);
    expect(next.tx).toBe(-40);
    expect(next.ty).toBe(-20);
    const edge = clampZoomPan(-999, 10, 2, 100, 80);
    expect(edge.tx).toBe(-100);
    expect(edge.ty).toBe(0);
    expect(zoomAroundPoint({ scale: 2, tx: -40, ty: -20, nextScale: 1, width: 100, height: 80 })).toEqual({
      scale: 1, tx: 0, ty: 0,
    });
    expect(zoomFactorFromWheel(0)).toBe(1);
    expect(zoomFactorFromWheel(100)).toBeLessThan(1);
    expect(zoomFromPinch(2, 10, 20)).toBe(4);
    expect(zoomFromPinch(4, 10, 80)).toBe(8);
    expect(zoomFromPinch(1, 20, 4)).toBe(1);
  });

  it('puts the menu beside a tile when the viewport is wide', () => {
    const tile = { left: 8, top: 48, right: 408, bottom: 360, width: 400, height: 312 };
    const box = placeOpticsPopover({
      tile,
      tiles: [tile],
      viewport: { width: 1280, height: 720 },
    });
    expect(box.mode).toBe('side');
    expect(rectsOverlap(box, tile)).toBe(false);
    expect(box.left).toBeGreaterThanOrEqual(tile.right);
  });
});

describe('digital zoom on a camera tile', () => {
  let child;
  let browser;

  afterAll(async () => {
    await browser?.close();
    child?.kill('SIGTERM');
  });

  it('zooms around the cursor and does not send a gimbal command', async () => {
    const started = await startTestServer({
      env: () => ({ COMPANION_MODE: 'off', JETSON_COMPANION_BASE_URL: '' }),
      stdio: 'ignore',
    });
    child = started.child;
    const posts = [];
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('request', (req) => {
      if (req.method() === 'POST') posts.push(req.url());
    });
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tab="optics"]').click();
    const stage = page.locator('#debriefCamGrid .debrief-cam-stage[data-camera-stage="cam0"]');
    await stage.waitFor();
    await page.waitForFunction(() => document.querySelector('#debriefCamGrid [data-camera-stage="cam0"]')?.dataset.camZoom === '1');
    const before = await stage.getAttribute('data-cam-scale');
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    await stage.dblclick();
    const afterReset = await stage.getAttribute('data-cam-scale');
    await page.mouse.wheel(0, -240);
    const zoomed = await stage.evaluate((el) => ({
      scale: Number(el.dataset.camScale),
      layer: !!el.querySelector(':scope > .cam-zoom-layer'),
    }));
    expect(before == null || Number(before) === 1).toBe(true);
    expect(afterReset == null || Number(afterReset) === 1).toBe(true);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(zoomed.layer).toBe(true);
    expect(posts.join(' ')).not.toMatch(/gimbal|mount/i);
  }, 20000);

  it('pinches with two pointers, pans, and resets on a double tap', async () => {
    await browser?.close();
    child?.kill('SIGTERM');
    const started = await startTestServer({
      env: () => ({ COMPANION_MODE: 'off', JETSON_COMPANION_BASE_URL: '' }),
      stdio: 'ignore',
    });
    child = started.child;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tab="optics"]').click();
    const stage = page.locator('#debriefCamGrid .debrief-cam-stage[data-camera-stage="cam0"]');
    await stage.waitFor();
    const touch = await stage.evaluate((el) => getComputedStyle(el).touchAction);
    expect(touch).toBe('none');
    const zoomed = await stage.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const fire = (type, id, x, y) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          button: 0,
        }));
      };
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      fire('pointerdown', 1, cx - 30, cy);
      fire('pointerdown', 2, cx + 30, cy);
      fire('pointermove', 1, cx - 120, cy);
      fire('pointermove', 2, cx + 120, cy);
      const scale = Number(el.dataset.camScale);
      fire('pointerup', 1, cx - 120, cy);
      fire('pointerup', 2, cx + 120, cy);
      fire('pointerdown', 3, cx, cy);
      fire('pointermove', 3, cx - 40, cy);
      fire('pointerup', 3, cx - 40, cy);
      const panned = Number(el.dataset.camTx);
      fire('pointerdown', 4, cx, cy);
      fire('pointerup', 4, cx, cy);
      fire('pointerdown', 5, cx, cy);
      fire('pointerup', 5, cx, cy);
      return { scale, panned, reset: Number(el.dataset.camScale) };
    });
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(zoomed.scale).toBeLessThanOrEqual(8);
    expect(zoomed.panned).not.toBe(0);
    expect(zoomed.reset).toBe(1);
    const horizonTouch = await page.locator('#pfdHorizonStage').evaluate((el) => getComputedStyle(el).touchAction);
    expect(horizonTouch).not.toBe('none');
  }, 20000);
});

describe('per-camera stream state', () => {
  it('treats a streaming companion row as live and ignores a parent cameras map', () => {
    expect(cameraDetailStreaming({ id: 'cam3', state: 'streaming', fps: 25 })).toBe(true);
    expect(cameraDetailStreaming({ id: 'cam0', state: 'streaming', capture_fps: 60 })).toBe(true);
    expect(cameraDetailStreaming({ cameras: { cam0: { state: 'streaming', fps: 60 } }, reason_he: 'אין נתון על זרם המצלמות' })).toBe(false);
    expect(cameraDetailStreaming({ state: 'absent' })).toBe(false);
    expect(cameraDetailStreaming({ state: 'disabled' })).toBe(false);
  });
});

describe('optics menu stays off the picture', () => {
  let child;
  let browser;

  afterAll(async () => {
    await browser?.close();
    child?.kill('SIGTERM');
  });

  it('does not intersect any video rect at the nine sizes', async () => {
    const started = await startTestServer({
      env: () => ({ COMPANION_MODE: 'off', JETSON_COMPANION_BASE_URL: '' }),
      stdio: 'ignore',
    });
    child = started.child;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const hits = [];
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await page.goto(started.base, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-tab="optics"]').click();
      const tiles = page.locator('#debriefCamGrid .debrief-cam-tile');
      await tiles.first().waitFor();
      const count = await tiles.count();
      for (let i = 0; i < count; i += 1) {
        await tiles.nth(i).click({ button: 'right' });
        await page.waitForFunction(() => document.getElementById('opticsContext')?.hidden === false);
        const hit = await page.evaluate(() => {
          const menu = document.getElementById('opticsContext').getBoundingClientRect();
          const videos = [...document.querySelectorAll('#debriefCamGrid .debrief-cam-tile, #debriefCamGrid [data-camera-stage]')];
          for (const el of videos) {
            const box = el.getBoundingClientRect();
            if (box.width < 2 || box.height < 2) continue;
            const overlapW = Math.min(menu.right, box.right) - Math.max(menu.left, box.left);
            const overlapH = Math.min(menu.bottom, box.bottom) - Math.max(menu.top, box.top);
            if (overlapW > 1 && overlapH > 1) {
              return `${el.dataset.cam || el.dataset.cameraStage} ${Math.round(overlapW)}x${Math.round(overlapH)}`;
            }
          }
          return '';
        });
        if (hit) hits.push(`${width}x${height} tile ${i}: ${hit}`);
      }
      if (width === 360 || width === 1280) {
        await page.screenshot({ path: path.join(shots, `optics-menu-${width}.png`) });
      }
      await page.keyboard.press('Escape');
    }
    expect(hits).toEqual([]);
  }, 90000);

  it('opens the arm dialog from a touch hold at 360 and keeps the corner clear', async () => {
    const started = await startTestServer({
      env: () => ({ COMPANION_MODE: 'off', JETSON_COMPANION_BASE_URL: '' }),
      stdio: 'ignore',
    });
    const previous = child;
    child = started.child;
    previous?.kill('SIGTERM');
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.applySseMissionHud = () => null;
      applyFlightHud({
        connected: true,
        armedKnown: true,
        armed: false,
        flying: false,
        lastHeartbeatAgeMs: 100,
        rollDeg: 1,
        pitchDeg: -1,
        heading: 10,
        airspeed: 0,
        altitude: 0,
      });
    });
    const face = await page.evaluate(() => {
      const boxOf = (id) => {
        const el = document.getElementById(id);
        const box = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const shown = el.querySelector('.horizon-quick-label')?.textContent || '';
        return {
          label: el.getAttribute('aria-label'),
          tip: el.title,
          shown,
          top: Math.round(box.top),
          width: box.width,
          height: box.height,
          hidden: el.hidden || cs.display === 'none',
          inQuick: !!el.closest('#horizonQuick'),
          inMenu: !!el.closest('#horizonCameraMenu'),
        };
      };
      const arm = document.getElementById('flightArmBtn').getBoundingClientRect();
      const badge = document.getElementById('pfdArmedBadge').getBoundingClientRect();
      const alt = document.querySelector('.pfd-side-tape--right').getBoundingClientRect();
      const canvas = document.getElementById('horizonCanvas').getBoundingClientRect();
      const quick = document.getElementById('horizonQuick').getBoundingClientRect();
      const tapes = [...document.querySelectorAll('.pfd-side-tape')].map((el) => el.getBoundingClientRect());
      const hits = (a, b) => {
        const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return overlapW > 1 && overlapH > 1;
      };
      const dx = Math.max(badge.left - alt.right, alt.left - badge.right);
      const dy = Math.max(badge.top - alt.bottom, alt.top - badge.bottom);
      const altGap = dx < 0 && dy < 0 ? -1 : dx < 0 ? dy : dy < 0 ? dx : Math.hypot(dx, dy);
      return {
        arm: boxOf('flightArmBtn'),
        disarm: boxOf('flightDisarmBtn'),
        badge: boxOf('pfdArmedBadge'),
        voice: boxOf('pfdVoiceFlightBtn'),
        hitsTape: tapes.some((tape) => hits(arm, tape)),
        hitsPicture: hits(quick, canvas),
        altGap,
      };
    });
    expect(face.arm.label).toBe('חימוש');
    expect(face.arm.shown).toBe('חימוש');
    expect(face.disarm.label).toBe('ניטרול');
    expect(face.disarm.tip).toBe('ניטרול');
    expect(face.disarm.shown).toBe('ניטרול');
    expect(face.badge.label).toBe('מנוטרל');
    expect(face.badge.tip).toBe('מנוטרל');
    expect(face.badge.shown).toBe('מנוטרל');
    expect(face.voice.shown).toBe('פקודות');
    expect(face.altGap).toBeGreaterThanOrEqual(4);
    expect(face.arm.width).toBeGreaterThanOrEqual(44);
    expect(face.arm.height).toBeGreaterThanOrEqual(32);
    expect(face.disarm.width).toBeGreaterThanOrEqual(44);
    expect(face.disarm.height).toBeGreaterThanOrEqual(32);
    expect(face.badge.width).toBeGreaterThanOrEqual(44);
    expect(face.voice.width).toBeGreaterThanOrEqual(44);
    expect(new Set([face.arm.top, face.disarm.top, face.badge.top, face.voice.top]).size).toBe(1);
    expect(face.hitsTape).toBe(false);
    expect(face.hitsPicture).toBe(false);
    expect(face.voice.inQuick).toBe(true);
    expect(face.voice.inMenu).toBe(false);
    expect(face.voice.hidden).toBe(false);
    expect(face.voice.label).toBe('פקודות');
    await page.screenshot({ path: path.join(shots, 'horizon-360.png') });
    await page.evaluate(() => {
      const btn = document.getElementById('flightArmBtn');
      const box = btn.getBoundingClientRect();
      btn.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'touch',
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        button: 0,
      }));
    });
    await page.waitForFunction(() => document.getElementById('flightArmDialog')?.hidden === false);
    await page.evaluate(() => {
      const btn = document.getElementById('flightArmBtn');
      const dialog = document.getElementById('flightArmDialog');
      const box = btn.getBoundingClientRect();
      const point = {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'touch',
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        button: 0,
      };
      btn.dispatchEvent(new PointerEvent('pointerup', point));
      btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(250);
    expect(await page.locator('#flightArmDialog').isHidden()).toBe(false);
    expect(await page.locator('#flightArmDialogText').textContent()).toBe('אשרו חימוש');
    expect(await page.locator('#flightArmCancel').textContent()).toBe('ביטול');
  }, 20000);
});
