import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4042';
const BASE = `http://127.0.0.1:${PORT}`;

describe('camera FOV controls', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT,
        SQLITE_PATH: `/tmp/airvix-fov-${PORT}.sqlite`,
        COMPANION_MODE: 'off',
      },
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
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  it('persists each camera, rejects 19, and keeps the label inside its box', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#cam0Fov');
    const defaults = await page.evaluate(() => ({
      cam0: document.querySelector('#cam0Fov').value,
      cam1: document.querySelector('#cam1Fov').value,
      label: document.querySelector('label:has(#cam0Fov)').textContent,
    }));
    expect(defaults.cam0).toBe('120');
    expect(defaults.cam1).toBe('79');
    expect(defaults.label).toContain('זווית ראייה (מעלות)');
    const fit = await page.evaluate(() => {
      const label = document.querySelector('label:has(#cam0Fov)');
      return label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1;
    });
    expect(fit).toBe(true);
    await page.fill('#cam0Fov', '100');
    await page.dispatchEvent('#cam0Fov', 'change');
    await page.fill('#cam0Fov', '19');
    await page.dispatchEvent('#cam0Fov', 'change');
    expect(await page.inputValue('#cam0Fov')).toBe('100');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('#cam0Fov');
    expect(await page.inputValue('#cam0Fov')).toBe('100');
    expect(await page.inputValue('#cam1Fov')).toBe('79');
    await page.close();
  }, 30000);
});
