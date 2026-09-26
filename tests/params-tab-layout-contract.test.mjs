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

  it('switches the parameter list when the group changes', async () => {
    const sizes = [
      { width: 1440, height: 900, name: '1440x900' },
      { width: 360, height: 800, name: '360x800' },
    ];
    for (const vp of sizes) {
      writes.length = 0;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openParams();
      await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"]', { timeout: 15000 });
      const ekf = await page.evaluate(() => {
        const honesty = document.getElementById('plndProfileHonesty');
        const row = document.querySelector('.fc-group-row');
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const rows = [...document.querySelectorAll('#fcGroupList .fc-group-row')].slice(0, 4).map(box);
        const clip = document.getElementById('arduParams')?.getBoundingClientRect();
        const first = row ? box(row) : null;
        return {
          honestyHidden: honesty?.hidden === true,
          honestyDisplay: honesty ? getComputedStyle(honesty).display : '',
          keys: [...document.querySelectorAll('#fcGroupList .fc-group-key')].map((el) => el.textContent),
          now: document.querySelector('#fcGroupList [data-param-key="EK3_ENABLE"] .fc-group-now')?.textContent,
          formDisplay: getComputedStyle(document.getElementById('arduParamFormPanels')).display,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rowWidth: first ? first.width : 0,
          rowTop: first ? first.top : -1,
          rowInPanel: !!(first && clip && first.top >= clip.top - 1 && first.top < clip.bottom - 8 && first.bottom > clip.top + 8),
          rowInView: !!(first && first.top >= 0 && first.top < window.innerHeight - 24),
          rows,
        };
      });
      expect(ekf.honestyHidden, vp.name).toBe(true);
      expect(ekf.honestyDisplay, vp.name).toBe('none');
      expect(ekf.keys, vp.name).toContain('EK3_ENABLE');
      expect(ekf.keys, vp.name).not.toContain('GPS_TYPE');
      expect(ekf.now, vp.name).toBe('לא ידוע');
      expect(ekf.formDisplay, vp.name).toBe('none');
      expect(ekf.docOverflow, vp.name).toBeLessThanOrEqual(1);
      expect(ekf.rowWidth, vp.name).toBeGreaterThan(40);
      expect(ekf.rowInPanel, vp.name).toBe(true);
      expect(ekf.rowInView, vp.name).toBe(true);
      for (let i = 0; i < ekf.rows.length; i += 1) {
        for (let j = i + 1; j < ekf.rows.length; j += 1) {
          expect(interiorsIntersect(ekf.rows[i], ekf.rows[j]), `${vp.name} row ${i} ${j}`).toBe(false);
        }
      }

      await page.fill('#arduParamSearchInput', 'EK3_GPS');
      await page.waitForFunction(() => {
        const keys = [...document.querySelectorAll('#fcGroupList .fc-group-key')].map((el) => el.textContent);
        return keys.includes('EK3_GPS_CHECK') && !keys.includes('EK3_ENABLE');
      });
      await page.click('#arduParamSearchClearBtn');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"]');

      await page.selectOption('#paramSubtabSelect', 'ardu-gps');
      await page.waitForSelector('#fcGroupList [data-param-key="GPS_TYPE"]');
      const gpsKeys = await page.locator('#fcGroupList .fc-group-key').allTextContents();
      expect(gpsKeys, vp.name).toContain('GPS_TYPE');
      expect(gpsKeys, vp.name).not.toContain('EK3_ENABLE');
      expect(await page.locator('[data-param-key="GPS_TYPE"] .fc-group-now').innerText()).toBe('לא ידוע');

      await page.fill('#arduParamSearchInput', 'EK3');
      await page.waitForFunction(() => document.querySelector('#fcGroupList .fc-group-empty')?.textContent === 'אין התאמה בקבוצה');
      await page.click('#arduParamSearchClearBtn');
      await page.waitForSelector('#fcGroupList [data-param-key="GPS_TYPE"]');

      await page.fill('.fc-group-row[data-param-key="GPS_TYPE"] input', '1');
      await page.click('#fcGroupApply');
      await page.waitForSelector('#applyConfirmModal:not(.hidden)');
      await page.click('#applyConfirmCancelBtn');
      await page.waitForFunction(() => document.getElementById('applyConfirmModal')?.classList.contains('hidden') === true);
      expect(writes, vp.name).toEqual([]);

      await page.selectOption('#paramSubtabSelect', 'landingParams');
      await page.waitForFunction(() => document.getElementById('plndProfileHonesty')?.hidden === false);
    }
  }, 90000);
});
