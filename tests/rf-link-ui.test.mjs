import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4046';
const BASE = `http://127.0.0.1:${PORT}`;
const REASON = 'במצב RF אין וידאו ואין גישה למחשב המשימה';

describe('RF reduced console', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT,
        SQLITE_PATH: `/tmp/airvix-rf-ui-${PORT}.sqlite`,
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

  it('shows the active RF path and disables video and the mission computer', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const step = async (name, fn) => {
      try { return await fn(); }
      catch (err) { throw new Error(`${name}: ${err.message}`); }
    };
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(BASE) || url.startsWith('data:')) return route.continue();
      return route.abort();
    });
    await step('goto', () => page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 }));
    await step('open', () => page.click('#connectToggleBtn', { timeout: 5000 }));
    await step('picker', () => page.waitForSelector('#workLinkRf', { timeout: 5000 }));
    const fit = await page.evaluate(() => {
      const box = document.querySelector('#workLinkPicker');
      if (!box) return false;
      return box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
    });
    expect(fit).toBe(true);
    await step('rf', () => page.check('#workLinkRf', { timeout: 5000 }));
    await step('reason', () => page.waitForFunction((reason) => {
      const el = document.getElementById('rfReducedReason');
      return el && !el.hidden && el.textContent.includes(reason)
        && document.getElementById('workLinkPath').textContent.includes('RF');
    }, REASON, { timeout: 5000 }));
    expect(await page.locator('#assistVoiceGoToggle').isDisabled()).toBe(true);
    await step('recordings', () => page.click('[data-tab="recordings"]', { timeout: 5000 }));
    await step('cam', () => page.waitForFunction((reason) => {
      const el = document.getElementById('cam0Reason');
      return el && el.textContent.includes(reason);
    }, REASON, { timeout: 5000 }));
    await step('reopen', () => page.click('#connectToggleBtn', { timeout: 5000 }));
    await step('home', () => page.check('#workLinkHome', { timeout: 5000 }));
    await step('path', () => page.waitForFunction(() => document.body.dataset.workPath !== 'rf'
      && document.getElementById('workLinkPath').textContent.includes('רשת בית'), { timeout: 5000 }));
    await page.close();
  }, 30000);
});
