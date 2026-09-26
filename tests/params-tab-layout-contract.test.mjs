import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const VIEWPORTS = [
  { width: 1366, height: 768, name: '1366x768' },
  { width: 1920, height: 1080, name: '1920x1080' },
  { width: 360, height: 800, name: '360x800' },
];

function interiorsIntersect(a, b, slack = 1) {
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

function startServer(port) {
  const sqlite = path.join(os.tmpdir(), `airvix-params-layout-${port}.sqlite`);
  fs.rmSync(sqlite, { force: true });
  return spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: sqlite,
      GEMINI_API_KEY: '',
      COMPANION_MODE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitHealth(base, maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`params server did not become healthy at ${base}`);
}

describe('Parameters tab layout contract — static source', () => {
  it('marks the tab and hides the wizard until its subtab is open', () => {
    expect(html).toContain('data-layout-contract="params-v1"');
    expect(html).toContain('id="jetsonToolState"');
    expect(html).toContain('id="fcToolState"');
    expect(html).toContain('id="paramToolFault"');
    expect(html).toContain('id="paramFileMenu"');
    expect(html).toContain('מחשב משימה');
    expect(html).toContain('בקר טיסה');
    expect(css).toContain('#autoConfig.subpanel:not(.visible)');
    expect(css).toContain('.param-file-menu[hidden]');
    const panel = html.slice(html.indexOf('id="control"'), html.indexOf('id="recordings"'));
    expect(panel).not.toContain('רחפן');
  });
});

describe('Parameters tab layout contract — live boxes', () => {
  const PORT = '4036';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;
  let page = null;
  const writes = [];

  async function openParams() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="control"]');
    await page.waitForSelector('#jetsonToolState', { timeout: 15000 });
    await page.waitForSelector('#fcToolState', { timeout: 15000 });
  }

  async function measureToolbar() {
    return page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const segs = [...document.querySelectorAll('#control .param-tool-seg')].map(box);
      return {
        segs,
        file: box(document.getElementById('paramFileMenuBtn')),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        faultHidden: document.getElementById('paramToolFault')?.hidden === true,
        wizardHidden: document.getElementById('autoConfig')?.classList.contains('visible') !== true,
      };
    });
  }

  beforeAll(async () => {
    serverProc = startServer(PORT);
    await waitHealth(BASE);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.addInitScript(() => {
      try { sessionStorage.clear(); } catch { /* ignore */ }
    });
    await page.route('**/api/ardu/params/write', async (route) => {
      writes.push(route.request().postData() || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, message: 'הכתיבה הושלמה', written: [], failed: [], verified: {}, simulated: true }),
      });
    });
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  it('keeps the toolbar segments apart and the wizard usable at three sizes', async () => {
    for (const vp of VIEWPORTS) {
      writes.length = 0;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openParams();
      const toolbar = await measureToolbar();
      expect(toolbar.faultHidden, vp.name).toBe(true);
      expect(toolbar.wizardHidden, vp.name).toBe(true);
      expect(toolbar.docOverflow, vp.name).toBeLessThanOrEqual(1);
      expect(toolbar.segs, vp.name).toHaveLength(2);
      for (const seg of toolbar.segs) {
        expect(seg.width, vp.name).toBeGreaterThan(40);
        expect(seg.height, vp.name).toBeGreaterThan(24);
      }
      expect(interiorsIntersect(toolbar.segs[0], toolbar.segs[1]), vp.name).toBe(false);
      expect(interiorsIntersect(toolbar.segs[0], toolbar.file), vp.name).toBe(false);
      expect(interiorsIntersect(toolbar.segs[1], toolbar.file), vp.name).toBe(false);

      await page.click('[data-subtab="autoConfig"]');
      await page.waitForSelector('#acWhatList .ac-choice[data-peripheral-id="gps"]', { timeout: 15000 });
      const choices = await page.evaluate(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return [...document.querySelectorAll('#acWhatList .ac-choice')].map(box);
      });
      expect(choices.length, vp.name).toBeGreaterThanOrEqual(6);
      for (const choice of choices) {
        expect(choice.width, vp.name).toBeGreaterThan(40);
        expect(choice.height, vp.name).toBeGreaterThan(20);
      }
      for (let i = 0; i < choices.length; i += 1) {
        for (let j = i + 1; j < choices.length; j += 1) {
          expect(interiorsIntersect(choices[i], choices[j]), `${vp.name} choice ${i} ${j}`).toBe(false);
        }
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, vp.name).toBeLessThanOrEqual(1);

      await page.click('#acWhatList .ac-choice[data-peripheral-id="gps"]');
      await page.waitForSelector('#acWhereList .ac-choice[data-where-id="serial3"]');
      await page.click('#acWhereList .ac-choice[data-where-id="serial3"]');
      await page.waitForSelector('#acParamList .ac-param-key');
      const shown = await page.locator('#acParamList').innerText();
      expect(shown, vp.name).toContain('SERIAL3_PROTOCOL');
      expect(shown, vp.name).toContain('לא ידוע');
      const applyBox = await page.locator('#acApplyBtn').boundingBox();
      expect(applyBox?.width || 0, vp.name).toBeGreaterThan(20);
      expect(applyBox?.height || 0, vp.name).toBeGreaterThan(20);

      await page.click('#acApplyBtn');
      await page.waitForSelector('#applyConfirmModal:not(.hidden)');
      expect(await page.locator('#applyConfirmTitle').innerText()).toContain('FC');
      await page.click('#applyConfirmCancelBtn');
      await page.waitForFunction(() => document.getElementById('applyConfirmModal')?.classList.contains('hidden') === true);
      expect(writes, vp.name).toEqual([]);
    }
  }, 90000);
});
