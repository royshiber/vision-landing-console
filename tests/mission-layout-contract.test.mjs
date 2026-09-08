import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

describe('Mission layout contract — static source', () => {
  it('uses CSS Grid for mission regions and reserved PFD lanes', () => {
    expect(html).toMatch(/data-layout-contract="v1"/);
    expect(html).toContain('class="pfd-heading-lane"');
    expect(html).not.toMatch(/data-tab="platform"/);
    expect(html).not.toMatch(/data-tab="maintenance"/);
    expect(html).not.toContain('id="platform"');
    const workspace = cssBlock(css, '.mission-workspace[data-mission-layout="ops-v1"]');
    expect(workspace).toMatch(/display:\s*grid/);
    expect(workspace).toMatch(/gap:\s*6px/);
    expect(workspace).toMatch(/minmax\(160px, min\(28%, var\(--mission-ah-col\)\)\)/);
    expect(workspace).toMatch(/minmax\(96px, min\(28%, var\(--mission-ah-row\)\)\)/);
    expect(workspace).toMatch(/minmax\(280px, var\(--mission-talk-col\)\)/);
    expect(workspace).toMatch(/--mission-msg-h:\s*64px/);
    expect(cssBlock(css, '.mission-region[data-mission-region="map"]')).toMatch(/min-height:\s*55%/);
    expect(cssBlock(css, '.mission-region-messages[data-messages-expanded="0"]')).toMatch(/max-height:\s*72px/);
    expect(cssBlock(css, '.mission-region[data-mission-region="talk"]')).toMatch(/min-width:\s*280px/);
    expect(cssBlock(css, '.mission-ops-chrome')).toMatch(/min-height:\s*28px/);
  });

  it('keeps PFD tapes, heading, video toggle, and video panel in flow', () => {
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/direction:\s*ltr/);
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/grid-template-areas:/);
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/"ias horizon alt"/);
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/"hdg hdg hdg"/);
    expect(cssBlock(css, '.pfd-side-tape')).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.pfd-heading-lane')).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.pfd-video-toggle')).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.pfd-video-panel')).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.pfd-video-panel')).not.toMatch(/position:\s*absolute/);
    expect(cssBlock(css, '.mission-messages-toggle')).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/flex-flow:\s*row nowrap/);
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/align-items:\s*flex-start/);
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/gap:\s*8px/);
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/overflow-x:\s*auto/);
  });

  it('reflows Pulse add-widget cards in an auto-placement grid', () => {
    const extras = cssBlock(css, '.pulse-extra-metrics,\n.pulse-extra-row');
    expect(extras).toMatch(/grid-template-columns:\s*repeat\(auto-fill/);
    expect(extras).toMatch(/grid-auto-flow:\s*row/);
    expect(extras).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.pulse-home.pulse-status-home')).toMatch(/overflow-y:\s*auto/);
    expect(cssBlock(css, '.pulse-extra-tile')).not.toMatch(/position:\s*absolute/);
    expect(js).toContain("tile.className = 'pulse-extra-tile'");
    expect(sliceFunction(js, 'refreshPulseExtraWidgets')).not.toMatch(/position\s*=\s*['"]absolute['"]/);
  });

  it('clamps AH size shares to 28% and never writes raw fr tracks', () => {
    expect(js).toContain("MISSION_SIZE_KEY = 'visionLandingMissionSizeV3'");
    const apply = sliceFunction(js, 'applyMissionSize');
    expect(apply).toContain('Math.min(28');
    expect(apply).toContain('--mission-ah-col');
    expect(apply).toContain('--mission-ah-row');
    expect(apply).not.toMatch(/--mission-r1',\s*`\$\{size\.r1\}fr`/);
    expect(apply).not.toMatch(/--mission-c1',\s*`\$\{size\.c1\}fr`/);
    const size = new Function(`${sliceFunction(js, 'defaultMissionSize')}; return defaultMissionSize();`)();
    expect(size.c1).toBeLessThanOrEqual(0.28);
    expect(size.r1).toBeLessThanOrEqual(0.28);
    const read = sliceFunction(js, 'readMissionSize');
    expect(read).toMatch(/clampMissionFr\(raw\.c1, 0\.16, 0\.28/);
    expect(read).toMatch(/clampMissionFr\(raw\.r1, 0\.16, 0\.28/);
    const split = sliceFunction(js, 'bindMissionSplitters');
    expect(split).toMatch(/clampMissionFr\(base\.c1 \+ delta, 0\.16, 0\.28/);
    expect(split).toMatch(/clampMissionFr\(base\.r1 \+ delta, 0\.16, 0\.28/);
  });
});

describe('Mission layout contract — live boxes', () => {
  const PORT = process.env.VLC_CONTRACT_PORT || '4017';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;
  let page = null;

  async function waitHealth(maxMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('layout-contract server did not become healthy');
  }

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth();
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      localStorage.setItem('visionLandingPulseWidgetsV1', JSON.stringify([
        { id: 'w-alt-row', key: 'mavlink.altitude', label: 'גובה', unit: 'm', place: 'row' },
        { id: 'w-hdg-row', key: 'mavlink.heading', label: 'כיוון אף', unit: '°', place: 'row' },
        { id: 'w-ias-row', key: 'mavlink.airspeed', label: 'מהירות אוויר', unit: 'm/s', place: 'row' },
        { id: 'w-cpu-jet', key: 'jetson.cpuLoadPct', label: 'עומס CPU', unit: '%', place: 'jetson' },
      ]));
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-mission-region="map"]');
  }, 45000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  it('keeps mission region boxes from intersecting and honors size shares', async () => {
    const shotDir = '/opt/cursor/artifacts/screenshots';
    fs.mkdirSync(shotDir, { recursive: true });
    const measured = await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const ws = document.querySelector('.mission-workspace');
      const regions = {};
      for (const id of ['horizon', 'map', 'data', 'messages', 'talk']) {
        regions[id] = box(document.querySelector(`[data-mission-region="${id}"]`));
      }
      const tiles = [...document.querySelectorAll('.mission-data-tile')].map(box);
      const pfd = {
        ias: box(document.querySelector('.pfd-side-tape--left')),
        stage: box(document.getElementById('pfdHorizonStage')),
        alt: box(document.querySelector('.pfd-side-tape--right')),
        hdg: box(document.querySelector('.pfd-heading-lane')),
        videoToggle: box(document.getElementById('horizonVideoToggle')),
        videoPanel: box(document.getElementById('horizonVideoPanel')),
      };
      const talk = getComputedStyle(document.querySelector('[data-mission-region="talk"]'));
      const dataGrid = getComputedStyle(document.getElementById('missionDataGrid'));
      return {
        ws: box(ws),
        regions,
        tiles,
        pfd,
        talkMinWidth: talk.minWidth,
        dataGap: dataGrid.gap,
        dataOverflowX: dataGrid.overflowX,
        version: document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '',
        platformTab: !!document.querySelector('[data-tab="platform"]'),
      };
    });

    expect(measured.platformTab).toBe(false);
    expect(measured.version).toBe('1.02.260');
    expect(measured.ws.width).toBeGreaterThan(800);
    expect(measured.talkMinWidth).toBe('280px');
    expect(Number.parseFloat(measured.dataGap)).toBeGreaterThanOrEqual(8);
    expect(measured.dataOverflowX).toMatch(/auto|scroll/);

    const { ws, regions } = measured;
    expect(regions.map.height / ws.height).toBeGreaterThanOrEqual(0.55);
    expect(regions.map.height / regions.map.width).toBeGreaterThan(0.85);
    expect(regions.messages.height).toBeLessThanOrEqual(72);
    expect(regions.horizon.width / ws.width).toBeLessThanOrEqual(0.28 + 0.01);
    expect(regions.horizon.height / ws.height).toBeLessThanOrEqual(0.28 + 0.01);
    expect(regions.talk.width).toBeGreaterThanOrEqual(280);

    const names = Object.keys(regions);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        expect(
          interiorsIntersect(regions[names[i]], regions[names[j]]),
          `${names[i]} overlaps ${names[j]}`,
        ).toBe(false);
      }
    }

    expect(measured.pfd.ias.right).toBeLessThanOrEqual(measured.pfd.stage.left + 1);
    expect(measured.pfd.alt.left).toBeGreaterThanOrEqual(measured.pfd.stage.right - 1);
    expect(measured.pfd.hdg.top).toBeGreaterThanOrEqual(measured.pfd.stage.bottom - 1);
    const pfdParts = [measured.pfd.ias, measured.pfd.stage, measured.pfd.alt, measured.pfd.hdg, measured.pfd.videoToggle]
      .filter((part) => part && part.width > 2 && part.height > 2);
    for (let i = 0; i < pfdParts.length; i += 1) {
      for (let j = i + 1; j < pfdParts.length; j += 1) {
        expect(interiorsIntersect(pfdParts[i], pfdParts[j]), 'PFD chrome overlap').toBe(false);
      }
    }
    if (measured.pfd.videoPanel && measured.pfd.videoPanel.height > 2) {
      for (const tape of [measured.pfd.ias, measured.pfd.alt, measured.pfd.hdg]) {
        expect(interiorsIntersect(measured.pfd.videoPanel, tape), 'video panel covers a tape').toBe(false);
      }
    }

    for (let i = 0; i < measured.tiles.length; i += 1) {
      expect(measured.tiles[i].height).toBeLessThanOrEqual(72);
      for (let j = i + 1; j < measured.tiles.length; j += 1) {
        expect(interiorsIntersect(measured.tiles[i], measured.tiles[j]), 'data tiles overlap').toBe(false);
      }
    }

    await page.screenshot({ path: path.join(shotDir, 'mission-contract.png'), fullPage: false });
  }, 45000);

  it('keeps Pulse extra cards in flow without stacking', async () => {
    await page.click('[data-tab="pulse"]');
    await page.waitForSelector('#pulseExtraRow .pulse-extra-tile');
    const pulse = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const tiles = [...document.querySelectorAll('.pulse-extra-tile')].map((el) => ({
        ...box(el),
        position: getComputedStyle(el).position,
      }));
      const home = getComputedStyle(document.querySelector('.pulse-home.pulse-status-home'));
      return { tiles, overflowY: home.overflowY, platform: !!document.querySelector('[data-tab="platform"]') };
    });
    expect(pulse.platform).toBe(false);
    expect(pulse.tiles.length).toBeGreaterThanOrEqual(3);
    expect(pulse.overflowY).toMatch(/auto|scroll/);
    for (const tile of pulse.tiles) {
      expect(tile.position).not.toBe('absolute');
    }
    for (let i = 0; i < pulse.tiles.length; i += 1) {
      for (let j = i + 1; j < pulse.tiles.length; j += 1) {
        expect(interiorsIntersect(pulse.tiles[i], pulse.tiles[j]), 'pulse extra tiles overlap').toBe(false);
      }
    }
    const shotDir = '/opt/cursor/artifacts/screenshots';
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'status-widgets-contract.png'), fullPage: false });
  }, 30000);

  it('keeps Evolve command and live-run regions from overlapping', async () => {
    await page.click('[data-tab="development"]');
    await page.waitForSelector('.evolve-shell');
    const evolve = await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const command = box(document.querySelector('.evolve-command'));
      const live = box(document.querySelector('.evolve-live'));
      const intent = box(document.querySelector('.evolve-intent'));
      const preview = box(document.querySelector('.evolve-preview'));
      const delivery = box(document.querySelector('.evolve-delivery'));
      const backlog = box(document.querySelector('.evolve-backlog'));
      const cards = [...document.querySelectorAll('.evolve-run-card')].map(box);
      const cs = getComputedStyle(document.querySelector('.evolve-shell'));
      const ask = document.getElementById('devTaskDescription');
      return {
        command,
        live,
        intent,
        preview,
        delivery,
        backlog,
        cards,
        display: cs.display,
        gap: cs.gap,
        overflowY: cs.overflowY,
        placeholder: ask ? ask.getAttribute('placeholder') : '',
        planEmpty: document.getElementById('evolvePlanEmpty')?.textContent || '',
        testEmpty: document.getElementById('evolveTestEmpty')?.textContent || '',
        prEmpty: document.getElementById('evolvePrEmpty')?.textContent || '',
        maintenanceTab: !!document.querySelector('[data-tab="maintenance"]'),
      };
    });
    expect(evolve.maintenanceTab).toBe(false);
    expect(evolve.display).toBe('grid');
    expect(Number.parseFloat(evolve.gap)).toBeLessThanOrEqual(8);
    expect(evolve.overflowY).toMatch(/auto|scroll/);
    expect(evolve.placeholder).toBe('תארו מה לשנות…');
    expect(evolve.planEmpty).toContain('אין תוכנית עדיין');
    expect(evolve.testEmpty).toContain('אין בדיקות עדיין');
    expect(evolve.prEmpty).toContain('אין בקשת מיזוג עדיין');
    expect(interiorsIntersect(evolve.command, evolve.live)).toBe(false);
    expect(interiorsIntersect(evolve.intent, evolve.preview)).toBe(false);
    expect(interiorsIntersect(evolve.preview, evolve.delivery)).toBe(false);
    expect(interiorsIntersect(evolve.command, evolve.backlog)).toBe(false);
    expect(interiorsIntersect(evolve.live, evolve.backlog)).toBe(false);
    for (let i = 0; i < evolve.cards.length; i += 1) {
      for (let j = i + 1; j < evolve.cards.length; j += 1) {
        expect(interiorsIntersect(evolve.cards[i], evolve.cards[j]), 'evolve run cards overlap').toBe(false);
      }
    }
    const shotDir = '/opt/cursor/artifacts/screenshots';
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'evolve-concept3.png'), fullPage: false });
  }, 30000);
});
