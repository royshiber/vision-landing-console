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

async function writeShot(page, name) {
  const buf = await page.screenshot({ type: 'png', fullPage: false });
  fs.mkdirSync('/tmp/pr264-shots', { recursive: true });
  const tmp = path.join('/tmp/pr264-shots', name);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

describe('Mission layout contract — static source', () => {
  it('uses a three-column stack: readable PFD, filled left column, map, talk', () => {
    expect(html).toMatch(/data-layout-contract="v2"/);
    expect(html).toContain('class="pfd-heading-lane"');
    expect(html).toContain('id="missionHorizonFiller"');
    expect(html).not.toMatch(/data-tab="platform"/);
    expect(html).not.toMatch(/data-tab="maintenance"/);
    expect(html).not.toContain('id="platform"');
    const workspace = cssBlock(css, '.mission-workspace[data-mission-layout="ops-v1"]');
    expect(workspace).toMatch(/display:\s*grid/);
    expect(workspace).toMatch(/gap:\s*4px/);
    expect(workspace).toMatch(/minmax\(132px, min\(22%, var\(--mission-ah-col\)\)\)/);
    expect(workspace).toMatch(/minmax\(0, 1fr\)/);
    expect(workspace).toMatch(/minmax\(240px, min\(28%, var\(--mission-talk-col\)\)\)/);
    expect(workspace).toMatch(/--mission-msg-h:\s*40px/);
    expect(workspace).toMatch(/--mission-map-min:\s*65%/);
    expect(workspace).toMatch(/--mission-ah-row:\s*40%/);
    expect(workspace).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
    expect(workspace).toMatch(/grid-template-areas:\s*"horizon map talk"/);
    expect(workspace).not.toMatch(/"data\s+map talk"/);
    expect(workspace).not.toMatch(/"messages map talk"/);
    expect(cssBlock(css, '.mission-region[data-mission-region="map"]')).toMatch(/min-height:\s*var\(--mission-map-min/);
    expect(cssBlock(css, '.mission-region[data-mission-region="horizon"]')).toMatch(/align-self:\s*stretch/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*height:\s*var\(--mission-ah-row/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*min-height:\s*35%/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*max-height:\s*42%/);
    expect(cssBlock(css, '.mission-horizon-filler')).toMatch(/flex:\s*0 1 auto/);
    expect(cssBlock(css, '.mission-horizon-filler')).toMatch(/max-height:\s*32%/);
    expect(cssBlock(css, '.mission-horizon-filler')).toMatch(/background:\s*#1e293b/);
    expect(cssBlock(css, '.mission-region-messages[data-messages-expanded="0"]')).toMatch(/max-height:\s*40px/);
    expect(cssBlock(css, '.mission-region[data-mission-region="messages"]')).toMatch(/position:\s*absolute/);
    expect(cssBlock(css, '.mission-region[data-mission-region="talk"]')).toMatch(/min-width:\s*240px/);
    expect(cssBlock(css, '.mission-ops-chrome')).toMatch(/min-height:\s*22px/);
    expect(cssBlock(css, '.mission-ops-chrome')).toMatch(/max-height:\s*22px/);
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
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/align-items:\s*stretch/);
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/gap:\s*4px/);
    expect(cssBlock(css, '.mission-data-grid')).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps Assist empty invite at the top of a filled transcript panel', () => {
    expect(html).toMatch(/class="assist-transcript-well"/);
    expect(css).toMatch(/#missionTalkHost \.assist-empty-stage/);
    expect(cssBlock(css, '#missionTalkHost .assist-empty-stage')).toMatch(/flex:\s*1 1 0/);
    expect(cssBlock(css, '#missionTalkHost .assist-empty-stage')).toMatch(/justify-content:\s*flex-start/);
    expect(cssBlock(css, '#missionTalkHost .assist-empty-stage')).not.toMatch(/min-height:\s*140px/);
    expect(cssBlock(css, '#missionTalkHost .assist-transcript-well')).toMatch(/background:\s*#1e293b/);
    expect(cssBlock(css, '#missionTalkHost .assist-transcript-well')).toMatch(/border:\s*1px solid/);
    expect(css).toMatch(/#missionTalkHost \.assist-composer\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/#missionTalkHost \.assist-composer\s*\{[^}]*max-height:\s*210px/);
    expect(html).toMatch(/<textarea id="assistInput" class="assist-input"/);
    expect(css).toMatch(/#missionTalkHost \.assist-form\s*\{[^}]*flex-flow:\s*row nowrap/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\s*\{[^}]*min-width:\s*8rem/);
    expect(css).toMatch(/#missionTalkHost \.assist-input:focus/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\.assist-input--grown \{[\s\S]*?max-height:\s*7\.5em/);
    expect(css).toMatch(/#development\.panel\.visible\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/#pulse\.panel\.visible\s*\{[^}]*display:\s*flex/);
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

  it('clamps AH size shares to 22% and never writes raw fr tracks', () => {
    expect(js).toContain("MISSION_SIZE_KEY = 'visionLandingMissionSizeV4'");
    const apply = sliceFunction(js, 'applyMissionSize');
    expect(apply).toContain('Math.min(22');
    expect(apply).toContain('--mission-ah-col');
    expect(apply).not.toContain('--mission-ah-row');
    expect(apply).not.toMatch(/--mission-r1',\s*`\$\{size\.r1\}fr`/);
    expect(apply).not.toMatch(/--mission-c1',\s*`\$\{size\.c1\}fr`/);
    const size = new Function(`${sliceFunction(js, 'defaultMissionSize')}; return defaultMissionSize();`)();
    expect(size.c1).toBeLessThanOrEqual(0.22);
    expect(size.c3).toBeLessThan(size.c2);
    const read = sliceFunction(js, 'readMissionSize');
    expect(read).toMatch(/clampMissionFr\(raw\.c1, 0\.14, 0\.22/);
    const split = sliceFunction(js, 'bindMissionSplitters');
    expect(split).toMatch(/clampMissionFr\(base\.c1 \+ delta, 0\.14, 0\.22/);
    expect(sliceFunction(js, 'applyMissionAreas')).toContain("id === 'messages' || id === 'data'");
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
    await page.waitForFunction(
      () => document.querySelectorAll('.leaflet-tile-loaded').length >= 4,
      { timeout: 20000 },
    );
  }, 45000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  it('keeps mission region boxes from intersecting and honors size shares', async () => {
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
      const mapEl = document.querySelector('[data-mission-region="map"]');
      const mapBox = box(mapEl);
      const leaflet = box(document.getElementById('terrainMap'));
      const talkEl = document.querySelector('[data-mission-region="talk"]');
      const talk = getComputedStyle(talkEl);
      const dataGrid = getComputedStyle(document.getElementById('missionDataGrid'));
      const msgEl = document.querySelector('[data-mission-region="messages"]');
      const msgCs = getComputedStyle(msgEl);
      const empty = document.querySelector('#missionTalkHost .assist-empty-stage');
      const invite = document.querySelector('#missionTalkHost .assist-empty-invite');
      const chrome = document.querySelector('.mission-ops-chrome');
      const well = document.querySelector('#missionTalkHost .assist-transcript-well');
      const messagesHost = document.querySelector('#missionTalkHost .assist-messages');
      const horizonCs = getComputedStyle(document.querySelector('[data-mission-region="horizon"]'));
      const hud = document.getElementById('flightHud');
      const filler = document.getElementById('missionHorizonFiller');
      return {
        ws: box(ws),
        regions,
        tiles,
        pfd,
        leaflet,
        talkMinWidth: talk.minWidth,
        dataGap: dataGrid.gap,
        dataOverflowX: dataGrid.overflowX,
        msgMaxHeight: msgCs.maxHeight,
        msgPosition: msgCs.position,
        emptyHeight: empty ? empty.getBoundingClientRect().height : 0,
        emptyTop: empty ? empty.getBoundingClientRect().top : 0,
        inviteTop: invite ? invite.getBoundingClientRect().top : 0,
        chromeHeight: chrome ? chrome.getBoundingClientRect().height : 0,
        version: document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '',
        platformTab: !!document.querySelector('[data-tab="platform"]'),
        horizonPosition: horizonCs.position,
        hud: box(hud),
        filler: box(filler),
        fillerBg: filler ? getComputedStyle(filler).backgroundColor : '',
        well: box(well),
        messagesHost: box(messagesHost),
        wellBg: well ? getComputedStyle(well).backgroundColor : '',
      };
    });

    expect(measured.platformTab).toBe(false);
    expect(measured.version).toBe('1.02.264');
    expect(measured.ws.width).toBeGreaterThan(800);
    expect(measured.talkMinWidth).toBe('240px');
    expect(Number.parseFloat(measured.dataGap)).toBeLessThanOrEqual(4);
    expect(measured.dataOverflowX).toMatch(/auto|scroll/);
    expect(measured.msgPosition).toBe('absolute');
    expect(Number.parseFloat(measured.msgMaxHeight)).toBeLessThanOrEqual(40);
    expect(measured.chromeHeight).toBeLessThanOrEqual(24);

    const { ws, regions } = measured;
    expect(regions.map.height / ws.height).toBeGreaterThanOrEqual(0.65);
    expect(regions.map.width / ws.width).toBeGreaterThan(0.50);
    expect(measured.leaflet.height / regions.map.height).toBeGreaterThanOrEqual(0.90);
    expect(measured.leaflet.width / regions.map.width).toBeGreaterThanOrEqual(0.90);
    expect(regions.messages.height).toBeLessThanOrEqual(40);
    expect(regions.horizon.width / ws.width).toBeLessThanOrEqual(0.22 + 0.02);
    expect(measured.hud.height / regions.horizon.height).toBeGreaterThanOrEqual(0.35);
    expect(measured.hud.height / regions.horizon.height).toBeLessThanOrEqual(0.42);
    expect(measured.horizonPosition).toBe('relative');
    expect(regions.horizon.height / ws.height).toBeGreaterThanOrEqual(0.90);
    expect(measured.filler.height).toBeGreaterThan(80);
    expect(measured.filler.height / regions.horizon.height).toBeLessThanOrEqual(0.34);
    expect(measured.fillerBg).not.toMatch(/rgba?\(\s*0,\s*0,\s*0/);
    expect(regions.data.height).toBeLessThanOrEqual(56);
    expect(regions.talk.width).toBeGreaterThanOrEqual(240);
    expect(regions.talk.height / ws.height).toBeGreaterThanOrEqual(0.90);
    expect(measured.well.height).toBeGreaterThanOrEqual(regions.talk.height * 0.40);
    expect(measured.emptyHeight).toBeGreaterThanOrEqual(measured.well.height * 0.50);
    expect(measured.inviteTop - measured.well.top).toBeLessThanOrEqual(32);
    expect(measured.wellBg).not.toMatch(/rgba?\(\s*0,\s*0,\s*0/);

    const overlayPair = (a, b) => {
      const skip = new Set([
        'map|messages', 'messages|map',
        'horizon|data', 'data|horizon',
      ]);
      return skip.has(`${a}|${b}`);
    };
    const names = Object.keys(regions);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        if (overlayPair(names[i], names[j])) continue;
        expect(
          interiorsIntersect(regions[names[i]], regions[names[j]]),
          `${names[i]} overlaps ${names[j]}`,
        ).toBe(false);
      }
    }
    expect(interiorsIntersect(regions.messages, regions.map)).toBe(true);
    expect(interiorsIntersect(regions.horizon, regions.map)).toBe(false);

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
      expect(measured.tiles[i].height).toBeLessThanOrEqual(48);
      for (let j = i + 1; j < measured.tiles.length; j += 1) {
        expect(interiorsIntersect(measured.tiles[i], measured.tiles[j]), 'data tiles overlap').toBe(false);
      }
    }

    const ahShareH = measured.hud.height / regions.horizon.height;
    const wellShare = measured.well.height / regions.talk.height;
    const underPfdGap = regions.horizon.bottom - measured.filler.bottom;
    const measure = {
      ahShareH,
      ahContentH: measured.hud.height,
      ahRegionH: regions.horizon.height,
      ahW: regions.horizon.width,
      wsH: ws.height,
      wsW: ws.width,
      mapShareH: regions.map.height / ws.height,
      mapShareW: regions.map.width / ws.width,
      underPfdGap,
      fillerH: measured.filler.height,
      wellShare,
      wellH: measured.well.height,
      emptyHeight: measured.emptyHeight,
      inviteOffset: measured.inviteTop - measured.well.top,
      wellBg: measured.wellBg,
      fillerBg: measured.fillerBg,
      version: measured.version,
    };
    fs.mkdirSync('/tmp/pr264-shots', { recursive: true });
    fs.writeFileSync('/tmp/pr264-shots/mission-contract-measure.json', JSON.stringify(measure, null, 2));

    await writeShot(page, 'mission-contract.png');
    await writeShot(page, 'hatasa-1440x900.png');
  }, 45000);

  it('grows the Assist composer without stealing map width or becoming a vertical strip', async () => {
    const before = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const input = document.getElementById('assistInput');
      const form = document.getElementById('assistForm');
      const map = document.querySelector('[data-mission-region="map"]');
      const talk = document.querySelector('[data-mission-region="talk"]');
      return {
        map: box(map),
        talk: box(talk),
        input: box(input),
        form: box(form),
        writingMode: getComputedStyle(input).writingMode,
        formWrap: getComputedStyle(form).flexWrap,
        formDir: getComputedStyle(form).flexDirection,
        minWidth: getComputedStyle(input).minWidth,
      };
    });
    expect(before.writingMode).toMatch(/horizontal-tb/);
    expect(before.formWrap).toBe('nowrap');
    expect(before.formDir).toBe('row');
    expect(before.input.width).toBeGreaterThan(120);
    expect(before.input.width).toBeGreaterThan(before.input.height);
    expect(before.form.width).toBeGreaterThan(before.form.height * 1.2);

    await page.click('#assistInput');
    await page.fill('#assistInput', 'שאלה ארוכה לבדיקת גובה הקומפוזר בלי לשבור את המפה');
    await page.waitForTimeout(80);

    const after = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const input = document.getElementById('assistInput');
      const form = document.getElementById('assistForm');
      const composer = document.querySelector('#missionTalkHost .assist-composer');
      const map = document.querySelector('[data-mission-region="map"]');
      const talk = document.querySelector('[data-mission-region="talk"]');
      const ws = document.querySelector('.mission-workspace');
      return {
        map: box(map),
        talk: box(talk),
        ws: box(ws),
        input: box(input),
        form: box(form),
        composer: box(composer),
        grown: input.classList.contains('assist-input--grown'),
        writingMode: getComputedStyle(input).writingMode,
        whiteSpace: getComputedStyle(input).whiteSpace,
        lines: Math.round(input.getBoundingClientRect().height / (parseFloat(getComputedStyle(input).lineHeight) || 18)),
      };
    });

    expect(after.grown).toBe(true);
    expect(after.writingMode).toMatch(/horizontal-tb/);
    expect(after.input.width).toBeGreaterThan(120);
    expect(after.input.width).toBeGreaterThan(after.input.height);
    expect(after.form.width).toBeGreaterThan(after.form.height);
    expect(after.composer.height).toBeLessThanOrEqual(210);
    expect(after.lines).toBeGreaterThanOrEqual(3);
    expect(after.lines).toBeLessThanOrEqual(6);
    expect(Math.abs(after.map.width - before.map.width) / before.map.width).toBeLessThanOrEqual(0.02);
    expect(Math.abs(after.talk.width - before.talk.width) / before.talk.width).toBeLessThanOrEqual(0.02);
    expect(after.map.height / after.ws.height).toBeGreaterThanOrEqual(0.65);
    await writeShot(page, 'mission-assist-focused.png');

    await page.fill('#assistInput', '');
    await page.locator('#assistInput').blur();
    await page.waitForTimeout(80);
    const collapsed = await page.evaluate(() => {
      const input = document.getElementById('assistInput');
      const map = document.querySelector('[data-mission-region="map"]');
      return {
        grown: input.classList.contains('assist-input--grown'),
        inputH: input.getBoundingClientRect().height,
        inputW: input.getBoundingClientRect().width,
        mapW: map.getBoundingClientRect().width,
      };
    });
    expect(collapsed.grown).toBe(false);
    expect(collapsed.inputW).toBeGreaterThan(collapsed.inputH);
    expect(Math.abs(collapsed.mapW - before.map.width) / before.map.width).toBeLessThanOrEqual(0.02);
    await writeShot(page, 'mission-assist-collapsed.png');
  }, 20000);

  it('grows messages as an overlay drawer instead of a grid row', async () => {
    await page.click('#missionMessagesToggle');
    const expanded = await page.evaluate(() => {
      const region = document.querySelector('[data-mission-region="messages"]');
      const map = document.querySelector('[data-mission-region="map"]');
      const ws = document.querySelector('.mission-workspace');
      const rr = region.getBoundingClientRect();
      const mr = map.getBoundingClientRect();
      const wr = ws.getBoundingClientRect();
      return {
        expanded: region.dataset.messagesExpanded,
        msgH: rr.height,
        mapH: mr.height,
        wsH: wr.height,
        msgBottom: rr.bottom,
        mapBottom: mr.bottom,
        rows: getComputedStyle(ws).gridTemplateRows,
      };
    });
    expect(expanded.expanded).toBe('1');
    expect(expanded.msgH).toBeGreaterThan(40);
    expect(expanded.msgH).toBeLessThanOrEqual(expanded.wsH * 0.45);
    expect(expanded.mapH / expanded.wsH).toBeGreaterThanOrEqual(0.65);
    expect(Math.abs(expanded.msgBottom - expanded.mapBottom)).toBeLessThan(16);
    expect(expanded.rows.split(' ').filter(Boolean).length).toBe(1);
    await writeShot(page, 'mission-aircraft-messages.png');
    await page.click('#missionMessagesToggle');
  }, 20000);

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
      const home = document.querySelector('.pulse-home.pulse-status-home');
      const homeBox = box(home);
      const title = document.querySelector('.pulse-title');
      return {
        tiles,
        overflowY: getComputedStyle(home).overflowY,
        homeHeight: homeBox.height,
        titleText: title?.textContent || '',
        titleColor: title ? getComputedStyle(title).color : '',
        platform: !!document.querySelector('[data-tab="platform"]'),
        panelDisplay: getComputedStyle(document.getElementById('pulse')).display,
      };
    });
    expect(pulse.platform).toBe(false);
    expect(pulse.panelDisplay).toMatch(/flex/);
    expect(pulse.tiles.length).toBeGreaterThanOrEqual(3);
    expect(pulse.overflowY).toMatch(/auto|scroll/);
    expect(pulse.homeHeight).toBeGreaterThan(200);
    expect(pulse.titleText).toContain('סטטוס מחשבים');
    expect(pulse.titleColor).not.toMatch(/rgba\(0, 0, 0, 0\)/);
    for (const tile of pulse.tiles) {
      expect(tile.position).not.toBe('absolute');
    }
    for (let i = 0; i < pulse.tiles.length; i += 1) {
      for (let j = i + 1; j < pulse.tiles.length; j += 1) {
        expect(interiorsIntersect(pulse.tiles[i], pulse.tiles[j]), 'pulse extra tiles overlap').toBe(false);
      }
    }
    await writeShot(page, 'status-widgets-contract.png');
  }, 45000);

  it('keeps Evolve command and live-run regions from overlapping', async () => {
    await page.locator('[data-tab="development"]').click({ force: true });
    await page.waitForFunction(() => document.getElementById('development')?.classList.contains('visible'));
    await page.waitForSelector('.evolve-shell', { state: 'visible', timeout: 15000 });
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
      const shell = document.querySelector('.evolve-shell');
      const panel = document.getElementById('development');
      const cs = getComputedStyle(shell);
      const ask = document.getElementById('devTaskDescription');
      const hero = document.querySelector('.evolve-hero h3');
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
        panelDisplay: getComputedStyle(panel).display,
        panelHeight: box(panel).height,
        heroText: hero?.textContent || '',
        heroColor: hero ? getComputedStyle(hero).color : '',
        placeholder: ask ? ask.getAttribute('placeholder') : '',
        planEmpty: document.getElementById('evolvePlanEmpty')?.textContent || '',
        testEmpty: document.getElementById('evolveTestEmpty')?.textContent || '',
        prEmpty: document.getElementById('evolvePrEmpty')?.textContent || '',
        maintenanceTab: !!document.querySelector('[data-tab="maintenance"]'),
      };
    });
    expect(evolve.maintenanceTab).toBe(false);
    expect(evolve.display).toBe('grid');
    expect(evolve.panelDisplay).toMatch(/flex/);
    expect(evolve.panelHeight).toBeGreaterThan(240);
    expect(evolve.heroText).toContain('פיתוח');
    expect(evolve.heroColor).not.toMatch(/rgba\(0, 0, 0, 0\)/);
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
    await writeShot(page, 'evolve-concept3.png');
  }, 45000);

  it('persists operator settings that can still be changed', async () => {
    const closeSettings = async () => {
      await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        if (modal) modal.hidden = true;
      });
    };
    try {
      await page.evaluate(() => {
        document.getElementById('globalSettingsBtn')?.click();
      });
      await page.waitForFunction(() => {
        const modal = document.getElementById('globalSettingsModal');
        return modal && !modal.hidden;
      });
      const before = await page.evaluate(() => {
        const vol = document.getElementById('gsVolumeSlider');
        const badge = document.getElementById('gsAttentionBadge');
        const critical = document.querySelector('[data-attention-level="critical"]');
        vol.value = '40';
        vol.dispatchEvent(new Event('input', { bubbles: true }));
        if (badge.checked) {
          badge.checked = false;
          badge.dispatchEvent(new Event('change', { bubbles: true }));
        }
        critical.click();
        return {
          modalOpen: !document.getElementById('globalSettingsModal').hidden,
          volume: window.__vlcSettings?.ttsVolume,
          settings: JSON.parse(localStorage.getItem('vlc_settings_v1') || '{}'),
          attention: JSON.parse(localStorage.getItem('visionLandingAttentionPolicyV1') || '{}'),
        };
      });
      expect(before.modalOpen).toBe(true);
      expect(before.volume).toBeCloseTo(0.4, 2);
      expect(before.settings.ttsVolume).toBeCloseTo(0.4, 2);
      expect(before.attention.proactiveLevel).toBe('critical');
      expect(before.attention.showAssistBadge).toBe(false);
      await closeSettings();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#globalSettingsBtn');
      await page.evaluate(() => {
        document.querySelector('[data-tab="terrain"]')?.click();
        document.getElementById('globalSettingsBtn')?.click();
      });
      await page.waitForFunction(() => {
        const modal = document.getElementById('globalSettingsModal');
        const vol = document.getElementById('gsVolumeSlider');
        const settings = JSON.parse(localStorage.getItem('vlc_settings_v1') || '{}');
        return modal && !modal.hidden && vol && vol.value === '40' && Number(settings.ttsVolume) === 0.4;
      });
      const after = await page.evaluate(() => {
        const vol = document.getElementById('gsVolumeSlider');
        const badge = document.getElementById('gsAttentionBadge');
        const critical = document.querySelector('[data-attention-level="critical"]');
        return {
          slider: vol?.value,
          label: document.getElementById('gsVolumeLabel')?.textContent,
          badge: badge?.checked,
          criticalOn: critical?.classList.contains('is-active'),
          settings: JSON.parse(localStorage.getItem('vlc_settings_v1') || '{}'),
          attention: JSON.parse(localStorage.getItem('visionLandingAttentionPolicyV1') || '{}'),
        };
      });
      expect(after.slider).toBe('40');
      expect(after.label).toBe('40%');
      expect(after.badge).toBe(false);
      expect(after.criticalOn).toBe(true);
      expect(after.settings.ttsVolume).toBeCloseTo(0.4, 2);
      expect(after.attention.proactiveLevel).toBe('critical');
      expect(after.attention.showAssistBadge).toBe(false);
      await writeShot(page, 'settings-persist.png');
    } finally {
      await closeSettings();
    }
  }, 45000);
});
