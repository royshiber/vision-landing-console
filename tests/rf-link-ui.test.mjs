import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4052';
const BASE = `http://127.0.0.1:${PORT}`;
const SQLITE = `/tmp/airvix-rf-link-${PORT}-${process.pid}.sqlite`;
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

async function ensureLinkPanel(page) {
  const open = await page.locator('#connectPanel').isVisible().catch(() => false);
  if (!open) {
    await page.click('#connectToggleBtn');
    await page.waitForSelector('#connectPanel:not([hidden])');
  }
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
        SQLITE_PATH: SQLITE,
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
      const initialPost = page.waitForResponse((res) => (
        res.url().includes('/api/links/work') && res.request().method() === 'POST'
      ));
      await openLinkPanel(page);
      await initialPost;
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

  it('disables the optics tab in RF and does not invent a connected radio', async () => {
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
      await page.waitForFunction(() => {
        const path = document.getElementById('workLinkPath')?.textContent || '';
        return path.length > 0;
      });
      if (await page.evaluate(() => document.body.dataset.workPath === 'rf')) {
        await page.click('#workLinkAuto');
        await page.waitForFunction(() => document.body.dataset.workPath !== 'rf');
      }
      await page.click('[data-tab="optics"]');
      await page.waitForSelector('#optics.panel.visible');
      await ensureLinkPanel(page);
      await page.click('#workLinkRf');
      await page.waitForFunction((reason) => {
        const path = document.getElementById('workLinkPath')?.textContent || '';
        const radio = document.getElementById('radioLinkStatus')?.textContent || '';
        const tab = document.querySelector('button.tab[data-tab="optics"]');
        const flight = document.querySelector('button.tab[data-tab="terrain"]');
        const btn = document.getElementById('connectBtn');
        return path.includes('נתיב פעיל: RF')
          && document.body.dataset.workPath === 'rf'
          && radio === 'מנותק'
          && radio !== 'מחובר'
          && tab?.disabled === true
          && tab.title === reason
          && flight?.classList.contains('active')
          && !document.getElementById('optics')?.classList.contains('visible')
          && !document.getElementById('rfOpticsStatus')
          && btn?.textContent === 'חיבור ל-RF'
          && btn?.title === 'חיבור ל-RF';
      }, REASON);
      for (const id of ['horizonVideoToggle', 'annotatedVisionToggle', 'liveCameraToggle', 'missionRecordBtn']) {
        expect(await page.locator(`#${id}`).isDisabled()).toBe(true);
      }
      await page.click('[data-tab="optics"]', { force: true });
      await page.waitForFunction((reason) => {
        const up = document.querySelector('#gimbalPad [data-gimbal="up"]');
        const flight = document.querySelector('button.tab[data-tab="terrain"]');
        return up && up.disabled && (up.title || '').includes(reason)
          && document.getElementById('gimbalPad')?.dataset.state === 'down'
          && flight?.classList.contains('active');
      }, REASON);
      const view = await page.evaluate((reason) => {
        const tab = document.querySelector('button.tab[data-tab="optics"]');
        const flight = document.getElementById('terrain');
        const optics = document.getElementById('optics');
        const layout = document.querySelector('.layout');
        const flightBox = flight.getBoundingClientRect();
        return {
          title: tab.title,
          disabled: tab.disabled,
          opacity: Number(getComputedStyle(tab).opacity),
          opticsVisible: optics.classList.contains('visible'),
          flightVisible: flight.classList.contains('visible'),
          gapBelow: Math.round(layout.getBoundingClientRect().bottom - flightBox.bottom),
          flightH: Math.round(flightBox.height),
          cards: document.getElementById('rfOpticsStatus'),
          radio: document.getElementById('radioLinkStatus')?.textContent || '',
          connect: document.getElementById('connectBtn')?.textContent || '',
          connectTitle: document.getElementById('connectBtn')?.title || '',
        };
      }, REASON);
      expect(view.title).toBe(REASON);
      expect(view.disabled).toBe(true);
      expect(view.opacity).toBeLessThan(0.7);
      expect(view.opticsVisible).toBe(false);
      expect(view.flightVisible).toBe(true);
      expect(view.flightH).toBeGreaterThan(400);
      expect(view.cards).toBeNull();
      expect(view.radio).toBe('מנותק');
      expect(view.connect).toBe('חיבור ל-RF');
      expect(view.connectTitle).toBe('חיבור ל-RF');
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-optics-1366.png', animations: 'disabled', timeout: 8000 });
      await ensureLinkPanel(page);
      await page.click('#workLinkAuto');
      await page.waitForFunction(() => {
        const tab = document.querySelector('button.tab[data-tab="optics"]');
        return document.body.dataset.workPath !== 'rf'
          && tab
          && tab.disabled === false
          && tab.title === 'אופטיקה'
          && tab.classList.contains('active')
          && document.getElementById('optics')?.classList.contains('visible');
      });
      await page.click('#workLinkRf');
      await page.waitForFunction((reason) => {
        const tab = document.querySelector('button.tab[data-tab="optics"]');
        const flight = document.querySelector('button.tab[data-tab="terrain"]');
        return document.body.dataset.workPath === 'rf'
          && tab?.disabled === true
          && tab.title === reason
          && flight?.classList.contains('active');
      }, REASON);
      await page.click('[data-tab="recordings"]');
      await page.waitForFunction((he) => document.getElementById('archiveSessionsEmpty')?.textContent === he, 'הארכיון לא זמין במצב RF');
      const debrief = await page.evaluate(() => {
        const panel = document.getElementById('debriefRecordingsPanel');
        const video = panel.querySelector('.video-column');
        const side = panel.querySelector('.debrief-recordings-side');
        const player = document.getElementById('debriefPlayer');
        return {
          video: getComputedStyle(video).display,
          player: getComputedStyle(player).display,
          sideW: Math.round(side.getBoundingClientRect().width),
          videoW: Math.round(video.getBoundingClientRect().width),
          fileDisabled: document.getElementById('videoInput').disabled,
          empty: document.getElementById('archiveSessionsEmpty').textContent,
        };
      });
      expect(debrief.video).not.toBe('none');
      expect(debrief.player).not.toBe('none');
      expect(debrief.videoW).toBeGreaterThan(debrief.sideW);
      expect(debrief.sideW).toBeGreaterThanOrEqual(180);
      expect(debrief.sideW).toBeLessThanOrEqual(320);
      expect(debrief.fileDisabled).toBe(false);
      expect(debrief.empty).toBe('הארכיון לא זמין במצב RF');
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-debrief-1366.png', animations: 'disabled', timeout: 8000 });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.click('[data-tab="terrain"]');
      await page.waitForSelector('#terrain.panel.visible');
      const wideFlight = await page.evaluate((reason) => {
        const tab = document.querySelector('button.tab[data-tab="optics"]');
        const flight = document.getElementById('terrain');
        return {
          disabled: tab.disabled,
          title: tab.title,
          flightH: Math.round(flight.getBoundingClientRect().height),
          optics: document.getElementById('optics').classList.contains('visible'),
          reason,
        };
      }, REASON);
      expect(wideFlight.disabled).toBe(true);
      expect(wideFlight.title).toBe(REASON);
      expect(wideFlight.optics).toBe(false);
      expect(wideFlight.flightH).toBeGreaterThan(400);
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-optics-1440.png', animations: 'disabled', timeout: 8000 });
      await page.click('[data-tab="recordings"]');
      const debriefWide = await page.evaluate(() => {
        const panel = document.getElementById('debriefRecordingsPanel');
        const side = panel.querySelector('.debrief-recordings-side');
        const video = panel.querySelector('.video-column');
        return {
          sideW: Math.round(side.getBoundingClientRect().width),
          videoW: Math.round(video.getBoundingClientRect().width),
          player: getComputedStyle(document.getElementById('debriefPlayer')).display,
        };
      });
      expect(debriefWide.player).not.toBe('none');
      expect(debriefWide.videoW).toBeGreaterThan(debriefWide.sideW);
      expect(debriefWide.sideW).toBeGreaterThanOrEqual(180);
      expect(debriefWide.sideW).toBeLessThanOrEqual(320);
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-debrief-1440.png', animations: 'disabled', timeout: 8000 });
      await page.click('#connectToggleBtn');
      await page.waitForSelector('#connectPanel:not([hidden])');
      const wide = await page.evaluate(() => {
        const panel = document.getElementById('connectPanel');
        const rc = document.querySelector('#commLinkRows .comm-link-row[data-link="rc"]');
        const status = rc.querySelector('.comm-link-status');
        const panelBox = panel.getBoundingClientRect();
        const rcBox = rc.getBoundingClientRect();
        const statusBox = status.getBoundingClientRect();
        const btn = document.getElementById('connectBtn');
        const btnBox = btn.getBoundingClientRect();
        return {
          height: panel.clientHeight,
          scroll: panel.scrollHeight,
          rcIn: rcBox.bottom <= panelBox.bottom + 1 && rcBox.bottom <= window.innerHeight,
          statusIn: statusBox.bottom <= window.innerHeight && statusBox.height > 0,
          connect: btn.textContent,
          radio: document.getElementById('radioLinkStatus')?.textContent || '',
          connectFits: btn.scrollWidth <= btn.clientWidth + 1
            && btn.scrollHeight <= btn.clientHeight + 1
            && btnBox.left >= panelBox.left - 1
            && btnBox.right <= panelBox.right + 1,
        };
      });
      expect(wide.height).toBeLessThanOrEqual(360);
      expect(wide.scroll).toBeLessThanOrEqual(wide.height + 1);
      expect(wide.rcIn).toBe(true);
      expect(wide.statusIn).toBe(true);
      expect(wide.connect).toBe('חיבור ל-RF');
      expect(wide.radio).toBe('מנותק');
      expect(wide.connectFits).toBe(true);
      await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/rf-popover-1440.png', animations: 'disabled', timeout: 8000 });
    } finally {
      await page.close();
    }
  }, 30000);
});

function documentBodyPath(value) {
  return value;
}
