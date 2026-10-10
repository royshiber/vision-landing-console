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
    const logs = [];
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
    serverProc.stdout?.on('data', (buf) => logs.push(String(buf)));
    serverProc.stderr?.on('data', (buf) => logs.push(String(buf)));
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`camera fov server did not start\n${logs.join('').slice(-2000)}`);
    const pageRes = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(8000) });
    const html = await pageRes.text();
    if (!pageRes.ok || !html.includes('cam0')) throw new Error(`page ${pageRes.status} ${html.slice(0, 120)}`);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  it('persists each camera, rejects 19, and keeps the label inside its box', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const hintOf = (id) => page.evaluate((hintId) => {
      const el = document.getElementById(hintId);
      return el ? { text: el.textContent, hidden: el.hidden } : null;
    }, id);
    const valueOf = (id) => page.evaluate((fieldId) => document.getElementById(fieldId).value, id);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForSelector('.debrief-cam-tile[data-cam="cam0"]');
    await page.click('.debrief-cam-tile[data-cam="cam0"]', { button: 'right' });
    await page.waitForFunction(() => document.getElementById('cam0Fov'));
    await page.evaluate(() => {
      const field = document.getElementById('cam0Fov');
      const group = field?.closest('details');
      if (group) group.open = true;
    });
    await page.waitForSelector('#opticsContext #cam0Fov', { state: 'visible' });
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
    await page.fill('#cam0Fov', '10');
    await page.dispatchEvent('#cam0Fov', 'input');
    const low = await hintOf('cam0FovHint');
    expect(low.text).toBe('טווח 20–180°');
    expect(low.hidden).toBe(false);
    await page.fill('#cam0Fov', '19');
    await page.dispatchEvent('#cam0Fov', 'change');
    expect(await valueOf('cam0Fov')).toBe('100');
    expect((await hintOf('cam0FovHint')).text).toBe('טווח 20–180°');
    await page.evaluate(() => {
      const input = document.getElementById('cam1Fov');
      input.value = '500';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const cam1 = await hintOf('cam1FovHint');
    expect(cam1.text).toBe('טווח 20–180°');
    expect(cam1.hidden).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="optics"]');
    await page.waitForFunction(() => document.getElementById('cam0Fov') && document.getElementById('cam1Fov'));
    expect(await valueOf('cam0Fov')).toBe('100');
    expect(await valueOf('cam1Fov')).toBe('79');
    await page.close();
  }, 30000);
});
