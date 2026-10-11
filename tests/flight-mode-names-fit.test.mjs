import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { ARDUPILOT_PLANE_MODES } from '../lib/arduplane-flight-modes.mjs';
import { qaShotDir } from './shot-dir.mjs';
import { startTestServer } from './test-server.mjs';

const modes = Object.entries(ARDUPILOT_PLANE_MODES).map(([id, name]) => ({ id: Number(id), name }));
const SHORT = {
  LOITER_ALT_QLAND: 'LQLAND',
  AVOID_ADSB: 'AVOID',
  INITIALISING: 'INIT',
  QAUTOTUNE: 'QATUNE',
};
const viewports = [
  { name: '360x640', width: 360, height: 640 },
  { name: '360x740', width: 360, height: 740 },
  { name: '599x640', width: 599, height: 640 },
  { name: '721x720', width: 721, height: 720 },
  { name: '800x800', width: 800, height: 800 },
  { name: '900x800', width: 900, height: 800 },
  { name: '980x800', width: 980, height: 800 },
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1024x640', width: 1024, height: 640 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
function expectedTracks(width, count = 7) {
  if (count >= 8) return 4;
  if (width >= 1180) return 7;
  if (width >= 721 && width < 800) return 3;
  return 4;
}

function inside(inner, outer) {
  return inner.left >= outer.left - 1
    && inner.right <= outer.right + 1
    && inner.top >= outer.top - 1
    && inner.bottom <= outer.bottom + 1;
}

describe('ArduPlane mode names fit on one line', () => {
  let server = null;
  let browser = null;
  let page = null;

  beforeAll(async () => {
    server = await startTestServer({ env: () => ({ CURSOR_API_KEY: '' }) });
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#hudFlightMode');
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  });

  afterAll(async () => {
    await browser?.close();
    server?.child.kill('SIGTERM');
  });

  it('keeps a fixed mode column at every gate size', async () => {
    const shots = qaShotDir('mode-column');
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const states = [{ id: null, name: '' }, ...modes];
      const samples = [];
      for (const state of states) {
        const fit = await page.evaluate((modeId) => {
          const plane = { mavType: 1, vehicleType: 'Fixed Wing', connected: modeId != null };
          const full = modeId == null ? '—' : vlcFlightModeText(modeId, plane, true);
          const label = vlcFlightModeHudLabel(full);
          if (modeId == null && typeof flightTelemetryHold !== 'undefined' && flightTelemetryHold) {
            flightTelemetryHold.clear('top-mode');
            document.querySelectorAll('[data-mission-data-slot]').forEach((item) => {
              flightTelemetryHold.clear(`mission:${item.dataset.missionDataSlot}:mavlink.flightMode`);
            });
          }
          applyMissionDataGrid({
            mavlink: {
              connected: modeId != null,
              flightMode: modeId,
              mavType: 1,
              vehicleType: 'Fixed Wing',
              heartbeatCount: modeId == null ? 0 : 1,
              altitude: 123.4,
              airspeed: 12.4,
            },
            vision: { confidence: 0.86 },
          });
          const set = (id, text) => {
            const node = document.getElementById(id);
            if (node) node.textContent = text;
          };
          set('hudAltitude', '1234.5');
          set('hudAirspeed', '12.4');
          set('liveGpsVisionDelta', '12.3');
          set('liveConfidenceText', '86');
          set('pfdBattVal', '16.8');
          const el = document.getElementById('hudFlightMode');
          const tile = el.closest('.mission-data-tile');
          const grid = document.getElementById('missionDataGrid');
          const cs = getComputedStyle(el);
          const line = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize);
          const er = el.getBoundingClientRect();
          const tr = tile.getBoundingClientRect();
          const gr = grid.getBoundingClientRect();
          const doc = document.documentElement;
          const boxOf = (node) => {
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return {
              text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
              sw: node.scrollWidth,
              cw: node.clientWidth,
              sh: node.scrollHeight,
              ch: node.clientHeight,
              box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            };
          };
          const tiles = [...grid.querySelectorAll('.mission-data-tile')].map((node) => {
            const tr = node.getBoundingClientRect();
            const pair = node.querySelector('.mission-data-pair');
            const value = node.querySelector('.mission-data-value');
            return {
              label: boxOf(node.querySelector('.mission-data-label')),
              pair: boxOf(pair),
              value: pair ? null : boxOf(value),
              tile: { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom },
            };
          });
          const pairs = [...grid.querySelectorAll('.mission-data-pair')].map((pair) => {
            const value = pair.querySelector('.mission-data-value');
            const unit = pair.querySelector('.mission-data-unit');
            const vr = value?.getBoundingClientRect();
            const ur = unit?.getBoundingClientRect();
            const pcs = getComputedStyle(pair);
            const pline = Number.parseFloat(pcs.lineHeight) || line;
            return {
              unit: unit?.textContent || '',
              sameLine: !unit || !unit.textContent.trim() || Math.abs(vr.top - ur.top) <= 1,
              sh: pair.scrollHeight,
              ch: pair.clientHeight,
              line: pline,
              sw: pair.scrollWidth,
              cw: pair.clientWidth,
            };
          });
          const neighbours = [...grid.querySelectorAll('.mission-data-tile')]
            .filter((node) => node !== tile)
            .map((node) => Math.round(node.getBoundingClientRect().width * 100) / 100);
          const confidence = grid.querySelector('.mission-data-confidence');
          const cr = confidence?.getBoundingClientRect();
          return {
            text: el.textContent,
            title: el.title,
            tileTitle: tile.title,
            white: cs.whiteSpace,
            wrap: cs.overflowWrap,
            word: cs.wordBreak,
            font: Number.parseFloat(cs.fontSize),
            sw: el.scrollWidth,
            cw: el.clientWidth,
            sh: el.scrollHeight,
            line,
            textBox: { left: er.left, right: er.right, top: er.top, bottom: er.bottom },
            tileBox: { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom },
            gridBox: { left: gr.left, right: gr.right, top: gr.top, bottom: gr.bottom },
            modeW: Math.round(tr.width * 100) / 100,
            neighbours,
            docScroll: doc.scrollWidth - doc.clientWidth,
            gridScroll: grid.scrollWidth - grid.clientWidth,
            pairs,
            tiles,
            confidence: confidence ? {
              sw: confidence.scrollWidth,
              cw: confidence.clientWidth,
              box: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom },
            } : null,
            cols: getComputedStyle(grid).gridTemplateColumns,
          };
        }, state.id);
        const expectedText = SHORT[state.name] || state.name || '—';
        const expectedTitle = SHORT[state.name] ? state.name : '';
        const where = `${vp.name} ${state.name || 'empty'}`;
        expect(fit.text, where).toBe(expectedText);
        expect(fit.title, where).toBe(expectedTitle);
        expect(fit.tileTitle, where).toBe(expectedTitle);
        expect(fit.white, where).toBe('normal');
        expect(fit.wrap, where).toBe('normal');
        expect(fit.word, where).toBe('keep-all');
        expect(fit.font, where).toBeGreaterThanOrEqual(11);
        expect(fit.sw, where).toBeLessThanOrEqual(fit.cw + 1);
        expect(fit.sh, where).toBeLessThanOrEqual(fit.line + 1);
        expect(inside(fit.textBox, fit.tileBox), where).toBe(true);
        expect(inside(fit.tileBox, fit.gridBox), where).toBe(true);
        expect(fit.docScroll, where).toBeLessThanOrEqual(1);
        expect(fit.gridScroll, where).toBeLessThanOrEqual(1);
        const tracks = fit.cols.split(' ').filter(Boolean);
        expect(tracks, where).toHaveLength(expectedTracks(vp.width));
        if (vp.width >= 1180) {
          expect(tracks[0], where).toBe('62px');
        } else {
          const widths = tracks.map((track) => Number.parseFloat(track));
          expect(Math.max(...widths) - Math.min(...widths), where).toBeLessThanOrEqual(1);
        }
        for (const pair of fit.pairs) {
          expect(pair.sameLine, `${where} ${pair.unit}`).toBe(true);
          expect(pair.sh, `${where} ${pair.unit}`).toBeLessThanOrEqual(pair.line + 1);
          expect(pair.sh, `${where} ${pair.unit}`).toBeLessThanOrEqual(pair.ch + 1);
          expect(pair.sw, `${where} ${pair.unit}`).toBeLessThanOrEqual(pair.cw + 1);
        }
        for (const tile of fit.tiles) {
          const bits = [tile.label, tile.pair, tile.value].filter(Boolean);
          for (const bit of bits) {
            const name = `${where} ${bit.text}`;
            expect(bit.sw, name).toBeLessThanOrEqual(bit.cw + 1);
            expect(bit.sh, name).toBeLessThanOrEqual(bit.ch + 1);
            expect(inside(bit.box, tile.tile), name).toBe(true);
          }
        }
        if (fit.confidence) {
          expect(fit.confidence.sw, where).toBeLessThanOrEqual(fit.confidence.cw + 1);
          expect(inside(fit.confidence.box, fit.gridBox), where).toBe(true);
        }
        samples.push({ modeW: fit.modeW, neighbours: fit.neighbours });
        if ((vp.name === '721x720' || vp.name === '800x800') && state.name === 'QSTABILIZE') {
          const file = path.join(shots, `${vp.name}.png`);
          await page.locator('#missionDataGrid').screenshot({ path: file });
        }
        if (vp.name === '1024x576' && ['', 'RTL', 'LOITER_ALT_QLAND', 'AVOID_ADSB', 'INITIALISING', 'QAUTOTUNE'].includes(state.name)) {
          const file = path.join(shots, `${state.name || 'empty'}.png`);
          await page.locator('#missionDataGrid').screenshot({ path: file });
        }
        if (vp.name === '1024x576' && expectedTitle) {
          const info = await page.evaluate(() => {
            const tile = document.getElementById('hudFlightMode').closest('.mission-data-tile');
            tile.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 40,
              clientY: 40,
            }));
            const node = document.getElementById('missionDataTileInfo');
            const menu = document.getElementById('missionDataTileMenu');
            return {
              text: node?.textContent || '',
              hidden: node?.hidden === true,
              open: menu ? !menu.classList.contains('hidden') : false,
            };
          });
          expect(info.open, where).toBe(true);
          expect(info.hidden, where).toBe(false);
          expect(info.text, where).toBe(state.name);
        }
        if (vp.name === '1024x576' && state.name === 'QAUTOTUNE') {
          const held = await page.evaluate(() => new Promise((resolve) => {
            const tile = document.getElementById('hudFlightMode').closest('.mission-data-tile');
            document.getElementById('missionDataTileMenu')?.classList.add('hidden');
            const touch = new Touch({
              identifier: 1,
              target: tile,
              clientX: 24,
              clientY: 24,
              radiusX: 1,
              radiusY: 1,
              force: 1,
            });
            tile.dispatchEvent(new TouchEvent('touchstart', {
              bubbles: true,
              cancelable: true,
              touches: [touch],
              targetTouches: [touch],
              changedTouches: [touch],
            }));
            setTimeout(() => {
              const menu = document.getElementById('missionDataTileMenu');
              const node = document.getElementById('missionDataTileInfo');
              resolve({
                open: menu ? !menu.classList.contains('hidden') : false,
                text: node?.textContent || '',
              });
            }, 600);
          }));
          expect(held.open, where).toBe(true);
          expect(held.text, where).toBe('QAUTOTUNE');
        }
      }
      const base = samples[0];
      for (const sample of samples) {
        expect(Math.abs(sample.modeW - base.modeW), vp.name).toBeLessThanOrEqual(1);
        expect(sample.neighbours.length, vp.name).toBe(base.neighbours.length);
        sample.neighbours.forEach((width, index) => {
          expect(Math.abs(width - base.neighbours[index]), `${vp.name} neighbour ${index}`).toBeLessThanOrEqual(1);
        });
      }
    }
  }, 180000);

  it('fits worst-case values for 6, 7, and 8 tiles and keeps messages in the column', async () => {
    const shots = qaShotDir('mode-column');
    const qstab = modes.find((mode) => mode.name === 'QSTABILIZE');
    const valueSets = [
      { alt: '-9999.9', delta: '-1234.5', speed: '188.8', extra: '9999.9' },
      { alt: '9999.9', delta: '-1234.5', speed: '188.8', extra: '9999.9' },
    ];
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      for (const count of [6, 7, 8]) {
        for (const values of valueSets) {
          const fit = await page.evaluate(async ({ count: tileCount, values: painted, modeId }) => {
            await document.fonts.ready;
            const grid = document.getElementById('missionDataGrid');
            grid.querySelector('[data-mission-data-slot="6"]')?.remove();
            grid.querySelectorAll('.mission-data-tile').forEach((tile) => { tile.hidden = false; });
            applyMissionDataGrid({
              mavlink: {
                connected: true,
                flightMode: modeId,
                mavType: 1,
                vehicleType: 'Fixed Wing',
                heartbeatCount: 1,
                altitude: 1,
                airspeed: 1,
              },
              vision: { confidence: 0.86 },
            });
            if (tileCount === 6) {
              const batt = grid.querySelector('[data-mission-data-slot="batt"]');
              if (batt) batt.hidden = true;
            }
            if (tileCount === 8) {
              const tile = document.createElement('div');
              tile.className = 'mission-data-item mission-data-tile';
              tile.dataset.missionDataSlot = '6';
              tile.innerHTML = '<dt class="mission-data-label">מהירות קרקעית</dt><dd class="mission-data-readout" dir="ltr"><span class="mission-data-pair"><strong class="mission-data-value" id="probeExtraValue">9999.9</strong><span class="mission-data-unit">m</span></span></dd>';
              grid.appendChild(tile);
            }
            const set = (id, text) => {
              const node = document.getElementById(id);
              if (node) node.textContent = text;
            };
            set('hudAltitude', painted.alt);
            set('hudAirspeed', painted.speed);
            set('liveGpsVisionDelta', painted.delta);
            set('liveConfidenceText', '86');
            set('pfdBattVal', '16.8');
            set('probeExtraValue', painted.extra);
            const boxOf = (node) => {
              if (!node) return null;
              const r = node.getBoundingClientRect();
              return {
                text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
                sw: node.scrollWidth,
                cw: node.clientWidth,
                sh: node.scrollHeight,
                ch: node.clientHeight,
                box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
              };
            };
            const tiles = [...grid.querySelectorAll('.mission-data-tile')].filter((node) => !node.hidden).map((node) => {
              const tr = node.getBoundingClientRect();
              const pair = node.querySelector('.mission-data-pair');
              const value = node.querySelector('.mission-data-value');
              return {
                label: boxOf(node.querySelector('.mission-data-label')),
                pair: boxOf(pair),
                value: pair ? null : boxOf(value),
                tile: { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom, width: tr.width },
              };
            });
            const col = document.querySelector('[data-mission-region="horizon"]').getBoundingClientRect();
            const msg = document.querySelector('[data-mission-region="messages"]');
            const mr = msg.getBoundingClientRect();
            return {
              tiles,
              cols: getComputedStyle(grid).gridTemplateColumns,
              visible: tiles.length,
              msg: {
                sw: msg.scrollWidth,
                cw: msg.clientWidth,
                box: { left: mr.left, right: mr.right, top: mr.top, bottom: mr.bottom },
              },
              col: { left: col.left, right: col.right, top: col.top, bottom: col.bottom },
            };
          }, { count, values, modeId: qstab.id });
          const where = `${vp.name} tiles=${count} ${values.alt}`;
          expect(fit.visible, where).toBe(count);
          const tracks = fit.cols.split(' ').filter(Boolean);
          expect(tracks, where).toHaveLength(expectedTracks(vp.width, count));
          if (count < 8 && vp.width >= 1180) {
            expect(tracks[0], where).toBe('62px');
          } else {
            const widths = tracks.map((track) => Number.parseFloat(track));
            expect(Math.max(...widths) - Math.min(...widths), where).toBeLessThanOrEqual(1);
          }
          if (count === 7 && vp.width >= 721 && vp.width < 800) {
            const widths = fit.tiles.map((tile) => tile.tile.width);
            const last = widths[widths.length - 1];
            const narrow = Math.min(...widths.slice(0, -1));
            expect(last, where).toBeGreaterThan(narrow * 2);
          }
          for (const tile of fit.tiles) {
            const bits = [tile.label, tile.pair, tile.value].filter(Boolean);
            for (const bit of bits) {
              const name = `${where} ${bit.text}`;
              expect(bit.sw, name).toBeLessThanOrEqual(bit.cw + 1);
              expect(bit.sh, name).toBeLessThanOrEqual(bit.ch + 1);
              expect(inside(bit.box, tile.tile), name).toBe(true);
            }
          }
          expect(inside(fit.msg.box, fit.col), `${where} messages`).toBe(true);
          expect(fit.msg.sw, `${where} messages`).toBeLessThanOrEqual(fit.msg.cw + 1);
          const shot = (vp.name === '721x720' && count === 7)
            || (vp.name === '1024x576' && (count === 7 || count === 8))
            || (vp.name === '1280x720' && count === 7);
          if (shot && values.alt === '-9999.9') {
            const file = path.join(shots, `${vp.name}-${count}.png`);
            await page.locator('[data-mission-region="horizon"]').screenshot({ path: file });
          }
        }
      }
    }
    await page.evaluate(() => {
      const grid = document.getElementById('missionDataGrid');
      grid.querySelector('[data-mission-data-slot="6"]')?.remove();
      grid.querySelectorAll('.mission-data-tile').forEach((tile) => { tile.hidden = false; });
    });
  }, 180000);
});
