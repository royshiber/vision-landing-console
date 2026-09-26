import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { qualityFromMavlinkRssi, summarizeCommLinks } from '../lib/comm-links.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/connect-popover';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function payload(comm, extra = {}) {
  return {
    ok: true,
    links: {
      radio: extra.radio || 'disconnected',
      cellular: extra.cellular || 'disconnected',
      radioLabelHe: 'רדיו טלמטריה',
      radioStatusHe: extra.radioStatusHe || 'מנותק',
      cellularStatusHe: extra.cellularStatusHe || 'מנותק',
      modemPresent: extra.modemPresent === true,
      modem: extra.modem || { present: extra.modemPresent === true, reasonHe: extra.modemPresent ? 'מודם זוהה' : 'מודם לא מחובר' },
      canSelectActive: false,
      active: null,
      companion: extra.companion || { jetson: 'off', hint_he: 'חברו מחשב משימה בלחיצה.' },
      comm,
      video: { available: false, reasonHe: 'אין שידור' },
      pillLabelHe: comm.pillLabelHe,
      pillDot: comm.pillDot,
      endpoint: { host: '0.0.0.0', port: 14560 },
      ops: { commandLink: null },
    },
  };
}

const scenarios = {
  'all-up': payload(summarizeCommLinks({
    radio: 'connected',
    cellular: 'connected',
    modemPresent: true,
    radioViaRelay: true,
    radioLive: {
      connected: true,
      type: 'tcp',
      heartbeatCount: 8,
      framesRx: 40,
      lastHeartbeatAgeMs: 280,
      heartbeatRateHz: 1,
    },
    cellularLive: {
      connected: true,
      heartbeatCount: 6,
      framesRx: 18,
      lastHeartbeatAgeMs: 420,
    },
    cellularSignal: { rsrp: -78, rsrq: -9 },
    companion: {
      jetson: 'reachable',
      fc: 'heartbeat',
      fc_heartbeat: true,
      hasData: true,
      hint_he: 'מחשב משימה מחובר. בקר טיסה עם דופק.',
      httpRttMs: 42,
    },
    rc: {
      state: 'live',
      quality: qualityFromMavlinkRssi(200, 'עוצמת אות שלט'),
    },
    uplinkControl: true,
    uplinks: {
      wifi: { enabled: true, up: true, signal_dbm: -55 },
      cellular: { enabled: true, up: true },
    },
  }), {
    radio: 'connected',
    cellular: 'connected',
    modemPresent: true,
    radioStatusHe: 'מחובר',
    cellularStatusHe: 'מחובר',
    companion: {
      jetson: 'reachable',
      fc: 'heartbeat',
      fc_heartbeat: true,
      hasData: true,
      connected: true,
      hint_he: 'מחשב משימה מחובר. בקר טיסה עם דופק.',
      jetsonLabelHe: 'מחשב משימה',
      jetsonStatusHe: 'מחובר',
      fcLabelHe: 'בקר טיסה',
      fcStatusHe: 'דופק חי',
    },
  }),
  'cellular-only': payload(summarizeCommLinks({
    modemPresent: true,
    cellularSignal: { rsrp: -92 },
    cellularLive: {
      connected: true,
      heartbeatCount: 4,
      framesRx: 9,
      lastHeartbeatAgeMs: 700,
    },
    radio: 'disconnected',
    companion: { jetson: 'off', hint_he: 'חברו מחשב משימה בלחיצה.' },
    uplinkControl: true,
    uplinks: {
      wifi: { enabled: false, up: false },
      cellular: { enabled: true, up: true },
    },
  }), {
    cellular: 'connected',
    modemPresent: true,
    cellularStatusHe: 'מחובר',
  }),
  'signal-dbm': payload(summarizeCommLinks({
    modemPresent: true,
    uplinkControl: true,
    companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר.' },
    uplinks: {
      wifi: { enabled: true, up: false },
      cellular: {
        enabled: true,
        up: true,
        signal: { rssi: null, rsrp: -78, rsrq: null, sinr: null },
        signal_icon: 2,
        signal_max: 5,
        network_label: 'LTE',
        operator: { short: 'Partner', full: 'Partner' },
      },
    },
  }), { modemPresent: true, cellularStatusHe: 'מחובר' }),
  'signal-icon-5': payload(summarizeCommLinks({
    modemPresent: true,
    uplinkControl: true,
    companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר.' },
    uplinks: {
      wifi: { enabled: true, up: false },
      cellular: {
        enabled: true,
        up: true,
        signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
        signal_icon: 5,
        signal_max: 5,
        network_label: 'LTE',
        operator: { short: 'Partner', full: 'Partner' },
      },
    },
  }), { modemPresent: true, cellularStatusHe: 'מחובר' }),
  'signal-icon-2': payload(summarizeCommLinks({
    modemPresent: true,
    uplinkControl: true,
    companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר.' },
    uplinks: {
      wifi: { enabled: true, up: false },
      cellular: {
        enabled: true,
        up: true,
        signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
        signal_icon: 2,
        signal_max: 5,
        network_label: 'LTE',
        operator: { short: 'Partner', full: 'Partner' },
      },
    },
  }), { modemPresent: true, cellularStatusHe: 'מחובר' }),
  'signal-none': payload(summarizeCommLinks({
    modemPresent: true,
    uplinkControl: true,
    companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר.' },
    uplinks: {
      wifi: { enabled: true, up: false },
      cellular: {
        enabled: true,
        up: true,
        signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
        signal_icon: null,
        signal_max: null,
        network_label: null,
        operator: { short: null, full: null },
      },
    },
  }), { modemPresent: true, cellularStatusHe: 'מחובר' }),
  'all-down': payload(summarizeCommLinks({
    modemPresent: false,
    radio: 'disconnected',
    cellular: 'disconnected',
    companion: { jetson: 'off', hint_he: 'חברו מחשב משימה בלחיצה.' },
  }), {
    modemPresent: false,
  }),
};

describe('connect popover layout and mocked states', () => {
  let server;
  let base;
  let browser;

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    const app = express();
    app.use(express.static(path.join(repoRoot, 'public')));
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}/index.html`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openScenario(name) {
    const page = await browser.newPage({
      viewport: { width: 360, height: 780 },
      locale: 'he-IL',
    });
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/.test(url)) return route.abort();
      return route.continue();
    });
    await page.route('**/api/**', (route) => {
      const url = route.request().url();
      if (url.includes('/api/links')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(scenarios[name]),
        });
      }
      if (url.includes('/api/meta')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            appVersion: '1.02.332',
            features: { mavlinkQuickConnect: true, dualLink: true },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#connectToggleBtn');
    await page.click('#connectToggleBtn');
    await page.waitForSelector('#connectPanel:not([hidden])');
    await page.waitForTimeout(200);
    return page;
  }

  async function rowSnapshot(page) {
    return page.evaluate(() => [...document.querySelectorAll('#commLinkRows .comm-link-row')].map((el) => ({
      id: el.dataset.link,
      tone: el.dataset.tone,
      status: el.querySelector('.comm-link-status')?.textContent || '',
      action: el.querySelector('.comm-link-action')?.textContent || '',
      bars: el.querySelector('.comm-link-bars')?.dataset.bars || '',
      quality: el.querySelector('.comm-link-bars')?.dataset.quality || '',
      tip: el.querySelector('.comm-link-bars')?.title || '',
      meta: el.querySelector('.comm-link-meta')?.hidden
        ? ''
        : (el.querySelector('.comm-link-meta')?.textContent || ''),
    })));
  }

  async function assertLayout(page) {
    const dir = await page.locator('html').getAttribute('dir');
    expect(dir).toBe('rtl');
    const rows = page.locator('#commLinkRows .comm-link-row');
    expect(await rows.count()).toBe(4);
    const ids = await rows.evaluateAll((els) => els.map((el) => el.dataset.link));
    expect(ids).toEqual(['cellular', 'radio', 'home', 'rc']);
    const advancedVisible = await page.locator('#connectAdvanced').isVisible();
    expect(advancedVisible).toBe(true);
    const clip = await page.evaluate(() => {
      const panel = document.getElementById('connectPanel');
      const panelRect = panel.getBoundingClientRect();
      const rowOverflow = [...document.querySelectorAll('#commLinkRows .comm-link-row')].map((el) => ({
        id: el.dataset.link,
        overflow: el.scrollWidth - el.clientWidth,
      }));
      return {
        panelRight: panelRect.right,
        panelLeft: panelRect.left,
        vw: window.innerWidth,
        rowOverflow,
      };
    });
    expect(clip.panelLeft).toBeGreaterThanOrEqual(-1);
    expect(clip.panelRight).toBeLessThanOrEqual(clip.vw + 1);
    for (const row of clip.rowOverflow) {
      expect(row.overflow, row.id).toBeLessThanOrEqual(1);
    }
    const mapHit = await page.evaluate(() => {
      const panel = document.getElementById('connectPanel');
      const panelRect = panel.getBoundingClientRect();
      const controls = [...document.querySelectorAll(
        '#terrainLayerStreetBtn, #terrainLayerSatBtn, #terrainShowLoadedPathBtn, .leaflet-control',
      )];
      const overlaps = [];
      const paintedOnTop = [];
      for (const el of controls) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const overlapsPanel = rect.left < panelRect.right - 1
          && rect.right > panelRect.left + 1
          && rect.top < panelRect.bottom - 1
          && rect.bottom > panelRect.top + 1;
        if (!overlapsPanel) continue;
        overlaps.push(el.id || el.className);
        const x = Math.min(Math.max(rect.left + rect.width / 2, panelRect.left + 2), panelRect.right - 2);
        const y = Math.min(Math.max(rect.top + rect.height / 2, panelRect.top + 2), panelRect.bottom - 2);
        const top = document.elementFromPoint(x, y);
        if (!top || !panel.contains(top)) {
          paintedOnTop.push({
            id: el.id || '',
            text: (el.textContent || '').trim().slice(0, 40),
            top: top ? (top.id || top.className || top.tagName) : '',
          });
        }
      }
      return { overlaps, paintedOnTop };
    });
    expect(mapHit.overlaps.length, 'map controls must sit under the open popover').toBeGreaterThan(0);
    expect(mapHit.paintedOnTop).toEqual([]);
  }

  it('renders all up, cellular only, and all down without clipping at 360px', async () => {
    for (const name of ['all-up', 'cellular-only', 'all-down']) {
      const page = await openScenario(name);
      try {
        await assertLayout(page);
        const rows = await rowSnapshot(page);
        const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
        if (name === 'all-up') {
          expect(byId.cellular).toMatchObject({ tone: 'ok', status: 'מחובר', action: 'התנתק' });
          expect(byId.radio).toMatchObject({ tone: 'ok', status: 'מחובר', action: 'התנתק' });
          expect(byId.home).toMatchObject({ tone: 'ok', status: 'מחובר', action: 'התנתק' });
          expect(Number(byId.cellular.bars)).toBeGreaterThan(0);
          expect(Number(byId.radio.bars)).toBeGreaterThan(0);
          expect(Number(byId.home.bars)).toBeGreaterThan(0);
          const homeBg = await page.locator('#companionLinkBtn').evaluate((el) => getComputedStyle(el).backgroundColor);
          const cellBg = await page.locator('#cellularConnectBtn').evaluate((el) => getComputedStyle(el).backgroundColor);
          expect(homeBg).toBe('rgb(220, 38, 38)');
          expect(cellBg).toBe('rgb(220, 38, 38)');
          expect(homeBg).not.toBe('rgb(22, 163, 74)');
        } else if (name === 'cellular-only') {
          expect(byId.cellular).toMatchObject({ tone: 'ok', status: 'מחובר', action: 'התנתק' });
          expect(byId.radio).toMatchObject({ tone: 'off', status: 'מנותק', action: 'התחבר' });
          expect(byId.home).toMatchObject({ tone: 'off', status: 'מושבת', action: 'התחבר' });
          expect(byId.rc.status).toBe('אין נתונים');
        } else {
          expect(byId.cellular).toMatchObject({ tone: 'off', status: 'אין מודם', action: 'התחבר' });
          expect(byId.radio).toMatchObject({ tone: 'off', status: 'מנותק', action: 'התחבר' });
          expect(byId.home).toMatchObject({ tone: 'off', status: 'מנותק', action: 'התחבר' });
          expect(byId.rc.status).toBe('אין נתונים');
          const locked = await page.locator('#companionLinkBtn').evaluate((el) => ({
            disabled: el.disabled,
            title: el.title,
            action: el.dataset.action,
            bg: getComputedStyle(el).backgroundColor,
          }));
          expect(locked.disabled).toBe(true);
          expect(locked.title).toBe('גרסת ה-Jetson לא תומכת בשליטה בערוץ');
          expect(locked.action).toBe('connect');
          expect(locked.bg).not.toBe('rgb(22, 163, 74)');
          const cellLocked = await page.locator('#cellularConnectBtn').evaluate((el) => ({
            disabled: el.disabled,
            title: el.title,
          }));
          expect(cellLocked.disabled).toBe(true);
          expect(cellLocked.title).toBe('גרסת ה-Jetson לא תומכת בשליטה בערוץ');
        }
        const file = path.join(shotDir, `${name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        expect(fs.statSync(file).size).toBeGreaterThan(1000);
      } finally {
        await page.close();
      }
    }
  }, 20000);

  it('shows dBm bars, icon 5/5, icon 2/5, and an empty modem without clipping', async () => {
    const expectCell = {
      'signal-dbm': { bars: '4', quality: 'known', meta: 'LTE · Partner', tip: /דציבל/ },
      'signal-icon-5': { bars: '4', quality: 'known', meta: 'LTE · Partner', tip: /המודם לא מדווח ערכי דציבל, רק פסים/ },
      'signal-icon-2': { bars: '2', quality: 'known', meta: 'LTE · Partner', tip: /2 מתוך 5/ },
      'signal-none': { bars: '0', quality: 'unknown', meta: '', tip: /אין נתונים/ },
    };
    for (const name of Object.keys(expectCell)) {
      const page = await openScenario(name);
      try {
        await assertLayout(page);
        const rows = await rowSnapshot(page);
        const cell = Object.fromEntries(rows.map((row) => [row.id, row])).cellular;
        const want = expectCell[name];
        expect(cell.bars, name).toBe(want.bars);
        expect(cell.quality, name).toBe(want.quality);
        expect(cell.meta, name).toBe(want.meta);
        expect(cell.tip, name).toMatch(want.tip);
        if (name === 'signal-dbm') expect(cell.tip).not.toMatch(/המודם לא מדווח/);
        const file = path.join(shotDir, `${name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        expect(fs.statSync(file).size).toBeGreaterThan(1000);
      } finally {
        await page.close();
      }
    }
  }, 20000);
});
