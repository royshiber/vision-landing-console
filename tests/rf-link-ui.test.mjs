import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4052';
const BASE = `http://127.0.0.1:${PORT}`;
const REASON = 'במצב RF אין וידאו';
const PORT_REASON = 'בחרו פורט';

function trackWorkPosts(page, posts) {
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/api/links/work')) return;
    try { posts.push(req.postDataJSON()); } catch { posts.push(null); }
  });
}

async function openLinkPanel(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.click('#connectToggleBtn');
  await page.waitForSelector('#workLinkPicker');
}

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

  it('does not send an empty port and does not claim RF without one', async () => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const posts = [];
    try {
      trackWorkPosts(page, posts);
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        return route.abort();
      });
      await openLinkPanel(page);
      await page.waitForFunction(() => {
        const text = document.getElementById('workLinkPath')?.textContent || '';
        return text.includes('אין נתיב') || text.includes('אוטומטי') || text.includes('רשת בית') || text.includes('סלולר');
      });
      await page.click('#workLinkRf');
      await page.waitForFunction((reason) => {
        const path = document.getElementById('workLinkPath')?.textContent || '';
        const radio = document.getElementById('radioLinkStatus')?.textContent || '';
        return path === reason && radio === reason;
      }, PORT_REASON);
      expect(documentBodyPath(await page.evaluate(() => document.body.dataset.workPath || ''))).toBe('');
      expect(posts.some((body) => body && body.serialPort === '')).toBe(false);
      expect(await page.locator('#gimbalPad').getAttribute('data-state')).not.toBe('live');
      expect(await page.locator('#rfOpticsNotice').isHidden()).toBe(true);
      const fit = await page.evaluate(() => {
        const panel = document.getElementById('connectPanel');
        const rc = document.querySelector('#commLinkRows .comm-link-row[data-link="rc"]');
        const status = rc?.querySelector('.comm-link-status');
        const panelBox = panel.getBoundingClientRect();
        const rcBox = rc.getBoundingClientRect();
        const statusBox = status.getBoundingClientRect();
        const choice = document.querySelector('#workLinkPicker .conn-active-choice');
        return {
          height: panel.clientHeight,
          scroll: panel.scrollHeight,
          overflow: getComputedStyle(panel).overflowY,
          rcIn: rcBox.top >= panelBox.top - 1 && rcBox.bottom <= panelBox.bottom + 1 && rcBox.bottom <= window.innerHeight,
          statusIn: statusBox.bottom <= window.innerHeight && statusBox.height > 0,
          styled: choice?.classList.contains('conn-active-choice') === true,
        };
      });
      expect(fit.height).toBeLessThanOrEqual(360);
      expect(fit.scroll).toBeLessThanOrEqual(fit.height + 1);
      expect(fit.overflow).not.toBe('auto');
      expect(fit.overflow).not.toBe('scroll');
      expect(fit.rcIn).toBe(true);
      expect(fit.statusIn).toBe(true);
      expect(fit.styled).toBe(true);
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-popover-1366-noport.png' });
    } finally {
      await page.close();
    }
  }, 30000);

  it('keeps a saved port across reload and shows the open error', async () => {
    const seed = await fetch(`${BASE}/api/links/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'rf', serialPort: 'COM5', baudRate: 57600 }),
    });
    expect(seed.status).toBe(400);
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const posts = [];
    try {
      trackWorkPosts(page, posts);
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        return route.abort();
      });
      await openLinkPanel(page);
      await page.waitForFunction(() => {
        const path = document.getElementById('workLinkPath')?.textContent || '';
        const radio = document.getElementById('radioLinkStatus')?.textContent || '';
        return path.length > 0 && path === radio && !path.includes('נתיב פעיל: RF');
      });
      const stored = await fetch(`${BASE}/api/links/work`).then((r) => r.json());
      expect(stored.serialPort).toBe('COM5');
      expect(posts.some((body) => body && Object.prototype.hasOwnProperty.call(body, 'serialPort') && body.serialPort === '')).toBe(false);
      expect(posts.some((body) => body && body.serialPort === 'COM5')).toBe(true);
      const label = await page.locator('#workLinkPath').innerText();
      expect(label).toBe('פתיחת הפורט נכשלה');
      expect(await page.locator('#radioLinkStatus').innerText()).toBe(label);
      expect(await page.locator('#rfComPort').inputValue()).toBe('COM5');
      expect(await page.evaluate(() => document.body.dataset.workPath || '')).toBe('');
    } finally {
      await page.close();
    }
  }, 30000);

  it('shows one compact RF notice and disables video controls when the port is up', async () => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    try {
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (!url.startsWith(BASE)) return route.abort();
        if (route.request().method() === 'POST' && url.includes('/api/links/work')) {
          const body = route.request().postDataJSON() || {};
          if (body.mode === 'rf' && body.serialPort) {
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                mode: 'rf',
                path: 'rf',
                serialPort: body.serialPort,
                baudRate: body.baudRate || 57600,
                reduced: true,
                reasonHe: REASON,
                pathLabelHe: 'נתיב פעיל: RF',
              }),
            });
          }
        }
        return route.continue();
      });
      await openLinkPanel(page);
      await page.waitForFunction((reason) => {
        const path = document.getElementById('workLinkPath')?.textContent || '';
        const radio = document.getElementById('radioLinkStatus')?.textContent || '';
        return path.includes('נתיב פעיל: RF') && document.body.dataset.workPath === 'rf' && radio === 'מחובר';
      }, REASON);
      for (const id of ['horizonVideoToggle', 'annotatedVisionToggle', 'liveCameraToggle', 'missionRecordBtn']) {
        expect(await page.locator(`#${id}`).isDisabled()).toBe(true);
      }
      await page.click('[data-tab="optics"]');
      await page.waitForSelector('#rfOpticsNotice:not([hidden])');
      await page.waitForFunction((reason) => {
        const up = document.querySelector('#gimbalPad [data-gimbal="up"]');
        return up && up.disabled && (up.title || '').includes(reason) && document.getElementById('gimbalPad')?.dataset.state === 'down';
      }, REASON);
      const view = await page.evaluate((reason) => {
        const notice = document.getElementById('rfOpticsNotice');
        const grid = document.getElementById('debriefCamGrid');
        const pad = document.getElementById('gimbalPad');
        const up = pad.querySelector('[data-gimbal="up"]');
        const panel = document.getElementById('optics');
        return {
          text: notice.textContent,
          noticeH: notice.getBoundingClientRect().height,
          panelH: panel.getBoundingClientRect().height,
          grid: getComputedStyle(grid).display,
          pad: getComputedStyle(pad).display,
          padState: pad.dataset.state,
          upDisabled: up.disabled,
          upTitle: up.title || '',
          cams: getComputedStyle(document.getElementById('cam0Panel')).display,
        };
      }, REASON);
      expect(view.text).toBe(REASON);
      expect(view.noticeH).toBeLessThan(80);
      expect(view.panelH).toBeLessThan(view.noticeH + 48);
      expect(view.grid).toBe('none');
      expect(view.pad).toBe('none');
      expect(view.padState).toBe('down');
      expect(view.upDisabled).toBe(true);
      expect(view.upTitle).toContain(REASON);
      expect(view.cams).toBe('none');
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-optics-1366.png' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-optics-1440.png' });
      await page.click('#connectToggleBtn');
      await page.waitForSelector('#connectPanel:not([hidden])');
      const wide = await page.evaluate(() => {
        const panel = document.getElementById('connectPanel');
        const rc = document.querySelector('#commLinkRows .comm-link-row[data-link="rc"]');
        const status = rc.querySelector('.comm-link-status');
        const panelBox = panel.getBoundingClientRect();
        const rcBox = rc.getBoundingClientRect();
        const statusBox = status.getBoundingClientRect();
        return {
          height: panel.clientHeight,
          scroll: panel.scrollHeight,
          rcIn: rcBox.bottom <= panelBox.bottom + 1 && rcBox.bottom <= window.innerHeight,
          statusIn: statusBox.bottom <= window.innerHeight && statusBox.height > 0,
        };
      });
      expect(wide.height).toBeLessThanOrEqual(360);
      expect(wide.scroll).toBeLessThanOrEqual(wide.height + 1);
      expect(wide.rcIn).toBe(true);
      expect(wide.statusIn).toBe(true);
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-popover-1440.png' });
    } finally {
      await page.close();
    }
  }, 30000);
});

function documentBodyPath(value) {
  return value;
}
