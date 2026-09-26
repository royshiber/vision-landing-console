import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/flight-layout/after';
const PORT = '4048';
const BASE = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  ['1920x1080', 1920, 1080],
  ['1440x900', 1440, 900],
  ['1366x768', 1366, 768],
  ['360x800', 360, 800],
];

function interiorsIntersect(a, b, slack = 1) {
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

describe('Flight screen overlap', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-overlap-${PORT}.sqlite` },
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

  async function audit(page, { connectOpen = false } = {}) {
    return page.evaluate((open) => {
      const visibleBox = (el) => {
        const r = el.getBoundingClientRect();
        let left = r.left;
        let top = r.top;
        let right = r.right;
        let bottom = r.bottom;
        let node = el.parentElement;
        while (node && node !== document.documentElement) {
          const cs = getComputedStyle(node);
          const ox = `${cs.overflowX} ${cs.overflowY} ${cs.overflow}`;
          if (/(auto|hidden|scroll|clip)/.test(ox)) {
            const b = node.getBoundingClientRect();
            left = Math.max(left, b.left);
            top = Math.max(top, b.top);
            right = Math.min(right, b.right);
            bottom = Math.min(bottom, b.bottom);
          }
          node = node.parentElement;
        }
        return {
          left, top, right, bottom,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        };
      };
      const nodes = [];
      const seen = new Set();
      const selectors = [
        '#terrain button',
        '#terrain input',
        '#terrain textarea',
        '#terrain select',
        '#terrain [role="button"]',
        '.mission-link-chip',
        '.leaflet-control',
        '.app-chrome .tab',
        '#connectToggleBtn',
        '#connectPanel',
        '#connectPanel button',
        '[data-mission-region]',
        '.mission-ops-chrome',
        '.app-chrome',
        '.pfd-top-bar',
        '.pfd-bottom-bar',
        '.terrain-map-overlay-toolbar',
        '.mission-data-tile',
        '#pfdHorizonStage',
        '#horizonCanvas',
        '#horizonCameraBg',
        '#horizonVideoEl',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.hidden) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const box = visibleBox(el);
          if (box.width < 2 || box.height < 2) continue;
          const name = el.id ? `#${el.id}` : (el.getAttribute('data-mission-region') ? `region:${el.getAttribute('data-mission-region')}` : (el.className?.toString?.().split(' ').slice(0, 2).join('.') || el.tagName));
          nodes.push({ name, box, el });
        }
      }
      const allow = (a, b) => {
        const ids = new Set([a.el.id, b.el.id]);
        const connectFloat = (el) => el.id === 'connectToggleBtn'
          || el.id === 'connectPanel'
          || !!el.closest?.('#connectPanel, .connect-widget');
        if (connectFloat(a.el) || connectFloat(b.el)) return true;
        if ((ids.has('connectToggleBtn') || a.el.classList.contains('connect-widget') || b.el.classList.contains('connect-widget')) && (a.el.classList.contains('app-chrome') || b.el.classList.contains('app-chrome'))) return true;
        if (ids.has('horizonCanvas') && (ids.has('horizonCameraBg') || ids.has('horizonVideoEl') || ids.has('pfdHorizonStage'))) return true;
        if (a.el.id === 'horizonCameraNote' || b.el.id === 'horizonCameraNote') return true;
        return false;
      };
      const hits = [];
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          if (allow(a, b)) continue;
          if (!open && (a.el.id === 'connectPanel' || b.el.id === 'connectPanel')) continue;
          const iw = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
          const ih = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
          if (iw > 2 && ih > 2) hits.push(`${a.name} ∩ ${b.name} ${Math.round(iw)}x${Math.round(ih)}`);
        }
      }
      const clips = [];
      for (const el of document.querySelectorAll('#terrain button, .mission-link-chip, #pfdModeVal, .mission-data-label, .mission-data-value, .app-chrome .tab')) {
        if (el.hidden || getComputedStyle(el).display === 'none') continue;
        if (el.clientWidth < 12 || el.clientHeight < 12) continue;
        const border = el.getBoundingClientRect();
        const vis = visibleBox(el);
        if (vis.width < border.width - 2 || vis.height < border.height - 2) continue;
        if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
          clips.push(`${el.id || el.className.toString().slice(0, 32)}:${(el.textContent || '').trim().slice(0, 18)}`);
        }
      }
      return { hits, clips };
    }, connectOpen);
  }

  for (const [name, width, height] of VIEWPORTS) {
    it(`keeps flight controls from overlapping at ${name}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-mission-region="map"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shotDir, `flight-${name}.png`) });
      const closed = await audit(page);
      expect(closed.hits, closed.hits.join('\n')).toEqual([]);
      expect(closed.clips, closed.clips.join('\n')).toEqual([]);
      await page.click('#connectToggleBtn');
      await page.waitForSelector('#connectPanel:not([hidden])');
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(shotDir, `flight-${name}-connect.png`) });
      const opened = await audit(page, { connectOpen: true });
      const stray = opened.hits;
      expect(stray, stray.join('\n')).toEqual([]);
      await page.close();
    }, 30000);
  }
});
