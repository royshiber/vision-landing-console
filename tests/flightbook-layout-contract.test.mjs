import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const fbCss = fs.readFileSync(path.join(repoRoot, 'public', 'modules', 'flightbook.css'), 'utf8');
const shotDir = '/tmp/flightbook-shots';

function cssBlock(src, selector) {
  const start = src.indexOf(selector);
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed selector ${selector}`);
}

function interiorsIntersect(a, b, slack = 1) {
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

function startServer(port, env) {
  const sqlite = path.join(os.tmpdir(), `airvix-fb-layout-${port}.sqlite`);
  fs.rmSync(sqlite, { force: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: sqlite,
      GEMINI_API_KEY: '',
      FLIGHT_DEBRIEF_MOCK: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitHealth(base, maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`flight book server did not become healthy at ${base}`);
}

async function shot(page, name) {
  fs.mkdirSync(shotDir, { recursive: true });
  const file = path.join(shotDir, name);
  await page.screenshot({ path: file, type: 'png' });
  return file;
}

describe('Flight book layout contract — static source', () => {
  it('hosts the flight book panel, grid, module, and טיסות tab', () => {
    expect(html).toMatch(/id="debriefFlightbookPanel"[^>]*data-debrief-panel="flightbook"/);
    expect(html).toMatch(/data-layout-contract="flightbook-v1"/);
    expect(html).toMatch(/id="debriefFlightbookPanel"[^>]*dir="rtl"/);
    expect(html).toMatch(/id="debriefFlightbookBtn"[^>]*data-debrief-tab="flightbook"[^>]*>טיסות</);
    expect(html).toMatch(/modules\/flightbook\.mjs\?v=__APP_VERSION__/);
    const grid = cssBlock(fbCss, '.fb-shell');
    expect(grid).toMatch(/display:\s*grid/);
    expect(grid).toMatch(/minmax\(300px,\s*380px\)/);
    expect(grid).toMatch(/minmax\(0,\s*1fr\)/);
    expect(fbCss).toMatch(/\.fb-plot\s*\{[^}]*min-height:\s*110px/);
    expect(fbCss).toMatch(/\.fb-map\s*\{[^}]*min-height:\s*280px/);
  });
});

describe('Flight book layout contract — live boxes', () => {
  const PORT = '4024';
  const BASE = `http://127.0.0.1:${PORT}`;
  const UID_A = '20260920T070000Z-airvix01-a1b2';
  const UID_B = '20260921T080000Z-airvix01-c3d4';
  const UID_C = '20260922T060000Z-airvix01-e5f6';
  let serverProc = null;
  let browser = null;
  let page = null;
  const consoleErrors = [];

  async function openBook() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.clear());
    await page.click('[data-tab="recordings"]');
    await page.waitForSelector('#fbListScroll .fb-card', { timeout: 20000 });
  }

  async function openUid(uid) {
    await page.click(`#fbListScroll .fb-card[data-uid="${uid}"]`);
    await page.waitForSelector('#fbTimeline .fb-event', { timeout: 20000 });
    await page.waitForSelector('#fbPlotStack .fb-plot', { timeout: 10000 });
  }

  async function measure() {
    return page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const list = document.querySelector('#fbListScroll');
      const timeline = document.querySelector('#fbTimeline');
      const plots = [...document.querySelectorAll('#fbPlotStack .fb-plot')].map((el) => ({
        id: el.dataset.fbPlot,
        ...box(el),
        h: el.offsetHeight,
      }));
      const cards = [...document.querySelectorAll('#fbListScroll .fb-card')].map((el) => ({
        overflow: el.scrollWidth - el.clientWidth,
      }));
      return {
        list: box(document.querySelector('.fb-list')),
        main: box(document.querySelector('.fb-main')),
        kpi: box(document.querySelector('[data-fb="kpi"]')),
        debrief: box(document.querySelector('[data-fb="debrief"]')),
        timeline: box(document.querySelector('[data-fb="timeline"]')),
        map: box(document.querySelector('[data-fb="map"]')),
        timelineH: document.querySelector('[data-fb="timeline"]')?.offsetHeight || 0,
        mapH: document.querySelector('[data-fb="map"]')?.offsetHeight || 0,
        plots,
        listScroll: list ? list.scrollHeight > list.clientHeight : false,
        timelineScroll: timeline ? timeline.scrollHeight > timeline.clientHeight : false,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cards,
        cursor: document.querySelector('#fbPlotStack')?.dataset.fbCursor || '',
        mapSel: document.querySelector('#fbMap')?.dataset.fbMapSel || '',
        uids: [...document.querySelectorAll('#fbListScroll .fb-card')].map((el) => el.dataset.uid),
      };
    });
  }

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    serverProc = startServer(PORT, { FLIGHT_LOGS_MODE: 'mock' });
    await waitHealth(BASE);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  it('keeps the list on the right and both columns scrolling at three viewports', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBook();
    await shot(page, 'list-1440.png');
    const listed = await page.locator('#fbListScroll .fb-card').count();
    expect(listed).toBe(3);
    expect(await page.locator(`#fbListScroll .fb-card[data-uid="${UID_C}"]`).count()).toBe(0);

    await openUid(UID_A);
    await shot(page, 'flight-a-1440.png');
    const at1440 = await measure();
    expect(at1440.list.left).toBeGreaterThan(at1440.main.right - 12);
    expect(at1440.docOverflow).toBeLessThanOrEqual(1);
    expect(at1440.listScroll).toBe(true);
    expect(at1440.timelineScroll).toBe(true);
    expect(at1440.timelineH).toBeGreaterThanOrEqual(280);
    expect(at1440.mapH).toBeGreaterThanOrEqual(280);
    expect(at1440.kpi.height).toBeGreaterThan(20);
    expect(at1440.debrief.height).toBeGreaterThan(20);
    expect(at1440.plots).toHaveLength(6);
    for (const plot of at1440.plots) expect(plot.h).toBeGreaterThanOrEqual(110);
    const regions = [at1440.kpi, at1440.debrief, at1440.timeline, at1440.map, ...at1440.plots];
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        expect(interiorsIntersect(regions[i], regions[j]), `overlap ${i} ${j}`).toBe(false);
      }
    }

    await page.click('.fb-event');
    await page.waitForFunction(() => (document.querySelector('#fbPlotStack')?.dataset.fbCursor || '') !== '');
    const moved = await measure();
    expect(moved.cursor).not.toBe('');
    expect(moved.mapSel).toBe(moved.cursor);

    await openUid(UID_B);
    await shot(page, 'flight-b-glitch-1440.png');
    expect(await page.locator('#fbTimeline').innerText()).toContain('סיבה:');

    for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size);
      await openUid(UID_A);
      const measured = await measure();
      expect(measured.list.left).toBeGreaterThan(measured.main.right - 12);
      expect(measured.docOverflow).toBeLessThanOrEqual(1);
      expect(measured.listScroll).toBe(true);
      expect(measured.timelineScroll).toBe(true);
      expect(measured.mapH).toBeGreaterThanOrEqual(280);
      expect(measured.timelineH).toBeGreaterThanOrEqual(280);
      for (const plot of measured.plots) expect(plot.h).toBeGreaterThanOrEqual(110);
      if (size.width === 1280) {
        await shot(page, 'flight-1280.png');
        for (const card of measured.cards) expect(card.overflow).toBeLessThanOrEqual(1);
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#fbGround');
    await page.waitForSelector(`#fbListScroll .fb-card[data-uid="${UID_C}"]`);
    await shot(page, 'ground-toggle.png');
    const withGround = await page.locator('#fbListScroll .fb-card').count();
    expect(withGround).toBe(4);

    const noisy = consoleErrors.filter((line) => !/favicon|Failed to load resource|net::ERR|tile\.openstreetmap/i.test(line));
    expect(noisy).toEqual([]);
  }, 120000);
});

describe('Flight book empty state when storage is off', () => {
  const PORT = '4025';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = startServer(PORT, { FLIGHT_LOGS_MODE: 'off' });
    await waitHealth(BASE);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  it('shows the Hebrew not-configured sentence and no flights', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.clear());
    await page.click('[data-tab="recordings"]');
    await page.waitForSelector('#fbListScroll .fb-empty', { timeout: 15000 });
    const text = await page.locator('#fbListScroll').innerText();
    expect(text).toContain('אחסון הטיסות בענן לא הוגדר');
    expect(await page.locator('.fb-card').count()).toBe(0);
    await shot(page, 'empty-off.png');
    await page.close();
  }, 40000);
});
