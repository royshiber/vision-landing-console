import { afterAll, describe, expect, it } from 'vitest';
import { cameraDetailStreaming } from '../public/modules/vision-tracks.mjs';
import { clampZoomPan, zoomAroundPoint, zoomFactorFromWheel } from '../public/modules/camera-digital-zoom.mjs';
import { startTestServer } from './test-server.mjs';

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
