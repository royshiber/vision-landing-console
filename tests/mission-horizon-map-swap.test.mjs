import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

describe('Horizon/map size swap — source', () => {
  it('keeps both modes on the wide-then-narrow tracks and redraws after the swap', () => {
    const shared = css.slice(
      css.indexOf('.mission-workspace[data-mission-swap="map-horizon"],'),
      css.indexOf('.mission-workspace[data-mission-swap="map-horizon"] {'),
    );
    expect(shared).toContain('minmax(0, 1fr) minmax(132px, min(20%, var(--mission-ah-col)))');
    expect(css).toMatch(/data-mission-swap="map-horizon"\] \{\s*grid-template-areas: "map horizon talk"/);
    expect(css).toMatch(/data-mission-swap="horizon-map"\] \{\s*grid-template-areas: "horizon map talk"/);
    expect(css).toMatch(/data-mission-swap="horizon-map"\][\s\S]*grid-template-areas:\s*"horizon map"\s*"talk talk"/);
    const apply = sliceFunction(js, 'applyMissionSwap');
    expect(apply).toContain('refreshMissionSwapSurfaces');
    expect(sliceFunction(js, 'refreshMissionSwapSurfaces')).toContain('terrainMap.invalidateSize');
    expect(sliceFunction(js, 'refreshMissionSwapSurfaces')).toContain('resizeHorizonCanvas');
    expect(sliceFunction(js, 'toggleMissionHorizonMapSwap')).not.toContain('swapMissionRegions');
    expect(js).toContain("MISSION_SWAP_KEY = 'visionLandingMissionSwapV1'");
  });
});

describe('Horizon/map size swap — layout', () => {
  const PORT = process.env.VLC_SWAP_PORT || '4028';
  const BASE = `http://127.0.0.1:${PORT}`;
  const shots = '/opt/cursor/artifacts/horizon-map-swap';
  let serverProc = null;
  let browser = null;

  const viewports = [
    { name: '1024x576', width: 1024, height: 576, layout: 'side' },
    { name: '1440x900', width: 1440, height: 900, layout: 'three' },
    { name: '360', width: 360, height: 640, layout: 'stack' },
  ];

  async function waitHealth(maxMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('swap server did not become healthy');
  }

  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, CURSOR_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth();
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    if (serverProc) serverProc.kill('SIGTERM');
  });

  function interiorsIntersect(a, b, slack = 1) {
    if (!a || !b || a.width < 2 || b.width < 2 || a.height < 2 || b.height < 2) return false;
    return a.left < b.right - slack
      && a.right > b.left + slack
      && a.top < b.bottom - slack
      && a.bottom > b.top + slack;
  }

  async function measure(page) {
    return page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        swap: document.querySelector('.mission-workspace')?.dataset.missionSwap || '',
        stored: localStorage.getItem('visionLandingMissionSwapV1'),
        map: box(document.querySelector('[data-mission-region="map"]')),
        horizon: box(document.querySelector('[data-mission-region="horizon"]')),
        talk: box(document.querySelector('[data-mission-region="talk"]')),
        stage: box(document.getElementById('pfdHorizonStage')),
        canvas: box(document.getElementById('horizonCanvas')),
        ias: box(document.querySelector('.pfd-side-tape--left')),
        alt: box(document.querySelector('.pfd-side-tape--right')),
        zoom: box(document.querySelector('.leaflet-control-zoom')),
        compass: box(document.querySelector('.terrain-compass')),
      };
    });
  }

  async function openModeA(page, viewport) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => {
      if (!localStorage.getItem('visionLandingMissionSwapV1')) {
        localStorage.setItem('visionLandingMissionSwapV1', 'map-horizon');
      }
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#missionSwapHorizonMapBtn');
    await page.waitForFunction(() => {
      const canvas = document.getElementById('horizonCanvas');
      const map = document.getElementById('terrainMap');
      return canvas && canvas.width > 10 && map && map.classList.contains('leaflet-container');
    });
    await page.waitForFunction(() => document.querySelector('.mission-workspace')?.dataset.missionSwap === 'map-horizon');
  }

  for (const viewport of viewports) {
    it(`swaps size, keeps column order, and avoids overlap at ${viewport.name}`, async () => {
      const page = await browser.newPage();
      await openModeA(page, viewport);
      const before = await measure(page);
      await page.screenshot({ path: path.join(shots, `mode-a-${viewport.name}.png`) });

      expect(before.swap).toBe('map-horizon');
      expect(before.map.width).toBeGreaterThan(40);
      expect(before.horizon.width).toBeGreaterThan(40);
      expect(before.stage.width).toBeGreaterThan(20);
      expect(before.canvas.width).toBeGreaterThan(20);

      expect(interiorsIntersect(before.map, before.horizon)).toBe(false);
      expect(interiorsIntersect(before.horizon, before.talk)).toBe(false);
      expect(interiorsIntersect(before.map, before.talk)).toBe(false);
      expect(interiorsIntersect(before.ias, before.stage)).toBe(false);
      expect(interiorsIntersect(before.alt, before.stage)).toBe(false);

      if (viewport.layout !== 'stack') {
        expect(before.map.width).toBeGreaterThan(before.horizon.width * 1.4);
        expect(before.map.left).toBeLessThan(before.horizon.left);
        expect(before.horizon.left).toBeGreaterThanOrEqual(before.map.right - 8);
      } else {
        expect(before.map.top).toBeLessThan(before.horizon.top);
        expect(before.map.height).toBeGreaterThanOrEqual(200);
      }

      await page.evaluate(() => {
        window.__invalidateCalls = 0;
        const arm = () => {
          if (!window.terrainMap || window.terrainMap.__swapWrapped) return Boolean(window.terrainMap);
          const orig = window.terrainMap.invalidateSize.bind(window.terrainMap);
          window.terrainMap.invalidateSize = function (...args) {
            window.__invalidateCalls += 1;
            return orig(...args);
          };
          window.terrainMap.__swapWrapped = true;
          return true;
        };
        if (!arm()) {
          const timer = setInterval(() => {
            if (arm()) clearInterval(timer);
          }, 50);
        }
      });
      await page.waitForFunction(() => window.terrainMap && window.terrainMap.__swapWrapped);

      const callsBefore = await page.evaluate(() => window.__invalidateCalls || 0);
      await page.click('#missionSwapHorizonMapBtn');
      await page.waitForFunction(() => document.querySelector('.mission-workspace')?.dataset.missionSwap === 'horizon-map');
      await page.waitForFunction((n) => window.__invalidateCalls > n, callsBefore);
      await page.waitForFunction((stacked) => {
        const stage = document.getElementById('pfdHorizonStage');
        const canvas = document.getElementById('horizonCanvas');
        if (!stage || !canvas) return false;
        const sr = stage.getBoundingClientRect();
        const cr = canvas.getBoundingClientRect();
        return Math.abs(cr.width - sr.width) < 3 && Math.abs(cr.height - sr.height) < 3 && (stacked ? sr.height > 220 : sr.width > 200);
      }, viewport.layout === 'stack');
      const after = await measure(page);
      await page.screenshot({ path: path.join(shots, `mode-b-${viewport.name}.png`) });

      expect(after.swap).toBe('horizon-map');
      expect(after.stored).toBe('horizon-map');
      expect(interiorsIntersect(after.map, after.horizon)).toBe(false);
      expect(interiorsIntersect(after.horizon, after.talk)).toBe(false);
      expect(interiorsIntersect(after.map, after.talk)).toBe(false);
      expect(interiorsIntersect(after.ias, after.stage)).toBe(false);
      expect(interiorsIntersect(after.alt, after.stage)).toBe(false);
      expect(interiorsIntersect(after.ias, after.alt)).toBe(false);
      if (after.zoom && after.compass) {
        expect(interiorsIntersect(after.zoom, after.compass)).toBe(false);
      }
      expect(Math.abs(after.canvas.width - after.stage.width)).toBeLessThan(3);
      expect(Math.abs(after.canvas.height - after.stage.height)).toBeLessThan(3);

      if (viewport.layout !== 'stack') {
        expect(after.horizon.width).toBeGreaterThan(after.map.width * 1.4);
        expect(Math.abs(after.horizon.left - before.map.left)).toBeLessThan(8);
        expect(Math.abs(after.map.left - before.horizon.left)).toBeLessThan(8);
        expect(after.stage.width).toBeGreaterThan(before.stage.width * 1.4);
      } else {
        expect(after.map.top).toBeLessThan(after.horizon.top);
        expect(after.map.height).toBeLessThan(before.map.height);
        expect(after.stage.height).toBeGreaterThan(before.stage.height);
        expect(after.horizon.top).toBeGreaterThanOrEqual(after.map.bottom - 8);
      }
      if (viewport.layout === 'three') {
        expect(after.talk.left).toBeGreaterThanOrEqual(Math.max(after.map.right, after.horizon.right) - 8);
      }
      if (viewport.layout === 'side') {
        expect(after.talk.top).toBeGreaterThanOrEqual(Math.max(after.map.bottom, after.horizon.bottom) - 8);
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.mission-workspace')?.dataset.missionSwap === 'horizon-map');
      const kept = await measure(page);
      expect(kept.stored).toBe('horizon-map');
      if (viewport.layout !== 'stack') {
        expect(kept.horizon.width).toBeGreaterThan(kept.map.width * 1.4);
        expect(Math.abs(kept.horizon.left - before.map.left)).toBeLessThan(8);
      } else {
        expect(kept.map.height).toBeLessThan(180);
        expect(kept.stage.height).toBeGreaterThan(220);
      }
      await page.close();
    }, 30000);
  }
});
