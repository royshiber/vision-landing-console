/**
 * Optics against the in-process companion mock: gain is editable,
 * a settings post shows the read-back badge, and calibration advances.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('optics mock companion', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('enables gain, badges the read-back, and starts calibration', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-optics-mock-${process.pid}.sqlite`);
    proc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'mock',
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
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.click('#opticsCam1Btn');
    await page.waitForSelector('#cam1Panel:not([hidden])');
    await page.waitForFunction(() => document.getElementById('cam1Gain')?.disabled === false);
    expect(await page.locator('#cam1Ae').isChecked()).toBe(false);
    await page.locator('#cam1Gain').fill('27');
    await page.locator('#cam1Gain').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('cam1ApplyBadge')?.textContent === 'הוחל');
    expect(await page.locator('#cam1CalibBoard').getAttribute('href')).toBe('/docs/calibration-board.pdf');
    await page.waitForFunction(() => document.getElementById('cam1CalibStart')?.disabled === false);
    await page.locator('#cam1Calib > summary').click();
    await page.click('#cam1CalibStart');
    await page.waitForFunction(() => {
      const text = document.getElementById('cam1CalibProgress')?.textContent || '';
      return text !== '0/20' && text.includes('/');
    });
    const pdf = await fetch(`${base}/docs/calibration-board.pdf`);
    expect(pdf.ok).toBe(true);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
  }, 40000);
});
