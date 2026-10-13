/**
 * The phone horizon stays near square, and the in-horizon tile words
 * never break in the middle.
 */
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './test-server.mjs';

const SIZES = [[360, 640], [360, 800], [1024, 470], [1366, 630], [1536, 730]];

const AWARENESS = {
  ok: true,
  level: 2,
  estimate: {
    detected: true,
    offset_px: 12,
    offset_m: 1.4,
    heading_error_deg: 3,
    confidence: { offset: 0.82, heading: 0.64, along: 0.5 },
  },
  hazards: [{ kind: 'person', label_he: 'אדם', confidence: 0.91 }],
  adviceHe: 'יש אדם על המסלול. מומלץ ללכת סביב.',
  vision: { state: 'waiting', labelHe: 'ממתין', manualArm: false, buttonReady: true, hasLand: true },
};

describe('horizon square and whole tile words', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('keeps a near-square horizon and does not break a tile word', async () => {
    const started = await startTestServer({
      env: (port) => ({
        SQLITE_PATH: path.join(os.tmpdir(), `airvix-horizon-square-${port}.sqlite`),
        COMPANION_MODE: 'mock',
        JETSON_COMPANION_BASE_URL: '',
      }),
      stdio: 'ignore',
    });
    proc = started.child;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1024, height: 470 } });
    await page.route('**/api/runway/awareness**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AWARENESS),
    }));
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.locator('.tab[data-tab="terrain"]').click();
    await page.waitForFunction(() => {
      const tiles = document.getElementById('runwayAwarenessTiles');
      return tiles && tiles.hidden === false && tiles.innerText.includes('סכנה');
    });

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await page.waitForFunction(() => {
        const stage = document.getElementById('pfdHorizonStage');
        const keys = [...document.querySelectorAll('#pfdHorizonStage .runway-awareness-tile .runway-awareness-k')];
        return stage && stage.clientWidth > 40 && stage.clientHeight > 40 && keys.length >= 3 && keys.every((el) => el.clientWidth > 0);
      });
      const report = await page.evaluate(() => {
        function textBreaks(el) {
          const hits = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const text = node.textContent.trim();
            if (text && !/\s/.test(text)) {
              const range = document.createRange();
              range.selectNodeContents(node);
              const count = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5).length;
              if (count > 1) hits.push({ text, count });
            }
            node = walker.nextNode();
          }
          return hits;
        }
        const stage = document.getElementById('pfdHorizonStage').getBoundingClientRect();
        const nodes = [...document.querySelectorAll('#pfdHorizonStage .runway-awareness-tile .runway-awareness-k, #pfdHorizonStage .runway-awareness-tile .runway-awareness-v, #pfdHorizonStage .runway-awareness-tile .runway-awareness-c')];
        const midWord = [];
        const overflow = [];
        for (const el of nodes) {
          if (el.closest('[hidden]')) continue;
          midWord.push(...textBreaks(el));
          const text = (el.textContent || '').trim();
          if (!text) continue;
          if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
            overflow.push({ text, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight });
          }
        }
        function hits(a, b) {
          if (!a || !b || a.width < 2 || b.width < 2) return false;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return w > 1 && h > 1;
        }
        const offButtons = [...document.querySelectorAll('button')].filter((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (rect.width < 2 || rect.height < 2) return false;
          if (!el.closest('[data-mission-region="horizon"], [data-mission-region="map"]')) return false;
          if (rect.left < -1 || rect.right > window.innerWidth + 1) return true;
          let node = el.parentElement;
          while (node && node !== document.body) {
            const parent = getComputedStyle(node);
            const scrolls = ['auto', 'scroll'].some((kind) => (
              parent.overflow.includes(kind) || parent.overflowY.includes(kind)
            ));
            if (scrolls) break;
            const clips = ['hidden', 'clip'].some((kind) => (
              parent.overflow.includes(kind) || parent.overflowX.includes(kind) || parent.overflowY.includes(kind)
            ));
            if (clips) {
              const box = node.getBoundingClientRect();
              const seenW = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
              const seenH = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
              if (seenW < rect.width - 2 || seenH < rect.height - 2) return true;
            }
            node = node.parentElement;
          }
          return false;
        }).map((el) => el.id || (el.textContent || '').trim().slice(0, 16));
        const stageEl = document.getElementById('pfdHorizonStage');
        const bar = document.getElementById('runwayVisionBar')?.getBoundingClientRect();
        const quick = document.getElementById('horizonQuick')?.getBoundingClientRect();
        const leftTape = document.querySelector('.pfd-side-tape--left')?.getBoundingClientRect();
        const rightTape = document.querySelector('.pfd-side-tape--right')?.getBoundingClientRect();
        const tileBoxes = [...document.querySelectorAll('#pfdHorizonStage .runway-awareness-tile')].map((el) => el.getBoundingClientRect());
        const arm = document.getElementById('flightArmBtn').getBoundingClientRect();
        const disarm = document.getElementById('flightDisarmBtn').getBoundingClientRect();
        const column = document.querySelector('[data-mission-region="horizon"]')?.getBoundingClientRect();
        const terrain = document.getElementById('terrain');
        return {
          width: Math.round(stage.width),
          height: Math.round(stage.height),
          top: Math.round(stage.top),
          ratio: stage.width / stage.height,
          midWord,
          overflow,
          offButtons,
          labels: [...document.querySelectorAll('#pfdHorizonStage .runway-awareness-k')].map((el) => el.textContent),
          widthMode: stageEl.getAttribute('data-awareness-width'),
          stack: Math.round(document.getElementById('runwayAwarenessStack')?.getBoundingClientRect().width || 0),
          vh: window.innerHeight,
          barH: Math.round(bar?.height || 0),
          barBottom: Math.round(bar?.bottom || 0),
          tilesBottom: Math.round(Math.max(...tileBoxes.map((box) => box.bottom), 0)),
          tilesTop: Math.round(Math.min(...tileBoxes.map((box) => box.top), 0)),
          oneRow: tileBoxes.length >= 3 && Math.max(...tileBoxes.map((box) => box.top)) - Math.min(...tileBoxes.map((box) => box.top)) <= 2,
          tileOnTape: tileBoxes.some((box) => hits(box, leftTape) || hits(box, rightTape)),
          tileOnQuick: tileBoxes.some((box) => hits(box, quick)),
          columnW: Math.round(column?.width || 0),
          offset: (document.getElementById('runwayOffsetValue')?.innerText || '').replace(/\s+/g, ' '),
          heading: (document.getElementById('runwayHeadingValue')?.innerText || '').replace(/\s+/g, ' '),
          arm: {
            w: Math.round(arm.width),
            h: Math.round(arm.height),
            text: document.querySelector('#flightArmBtn .horizon-quick-label')?.textContent || '',
            shown: getComputedStyle(document.querySelector('#flightArmBtn .horizon-quick-label')).display,
          },
          disarm: {
            w: Math.round(disarm.width),
            h: Math.round(disarm.height),
            text: document.querySelector('#flightDisarmBtn .horizon-quick-label')?.textContent || '',
            shown: getComputedStyle(document.querySelector('#flightDisarmBtn .horizon-quick-label')).display,
          },
          gap: Math.round(Math.max(arm.left, disarm.left) - Math.min(arm.right, disarm.right)),
          scroll: terrain ? terrain.scrollTop : 0,
          noteHidden: document.getElementById('horizonNoData')?.hidden === true,
          tilesText: (document.getElementById('runwayAwarenessTiles')?.innerText || '').replace(/\s+/g, ' '),
          offsetTile: Math.round(document.querySelector('[data-awareness-tile="offset"]')?.getBoundingClientRect().width || 0),
          valueLines: (() => {
            const el = document.getElementById('runwayOffsetValue');
            if (!el) return 0;
            const range = document.createRange();
            range.selectNodeContents(el);
            const tops = [...range.getClientRects()]
              .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
              .map((rect) => Math.round(rect.top));
            return new Set(tops).size;
          })(),
          armTitle: document.getElementById('flightArmBtn')?.title || '',
          controls: ['pfdArmedBadge', 'flightArmBtn', 'flightDisarmBtn', 'pfdVoiceFlightBtn'].map((id) => {
            const el = document.getElementById(id);
            const box = el.getBoundingClientRect();
            const shown = !el.hidden && box.width > 2 && box.height > 2 && getComputedStyle(el).display !== 'none';
            return {
              id,
              shown,
              inside: box.left >= stage.left - 1 && box.right <= stage.right + 1
                && box.top >= stage.top - 1 && box.bottom <= stage.bottom + 1,
            };
          }),
          points: {
            center: { x: stage.left + stage.width / 2, y: stage.top + 36 },
            gap: {
              x: (Math.max(arm.left, disarm.left) + Math.min(arm.right, disarm.right)) / 2,
              y: arm.top + arm.height / 2,
            },
            left: (() => {
              const box = document.querySelector('.pfd-side-tape--left').getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
            })(),
            right: (() => {
              const box = document.querySelector('.pfd-side-tape--right').getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
            })(),
          },
        };
      });
      const name = `${width}x${height}`;
      if (width <= 720) {
        expect(report.ratio, `${name} ${report.width}x${report.height}`).toBeGreaterThan(0.9);
        expect(report.ratio, `${name} ${report.width}x${report.height}`).toBeLessThan(1.15);
        if (height <= 700) {
          expect(report.height, name).toBeGreaterThan(154);
          const remain = report.vh - report.top - report.barH;
          expect(Math.abs(report.height - remain), `${name} square ${report.height} vs ${remain}`).toBeLessThanOrEqual(16);
        } else {
          expect(report.width, name).toBeGreaterThanOrEqual(240);
          expect(report.height, name).toBeGreaterThanOrEqual(240);
        }
      } else {
        expect(report.ratio, `${name} ${report.width}x${report.height}`).toBeGreaterThan(0.8);
        expect(report.ratio, `${name} ${report.width}x${report.height}`).toBeLessThanOrEqual(1.65);
      }
      expect(report.midWord, name).toEqual([]);
      expect(report.overflow, `${name} stage ${report.width}x${report.height} stack ${report.stack} ${report.widthMode} ${report.offset}`).toEqual([]);
      expect(report.offButtons, name).toEqual([]);
      expect(report.labels, name).toEqual(expect.arrayContaining(['כיוון', 'סכנה']));
      expect(report.labels, name).not.toContain('צד');
      expect(report.labels.some((label) => label === 'היסט' || label === 'סטייה'), name).toBe(true);
      expect(report.barBottom, `${name} landing row`).toBeLessThanOrEqual(report.vh + 1);
      expect(report.tilesBottom, `${name} tiles`).toBeLessThanOrEqual(report.vh + 1);
      expect(report.tilesTop, `${name} tiles`).toBeGreaterThanOrEqual(-1);
      expect(report.scroll, name).toBe(0);
      expect(report.noteHidden, `${name} ${report.tilesText}`).toBe(true);
      expect(report.armTitle, name).toBe('חימוש — אין חיבור לבקר הטיסה');
      expect(report.controls.filter((row) => row.shown && !row.inside).map((row) => row.id), name).toEqual([]);
      if (report.height < 280) {
        expect(report.tilesText, name).not.toMatch(/%/);
        expect(report.valueLines, name).toBe(1);
        expect(report.offsetTile, name).toBeGreaterThanOrEqual(40);
      }
      expect(report.tileOnTape, name).toBe(false);
      expect(report.tileOnQuick, name).toBe(false);
      expect(report.oneRow, `${name} ${report.widthMode}`).toBe(true);
      expect(report.offset, name).toMatch(/מ׳/);
      expect(report.offset, name).not.toMatch(/צד/);
      if (report.height < 280) {
        expect(report.offset, name).toMatch(/[→←]/);
        expect(report.offset, name).not.toMatch(/ימינה|שמאלה/);
        expect(report.heading, name).toMatch(/[→←]/);
        expect(report.heading, name).not.toMatch(/ימינה|שמאלה/);
      }
      expect(report.arm.text, name).toBe('חימוש');
      expect(report.disarm.text, name).toBe('ניטרול');
      expect(report.arm.shown, name).not.toBe('none');
      expect(report.disarm.shown, name).not.toBe('none');
      expect(report.arm.w, name).toBeGreaterThanOrEqual(40);
      expect(report.arm.h, name).toBeGreaterThanOrEqual(40);
      expect(report.disarm.w, name).toBeGreaterThanOrEqual(40);
      expect(report.disarm.h, name).toBeGreaterThanOrEqual(40);
      expect(report.gap, name).toBeGreaterThanOrEqual(8);
      for (const [spot, point] of Object.entries(report.points)) {
        await page.evaluate(() => {
          document.getElementById('horizonCameraMenu').hidden = true;
          const column = document.getElementById('flightColumnMenu');
          if (column) column.hidden = true;
        });
        await page.mouse.click(point.x, point.y, { button: 'right' });
        const opened = await page.locator('#horizonCameraMenu').evaluate((el) => el.hidden === false);
        expect(opened, `${name} ${spot}`).toBe(true);
      }
    }
  }, 90000);
});
