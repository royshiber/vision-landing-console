/**
 * Guided calibration paints progress, a move hint, and a Hebrew verdict.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibVerdictLine } from '../public/modules/calib-guide.mjs';
import { cameraSettingsHtml } from '../public/modules/camera-settings.mjs';

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

describe('calibration copy', () => {
  it('puts the 9 by 6 board and a start button on both cameras', () => {
    for (const cam of ['cam0', 'cam1']) {
      const html = cameraSettingsHtml(cam);
      expect(html).toContain('התחל כיול');
      expect(html).toContain('value="9"');
      expect(html).toContain('value="6"');
      expect(html).toContain('value="25"');
      expect(html).toContain('צלע מ״מ');
      expect(html).not.toContain('החזיקו לוח שחמט');
    }
  });

  it('formats the reprojection verdict', () => {
    expect(calibVerdictLine({ rms_px: 0.42, verdict: 'מצוין' })).toBe('שגיאת הטלה 0.42 · מצוין');
    expect(calibVerdictLine({ phase: 'running' })).toBe('');
  });
});

describe('guided calibration on CAM1', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('shows progress, a move hint, the verdict, then saves', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-calib-guide-${process.pid}.sqlite`);
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
    const posts = [];
    let showReview = false;
    await page.route('**/api/jetson/v1/cam1/status', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        camera_ok: true,
        has_frame: true,
        state: 'live',
        real: true,
        fps: 30,
        width: 1280,
        height: 800,
        ae: { enabled: false },
      }),
    }));
    await page.route('**/api/jetson/v1/cam1/stream.mjpg**', (route) => route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUTEhIVFhUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAADAAIEBQYHCP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A1e1h0AAAAA//9k=', 'base64'),
    }));
    await page.route('**/api/jetson/v1/cam1/calibration/session', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      posts.push(body);
      let payload = {
        ok: true,
        phase: 'running',
        progress: '0/20',
        captured: 0,
        target: 20,
        hint: 'החזק לוח שחמט מול המצלמה',
        flight_commands: false,
      };
      if (body.action === 'observe' && !showReview) {
        payload = { ...payload, progress: '12/20', captured: 12, hint: 'קרב את הלוח' };
      } else if ((body.action === 'observe' && showReview) || body.action === 'save') {
        payload = {
          ok: true,
          phase: 'review',
          progress: '20/20',
          captured: 20,
          target: 20,
          hint: '',
          rms_px: 0.42,
          verdict: 'מצוין',
          saved: body.action === 'save',
          flight_commands: false,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.click('#opticsCam1Btn');
    await page.waitForSelector('#cam1Panel:not([hidden])');
    await page.waitForFunction(() => document.getElementById('cam1CalibStart')?.disabled === false);
    await page.click('#cam1CalibStart');
    await page.waitForFunction(() => document.getElementById('cam1CalibProgress')?.textContent === '12/20');
    await page.waitForFunction(() => document.getElementById('cam1CalibHint')?.textContent === 'קרב את הלוח');
    const shotDir = '/opt/cursor/artifacts/screenshots';
    await page.screenshot({ path: `${shotDir}/calib-guide-cam1.png`, animations: 'disabled' });
    showReview = true;
    await page.waitForFunction(() => (document.getElementById('cam1CalibState')?.textContent || '').includes('מצוין'));
    expect(await page.locator('#cam1CalibState').innerText()).toBe('שגיאת הטלה 0.42 · מצוין');
    await page.waitForFunction(() => document.getElementById('cam1CalibSave')?.disabled === false);
    const saveWait = page.waitForRequest((req) => req.url().includes('/cam1/calibration/session') && (req.postData() || '').includes('save'));
    await page.click('#cam1CalibSave');
    await saveWait;
    expect(posts.some((row) => row.action === 'start' && row.inner_cols === 9 && row.inner_rows === 6 && row.square_mm === 25)).toBe(true);
    expect(posts.some((row) => row.action === 'save')).toBe(true);
    expect(posts.every((row) => row.inner_cols === 9 && row.square_mm === 25)).toBe(true);
  });
});
