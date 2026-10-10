/**
 * Auto exposure locks manual fields. Applied and failed come from read-back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AE_LOCK_HE, APPLIED_HE, FAILED_HE, FOV_META_HE, applyOutcome } from '../public/modules/camera-settings.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe('camera apply outcome', () => {
  it('marks a mismatch as failed and a matching read-back as applied', () => {
    expect(applyOutcome(null).text).toBe(FAILED_HE);
    expect(applyOutcome({
      ae: { requested: false, actual: false, applied: true },
      gain: { requested: 27, actual: 27, applied: true },
      exposure_us: { requested: 2000, actual: 2000, applied: true },
      fov_deg: { requested: 79, actual: 79, applied: true, metadata_only: true },
    }).text).toBe(APPLIED_HE);
    expect(applyOutcome({
      gain: { requested: 27, actual: 16, applied: false },
    }).text).toBe(FAILED_HE);
    expect(applyOutcome({
      exposure_us: { requested: 2000, actual: 1800, applied: false, skipped: true },
      fov_deg: { requested: 79, actual: 79, applied: true, metadata_only: true },
    }).text).toBe(APPLIED_HE);
  });
});

describe('camera control badges', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('disables manual fields while auto exposure is on and badges the read-back', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-cam-apply-${process.pid}.sqlite`);
    proc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
      },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const health = await fetch(`${base}/api/health`);
        if (health.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(up).toBe(true);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let posts = 0;
    const cam1Status = {
      ok: true,
      camera_ok: true,
      has_frame: true,
      state: 'live',
      real: true,
      fps: 30,
      capture_fps: 30,
      width: 1280,
      height: 800,
      ae: { enabled: true },
      exposure_us: 2000,
      gain: 16,
    };
    const cam0Status = { ...cam1Status, ae: { enabled: true } };
    const fulfill = (body) => (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    await page.route('**/api/jetson/v1/cam1/status', fulfill(cam1Status));
    await page.route('**/api/jetson/v1/cam0/status', fulfill(cam0Status));
    await page.route('**/api/jetson/v1/cam0/detections', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ detections: [] }),
    }));
    await page.route('**/api/jetson/v1/cam1/stream.mjpg**', (route) => route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUTEhIVFhUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAADAAIEBQYHCP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A1e1h0AAAAA//9k=', 'base64'),
    }));
    await page.route('**/api/jetson/v1/cam1/settings', async (route) => {
      posts += 1;
      cam1Status.ae = { enabled: false };
      const applied = posts < 3;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          ae: { enabled: false },
          exposure_us: 2000,
          gain: applied ? 27 : 16,
          controls: {
            ae: { requested: false, actual: false, applied: true },
            exposure_us: { requested: 2000, actual: 2000, applied: true },
            gain: { requested: 27, actual: applied ? 27 : 16, applied },
            width: { requested: 1280, actual: 1280, applied: true },
            height: { requested: 800, actual: 800, applied: true },
            fps: { requested: 30, actual: 30, applied: true },
            fov_deg: { requested: 79, actual: 79, applied: true, metadata_only: true },
          },
        }),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.locator('.debrief-cam-tile[data-cam="cam1"]').click({ button: 'right' });
    await page.waitForSelector('#opticsContext:not([hidden]) #cam1Panel');
    await page.waitForFunction((reason) => {
      const exp = document.getElementById('cam1Exposure');
      const gain = document.getElementById('cam1Gain');
      const note = document.getElementById('cam1AeLock');
      return exp?.disabled === true && gain?.disabled === true && note && !note.hidden && note.textContent === reason;
    }, AE_LOCK_HE);
    expect(await page.locator('#cam1Fov').getAttribute('title')).toBe(FOV_META_HE);

    await page.click('#cam1Ae');
    await page.waitForFunction(() => document.getElementById('cam1Exposure')?.disabled === false);
    expect(await page.locator('#cam1Gain').isDisabled()).toBe(false);
    expect(await page.locator('#cam1AeLock').isHidden()).toBe(true);

    await page.fill('#cam1Gain', '27');
    await page.dispatchEvent('#cam1Gain', 'change');
    await page.waitForFunction((word) => document.getElementById('cam1ApplyBadge')?.textContent === word, APPLIED_HE);
    expect(await page.locator('#cam1ApplyBadge').getAttribute('data-state')).toBe('applied');
    expect(await page.locator('#cam1FovHint').textContent()).toContain(FOV_META_HE);

    await page.fill('#cam1Gain', '40');
    await page.dispatchEvent('#cam1Gain', 'change');
    await page.waitForFunction((word) => document.getElementById('cam1ApplyBadge')?.textContent === word, FAILED_HE);
    expect(await page.locator('#cam1ApplyBadge').getAttribute('data-state')).toBe('failed');
    expect(await page.locator('#cam1Gain').inputValue()).toBe('16');
    await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/cam1-control-readback.png', animations: 'disabled' });
  }, 40000);
});
