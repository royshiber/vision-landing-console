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
        return {
          width: Math.round(stage.width),
          height: Math.round(stage.height),
          ratio: stage.width / stage.height,
          midWord,
          overflow,
          offButtons,
          labels: [...document.querySelectorAll('#pfdHorizonStage .runway-awareness-k')].map((el) => el.textContent),
          widthMode: document.getElementById('pfdHorizonStage').getAttribute('data-awareness-width'),
          stack: Math.round(document.getElementById('runwayAwarenessStack')?.getBoundingClientRect().width || 0),
        };
      });
      const name = `${width}x${height}`;
      expect(report.ratio, `${name} ${report.width}x${report.height}`).toBeGreaterThan(0.8);
      expect(report.ratio, `${name} ${report.width}x${report.height}`).toBeLessThanOrEqual(1.25);
      expect(report.midWord, name).toEqual([]);
      expect(report.overflow, `${name} stage ${report.width}x${report.height} stack ${report.stack} ${report.widthMode}`).toEqual([]);
      expect(report.offButtons, name).toEqual([]);
      expect(report.labels, name).toEqual(expect.arrayContaining(['כיוון', 'סכנה']));
    }
  }, 40000);
});
