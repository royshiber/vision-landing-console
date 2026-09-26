import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4052';
const BASE = `http://127.0.0.1:${PORT}`;
const REASON = 'במצב RF אין וידאו';

describe('RF link panel', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT,
        SQLITE_PATH: `/tmp/airvix-rf-link-${PORT}.sqlite`,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        JETSON_COMPANION_BASE_URLS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error('console did not start');
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  it('shows the RF path, locks video, and leaves the gimbal usable', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        return route.abort();
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('#connectToggleBtn');
      await page.waitForSelector('#workLinkPicker');
      await page.waitForFunction(() => {
        const text = document.getElementById('workLinkPath')?.textContent || '';
        return text.includes('אין נתיב') || text.includes('רשת בית') || text.includes('סלולר');
      });
      const fit = await page.evaluate(() => {
        const root = document.getElementById('workLinkPicker');
        const nodes = [root, ...root.querySelectorAll('h3, p, label')].filter((el) => !el.hidden);
        return nodes.every((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
      });
      expect(fit).toBe(true);
      await page.click('#workLinkRf');
      await page.waitForFunction((reason) => {
        const line = document.getElementById('rfReducedReason');
        const path = document.getElementById('workLinkPath')?.textContent || '';
        return line && !line.hidden && line.textContent === reason && path.includes('RF');
      }, REASON);
      expect(await page.locator('#rfBaud').inputValue()).toBe('57600');
      await page.click('[data-tab="recordings"]');
      await page.waitForFunction((reason) => (
        document.getElementById('cam0Reason')?.textContent || ''
      ).includes(reason), REASON);
      const gimbalTitle = await page.locator('#gimbalPad [data-gimbal="up"]').getAttribute('title');
      expect(gimbalTitle || '').not.toContain(REASON);
      await page.click('#connectToggleBtn');
      await page.click('#workLinkHome');
      await page.waitForFunction(() => {
        const path = document.getElementById('workLinkPath')?.textContent || '';
        return document.body.dataset.workPath !== 'rf' && path.includes('רשת בית');
      });
    } finally {
      await page.close();
    }
  }, 30000);
});
