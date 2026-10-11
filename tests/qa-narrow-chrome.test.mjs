import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeCommLinks } from '../lib/comm-links.mjs';
import { startTestServer } from './test-server.mjs';

let BASE = '';
const shots = process.env.VLC_NARROW_SHOTS || path.join(os.tmpdir(), 'airvix-narrow-qa');

function overlaps(a, b) {
  if (!a || !b || a.w < 2 || b.w < 2 || a.h < 2 || b.h < 2) return false;
  return a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
}

describe('narrow chrome QA', () => {
  let child;
  let browser;

  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    const started = await startTestServer({
      env: (port) => ({
        SQLITE_PATH: path.join(os.tmpdir(), `airvix-narrow-qa-${port}.sqlite`),
        COMPANION_MODE: 'mock',
        JETSON_COMPANION_BASE_URL: '',
      }),
      stdio: 'ignore',
    });
    child = started.child;
    BASE = started.base;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    if (child && !child.killed) child.kill('SIGTERM');
  });

  async function openAt(width, height) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#connectToggleBtn');
    await page.waitForSelector('.app-chrome .tab[data-tab="control"]');
    return page;
  }

  async function box(page, selector) {
    return page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        right: r.right, bottom: r.bottom,
        position: s.position,
      };
    });
  }

  for (const [width, height] of [[360, 740], [1024, 640]]) {
    it(`N1 ${width}x${height}: the connection pill does not cover פרמטרים or אופטיקה`, async () => {
      const page = await openAt(width, height);
      const pill = await box(page, '#connectToggleBtn');
      const widget = await box(page, '#connectWidget');
      const params = await box(page, '.tab[data-tab="control"]');
      const optics = await box(page, '.tab[data-tab="optics"]');
      expect(overlaps(pill, params), 'pill covers פרמטרים').toBe(false);
      expect(overlaps(pill, optics), 'pill covers אופטיקה').toBe(false);
      if (width < 480) {
        expect(widget.position).not.toBe('fixed');
        expect(pill.bottom).toBeLessThanOrEqual(params.y + 1);
        expect(pill.bottom).toBeLessThanOrEqual(optics.y + 1);
      }
      for (const tab of ['control', 'optics']) {
        const hit = await page.locator(`.tab[data-tab="${tab}"]`).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return top?.closest?.('.tab')?.dataset?.tab || top?.id || '';
        });
        expect(hit).toBe(tab);
      }
      await page.screenshot({ path: path.join(shots, `n1-${width}x${height}.png`) });
      await page.close();
    }, 30000);

    it(`N2 ${width}x${height}: the comms menu uses the viewport instead of a 72px slot`, async () => {
      const page = await openAt(width, height);
      await page.click('#missionCommOpen');
      await page.waitForSelector('#flightCommMenu:not([hidden])');
      const fit = await page.evaluate(() => {
        const menu = document.getElementById('flightCommMenu');
        const zoom = document.querySelector('.leaflet-control-zoom');
        const menuBox = menu.getBoundingClientRect();
        const zoomBox = zoom?.getBoundingClientRect();
        const coversZoom = !!(zoomBox && zoomBox.width > 8
          && menuBox.left < zoomBox.right - 1
          && menuBox.right > zoomBox.left + 1
          && menuBox.top < zoomBox.bottom - 1
          && menuBox.bottom > zoomBox.top + 1);
        return {
          client: menu.clientHeight,
          scroll: menu.scrollHeight,
          top: menuBox.top,
          bottom: menuBox.bottom,
          vh: window.innerHeight,
          coversZoom,
        };
      });
      expect(fit.top).toBeGreaterThanOrEqual(-1);
      expect(fit.bottom).toBeLessThanOrEqual(fit.vh + 1);
      expect(fit.coversZoom).toBe(false);
      expect(fit.client).toBeGreaterThan(72);
      if (width <= 480) {
        expect(fit.client).toBeGreaterThanOrEqual(Math.min(fit.scroll, fit.vh - 24) - 8);
      } else {
        expect(fit.scroll - fit.client).toBeLessThan(8);
      }
      await page.screenshot({ path: path.join(shots, `n2-${width}x${height}.png`) });
      await page.close();
    }, 30000);

    it(`N3 ${width}x${height}: optics tiles stay inside the screen`, async () => {
      const page = await openAt(width, height);
      await page.click('.tab[data-tab="optics"]');
      await page.waitForSelector('#optics.panel.visible #debriefCamGrid');
      const tiles = await page.evaluate(() => {
        const grid = document.getElementById('debriefCamGrid');
        const nodes = [...grid.querySelectorAll('.debrief-cam-tile')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        });
        const gridBox = grid.getBoundingClientRect();
        return {
          count: nodes.length,
          gridW: gridBox.width,
          boxes: nodes.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
          }),
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      });
      expect(tiles.count).toBeGreaterThan(1);
      for (const tile of tiles.boxes) {
        expect(tile.right).toBeLessThanOrEqual(tiles.vw + 1);
        expect(tile.w).toBeGreaterThan(40);
        expect(tile.h).toBeGreaterThan(40);
      }
      if (width <= 480) {
        for (const tile of tiles.boxes) expect(tile.w).toBeGreaterThan(tiles.gridW * 0.8);
        const ys = tiles.boxes.map((tile) => tile.y).sort((a, b) => a - b);
        expect(ys[1] - ys[0]).toBeGreaterThan(40);
      }
      await page.screenshot({ path: path.join(shots, `n3-${width}x${height}.png`), fullPage: width <= 480 });
      await page.close();
    }, 30000);
  }

  it('N4 360x740: the header is compact', async () => {
    const page = await openAt(360, 740);
    const head = await page.evaluate(() => {
      const chrome = document.querySelector('.app-chrome').getBoundingClientRect();
      const pill = document.getElementById('connectWidget').getBoundingClientRect();
      const ops = document.querySelector('.mission-ops-chrome')?.getBoundingClientRect();
      const top = Math.min(pill.top, chrome.top);
      const bottom = Math.max(chrome.bottom, ops?.bottom || chrome.bottom);
      return { stack: bottom - top, chrome: chrome.height, pill: pill.height, ops: ops?.height || 0 };
    });
    expect(head.stack).toBeLessThan(200);
    expect(head.chrome).toBeLessThan(140);
    await page.screenshot({ path: path.join(shots, 'n4-360x740.png') });
    await page.close();
  }, 30000);

  it('N4 1024x640: the parameters header is one row', async () => {
    const page = await openAt(1024, 640);
    await page.click('.tab[data-tab="control"]');
    await page.waitForSelector('#control.panel.visible .param-toolbar');
    const row = await page.evaluate(() => {
      const bar = document.querySelector('#control .param-toolbar');
      const segs = [...bar.querySelectorAll('.param-tool-seg')].map((el) => el.getBoundingClientRect());
      const box = bar.getBoundingClientRect();
      return {
        h: box.height,
        tops: segs.map((seg) => Math.round(seg.top)),
      };
    });
    expect(row.h).toBeLessThanOrEqual(44);
    const overlapRow = await page.evaluate(() => {
      const segs = [...document.querySelectorAll('#control .param-tool-seg')].map((el) => el.getBoundingClientRect());
      const minBottom = Math.min(...segs.map((seg) => seg.bottom));
      const maxTop = Math.max(...segs.map((seg) => seg.top));
      return minBottom > maxTop;
    });
    expect(overlapRow).toBe(true);
    const chrome = await page.evaluate(() => {
      const bar = document.querySelector('.app-chrome');
      const tabs = bar.querySelector('.tabs').getBoundingClientRect();
      const tools = bar.querySelector('.app-chrome-tools').getBoundingClientRect();
      const box = bar.getBoundingClientRect();
      return {
        h: box.height,
        wrap: getComputedStyle(bar).flexWrap,
        sameRow: tabs.top < tools.bottom - 4 && tools.top < tabs.bottom - 4,
      };
    });
    expect(chrome.wrap).toBe('nowrap');
    expect(chrome.h).toBeLessThanOrEqual(40);
    expect(chrome.sameRow).toBe(true);
    await page.screenshot({ path: path.join(shots, 'n4-1024x640-params.png') });
    await page.close();
  }, 30000);

  it('below 600px ASK sits above the gimbal camera button', async () => {
    const page = await openAt(360, 740);
    await page.click('.tab[data-tab="optics"]');
    await page.waitForSelector('#optics.panel.visible #opticsGimbalBtn');
    const ask = await box(page, '#assistToggleBtn');
    const gimbal = await box(page, '#opticsGimbalBtn');
    expect(overlaps(ask, gimbal), 'ASK covers גימבל').toBe(false);
    expect(ask.bottom).toBeLessThanOrEqual(gimbal.y + 1);
    await page.close();
  }, 30000);

  it('comms menu says התנתקו and offers התחברו when the link did not come up', async () => {
    const comm = summarizeCommLinks({
      modemPresent: true,
      uplinkControl: true,
      uplinks: {
        wifi: { enabled: true, up: true, signal_dbm: -55 },
        cellular: { enabled: true, up: false },
      },
      companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר' },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('**/api/**', (route) => {
      const url = route.request().url();
      if (url.includes('/api/links')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            links: {
              radio: 'disconnected',
              cellular: 'disconnected',
              radioLabelHe: 'RF',
              radioStatusHe: 'מנותק',
              cellularStatusHe: 'לא עלה',
              modemPresent: true,
              modem: { present: true, reasonHe: 'מודם זוהה' },
              canSelectActive: false,
              active: null,
              companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר' },
              comm,
              video: { available: false, reasonHe: 'אין שידור' },
              pillLabelHe: comm.pillLabelHe,
              pillDot: comm.pillDot,
              endpoint: { host: '0.0.0.0', port: 14560 },
            },
          }),
        });
      }
      return route.continue();
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('#missionCommOpen');
    await page.waitForSelector('#flightCommMenu:not([hidden]) #cellularConnectBtn');
    const actions = await page.evaluate(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        const bg = getComputedStyle(el).backgroundColor;
        return { text: el.textContent.trim(), action: el.dataset.action, bg };
      };
      const labels = [...document.querySelectorAll('#flightCommMenu button')].map((el) => el.textContent.trim());
      return {
        cell: read('cellularConnectBtn'),
        home: read('companionLinkBtn'),
        menu: document.getElementById('flightCommAction').textContent.trim(),
        labels,
      };
    });
    expect(actions.cell).toMatchObject({ text: 'התחברו', action: 'connect' });
    expect(actions.cell.bg).not.toBe('rgb(220, 38, 38)');
    expect(actions.home).toMatchObject({ text: 'התנתקו', action: 'disconnect', bg: 'rgb(220, 38, 38)' });
    expect(actions.menu).toBe('התחברו');
    expect(actions.labels).not.toContain('התנתק');
    expect(actions.labels).toContain('התנתקו');
    await page.close();
  }, 30000);

  for (const [width, height] of [
    [360, 640],
    [360, 740],
    [599, 640],
    [800, 800],
    [1024, 576],
    [1024, 640],
    [1280, 720],
    [1440, 900],
  ]) {
    it(`${width}x${height}: every tab button is the thing under the pointer`, async () => {
      const page = await openAt(width, height);
      const tabs = ['terrain', 'pulse', 'control', 'optics', 'recordings'];
      for (const current of tabs) {
        await page.click(`.tab[data-tab="${current}"]`);
        await page.waitForSelector(`#${current}.panel.visible`);
        for (const tab of tabs) {
          const hit = await page.locator(`.tab[data-tab="${tab}"]`).evaluate((el) => {
            const r = el.getBoundingClientRect();
            const chrome = document.querySelector('.app-chrome').getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              hit: top?.closest?.('.tab')?.dataset?.tab || '',
              inside: r.top >= chrome.top - 1 && r.bottom <= chrome.bottom + 1,
            };
          });
          expect(hit.inside, `${current} keeps ${tab} inside the header`).toBe(true);
          expect(hit.hit, `${current} click target for ${tab}`).toBe(tab);
        }
      }
      if (width < 480) {
        const widget = await box(page, '#connectWidget');
        const first = await box(page, '.tab[data-tab="terrain"]');
        expect(widget.position).not.toBe('fixed');
        expect(widget.bottom).toBeLessThanOrEqual(first.y + 1);
      }
      await page.screenshot({ path: path.join(shots, `tabs-hit-${width}x${height}.png`) });
      await page.close();
    }, 30000);
  }

  for (const width of [800, 900, 1024]) {
    it(`parameters ${width}: the connection pill leaves AIRVIX and settings clickable`, async () => {
      const page = await openAt(width, 800);
      await page.click('.tab[data-tab="control"]');
      await page.waitForSelector('#control.panel.visible');
      const pill = await box(page, '#connectWidget');
      const brand = await box(page, '.app-chrome-brand');
      const gear = await box(page, '#globalSettingsBtn');
      expect(overlaps(pill, brand), 'pill covers AIRVIX').toBe(false);
      expect(overlaps(pill, gear), 'pill covers settings').toBe(false);
      await page.click('#globalSettingsBtn');
      await page.waitForSelector('#globalSettingsModal:not([hidden])');
      expect(await page.locator('#globalSettingsModal').isVisible()).toBe(true);
      await page.screenshot({ path: path.join(shots, `pill-slot-${width}.png`) });
      await page.close();
    }, 30000);
  }

  it('header position and height match across tabs', async () => {
    const tabs = ['terrain', 'pulse', 'control', 'optics', 'recordings'];
    for (const [width, height] of [[360, 800], [599, 800], [800, 800], [1024, 800], [1280, 800]]) {
      const page = await openAt(width, height);
      const measures = [];
      for (const tab of tabs) {
        await page.click(`.tab[data-tab="${tab}"]`);
        await page.waitForSelector(`#${tab}.panel.visible`);
        const box = await page.evaluate(() => {
          const r = document.querySelector('.app-chrome').getBoundingClientRect();
          return { top: Math.round(r.top), height: Math.round(r.height) };
        });
        measures.push({ tab, ...box });
      }
      const first = measures[0];
      for (const measure of measures) {
        expect(measure.top, `${width} ${measure.tab} top`).toBe(first.top);
        expect(measure.height, `${width} ${measure.tab} height`).toBe(first.height);
      }
      await page.screenshot({ path: path.join(shots, `header-${width}.png`) });
      await page.close();
    }
  }, 60000);
});
