import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.VLC_INSTRUMENT_QA_PORT || '4046';
const BASE = `http://127.0.0.1:${PORT}`;

const viewports = [
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '360x740', width: 360, height: 740 },
];

const CORE = ['#pfdModeVal', '#pfdAltVal', '#pfdAirspeedVal', '#pfdHdgVal', '#pfdBattVal', '#hudFlightMode', '#hudAltitude', '#hudAirspeed'];

function layoutScript({ selectors, scrollEach, scrollGrid }) {
  function overlaps(a, b) {
    if (!a || !b || a.width < 1 || b.height < 1 || b.width < 1 || b.height < 1) return false;
    return a.bottom > b.top + 1 && a.top < b.bottom - 1 && a.right > b.left + 1 && a.left < b.right - 1;
  }
  function measure(el, doScroll) {
    if (doScroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node);
      const clip = ['hidden', 'auto', 'scroll', 'clip'].some((k) => (
        s.overflow.includes(k) || s.overflowX.includes(k) || s.overflowY.includes(k)
      ));
      if (clip) {
        const c = node.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      node = node.parentElement;
    }
    const viewLeft = Math.max(left, 0);
    const viewTop = Math.max(top, 0);
    const viewRight = Math.min(right, window.innerWidth);
    const viewBottom = Math.min(bottom, window.innerHeight);
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const inView = cx >= viewLeft && cx <= viewRight && cy >= viewTop && cy <= viewBottom;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    const owned = hit && (hit === el || el.contains(hit) || el.closest('.pfd-horizon-instrument') === hit || el.closest('.mission-data-tile') === hit || el.closest('.pfd-bottom-bar') === hit || el.closest('.pfd-top-bar') === hit || el.parentElement === hit);
    return {
      id: el.id || el.getAttribute('data-mission-data-slot') || el.className,
      boxW: r.width,
      boxH: r.height,
      w: Math.max(0, viewRight - viewLeft),
      h: Math.max(0, viewBottom - viewTop),
      clipW: Math.max(0, right - left),
      clipH: Math.max(0, bottom - top),
      hit: hit ? (hit.id || hit.className || hit.tagName) : '',
      hitOk: !!owned,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
    };
  }
  if (scrollGrid) document.querySelector('#missionDataGrid')?.scrollIntoView({ block: 'start', inline: 'nearest' });
  function fillerNow() {
    const filler = document.querySelector('#missionHorizonFiller');
    return filler ? filler.getBoundingClientRect() : null;
  }
  const rows = (selectors || []).map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { id: sel, missing: true, w: 0, h: 0, boxW: 0, boxH: 0, clipW: 0, clipH: 0, hitOk: false, hit: '', underFiller: false };
    const row = measure(el, !!scrollEach);
    row.underFiller = overlaps(row.rect, fillerNow());
    return row;
  });
  if (scrollGrid) document.querySelector('#missionDataGrid')?.scrollIntoView({ block: 'start', inline: 'nearest' });
  const tiles = [...document.querySelectorAll('.mission-data-tile')].map((el) => {
    const row = measure(el, false);
    row.underFiller = overlaps(row.rect, fillerNow());
    return row;
  });
  return {
    rows,
    tiles,
    scrollY: window.scrollY,
    pageH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
    filler: (() => {
      const live = fillerNow();
      return live ? { top: live.top, height: live.height, bottom: live.bottom } : null;
    })(),
  };
}

describe('flight instruments visible area', () => {
  let child;
  let browser;
  let page;

  beforeAll(async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT, HOST: '127.0.0.1', COMPANION_MODE: 'off' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#flightHud');
    await page.evaluate(() => {
      window.applySseTelemetryPayload = () => {};
      window.hydrateMissionHudFromLiveLink = () => {};
    });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    if (child && !child.killed) child.kill('SIGTERM');
  });

  async function paint(viewport, { banner, linked }) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(({ bannerOn, linkedOn }) => {
      window.applySseTelemetryPayload = () => {};
      const bannerEl = document.getElementById('appUpdateBanner');
      const text = document.getElementById('appUpdateBannerText');
      if (bannerEl) bannerEl.hidden = !bannerOn;
      if (text) text.textContent = bannerOn ? 'יש עדכון לקונסולה' : '';
      const ws = document.querySelector('.mission-workspace');
      if (ws) ws.dataset.askOpen = '0';
      applyFlightHud(linkedOn ? {
        connected: true,
        armedKnown: true,
        armed: false,
        flying: false,
        lastHeartbeatAgeMs: 100,
        landedState: 1,
        landedStateAgeMs: 100,
        flightMode: 5,
        airspeed: 12.4,
        altitude: 40,
        heading: 90,
        batteryV: 12.6,
        rollDeg: 1,
        pitchDeg: -2,
        autopilotName: 'ArduPilot',
        vehicleType: 'Fixed Wing',
      } : {
        connected: false,
        armedKnown: false,
        armed: null,
        flying: false,
        flightMode: null,
        airspeed: null,
        altitude: null,
        heading: null,
        batteryV: null,
        rollDeg: null,
        pitchDeg: null,
      });
    }, { bannerOn: banner, linkedOn: linked });
    await page.waitForTimeout(80);
  }

  function assertVisible(rows, label) {
    for (const row of rows) {
      expect(row.missing, label + ' ' + row.id).not.toBe(true);
      expect(row.h, `${label} ${row.id} visible h ${row.h} box ${row.boxH} hit ${row.hit}`).toBeGreaterThanOrEqual(8);
      expect(row.w, `${label} ${row.id} visible w`).toBeGreaterThanOrEqual(8);
      expect(row.h, `${label} ${row.id} clipped`).toBeGreaterThanOrEqual(row.boxH - 2);
      expect(row.hitOk, `${label} ${row.id} covered by ${row.hit}`).toBe(true);
      expect(row.underFiller, `${label} ${row.id} sits under the filler`).toBe(false);
    }
  }

  function assertTiles(tiles, label, { inViewport }) {
    expect(tiles.length, label).toBeGreaterThanOrEqual(6);
    for (const tile of tiles) {
      expect(tile.clipH, `${label} tile ${tile.id} inner clip h ${tile.clipH} box ${tile.boxH}`).toBeGreaterThanOrEqual(tile.boxH - 2);
      expect(tile.clipW, `${label} tile ${tile.id} inner clip w`).toBeGreaterThanOrEqual(tile.boxW - 2);
      expect(tile.underFiller, `${label} tile ${tile.id} sits under the filler`).toBe(false);
      if (inViewport) {
        expect(tile.h, `${label} tile ${tile.id} below the fold h ${tile.h} box ${tile.boxH}`).toBeGreaterThanOrEqual(tile.boxH - 2);
        expect(tile.w, `${label} tile ${tile.id} offscreen`).toBeGreaterThanOrEqual(tile.boxW - 2);
      }
    }
  }

  it('keeps core instruments fully visible at every viewport', async () => {
    for (const viewport of viewports) {
      for (const banner of [false, true]) {
        for (const linked of [false, true]) {
          await paint(viewport, { banner, linked });
          const phone = viewport.name === '360x740';
          const layout = await page.evaluate(layoutScript, {
            selectors: CORE.concat(['#pfdHorizonStage']),
            scrollEach: phone,
            scrollGrid: phone,
          });
          const label = `${viewport.name} banner=${banner} linked=${linked}`;
          assertVisible(layout.rows.filter((row) => row.id !== 'pfdHorizonStage'), label);
          assertTiles(layout.tiles, label, { inViewport: !phone });
          if (!phone) {
            expect(layout.scrollY, label).toBeLessThan(2);
          }
          if (viewport.name === '1024x576') {
            const stage = layout.rows.find((row) => row.id === 'pfdHorizonStage');
            expect(stage.h, label).toBeGreaterThanOrEqual(120);
            expect(layout.pageH, label).toBeLessThanOrEqual(layout.viewH + 4);
          }
          if (!linked) {
            const note = await page.locator('.mission-horizon-filler-note').innerText();
            expect(note).toBe('אין חיבור לבקר הטיסה');
            const badgeHidden = await page.locator('#pfdArmedBadge').evaluate((el) => el.hidden === true);
            expect(badgeHidden).toBe(true);
          } else {
            const note = await page.locator('.mission-horizon-filler-note').innerText();
            expect(note).toContain('בקר מחובר');
          }
        }
      }
    }
  }, 120000);

  it('does not press video without a stream, and readings stay above the toggles', async () => {
    for (const viewport of viewports) {
      await paint(viewport, { banner: true, linked: false });
      await page.click('#horizonVideoToggle');
      await page.waitForTimeout(50);
      const pressed = await page.locator('#horizonVideoToggle').getAttribute('aria-pressed');
      expect(pressed, viewport.name).toBe('false');
      const empty = await page.locator('#horizonVideoEmpty').evaluate((el) => ({
        text: el.textContent || '',
        shown: el.hidden !== true && getComputedStyle(el).display !== 'none',
      }));
      expect(empty.shown, viewport.name).toBe(true);
      expect(empty.text).toContain('אין זרם מצלמה');
      await page.click('#annotatedVisionToggle');
      const phone = viewport.name === '360x740';
      const layout = await page.evaluate(layoutScript, {
        selectors: ['#pfdAltVal', '#pfdAirspeedVal', '#hudAltitude'],
        scrollEach: phone,
        scrollGrid: false,
      });
      assertVisible(layout.rows, viewport.name + ' after vision');
      const covered = await page.evaluate(() => {
        const tile = document.querySelector('#hudAirspeed');
        const bar = document.querySelector('.pfd-bottom-bar');
        if (!tile || !bar) return true;
        const t = tile.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        const overlap = t.bottom > b.top + 1 && t.top < b.bottom - 1 && t.right > b.left && t.left < b.right;
        return overlap;
      });
      expect(covered, viewport.name).toBe(false);
    }
  }, 60000);

  it('Ask overlay at 1024 stays off the banner and its toggle', async () => {
    await paint({ name: '1024x576', width: 1024, height: 576 }, { banner: true, linked: false });
    await page.click('#missionAskToggleBtn');
    const cover = await page.evaluate(() => {
      const talk = document.querySelector('[data-mission-region="talk"]');
      const talkRect = talk.getBoundingClientRect();
      function overlaps(el) {
        const r = el.getBoundingClientRect();
        return talkRect.bottom > r.top + 1 && talkRect.top < r.bottom - 1 && talkRect.right > r.left + 1 && talkRect.left < r.right - 1;
      }
      function covered(el) {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || hit === talk || talk.contains(hit);
      }
      return {
        open: document.querySelector('.mission-workspace')?.dataset.askOpen,
        toggle: covered(document.getElementById('missionAskToggleBtn')),
        apply: covered(document.getElementById('appUpdateApplyBtn')),
        snooze: covered(document.getElementById('appUpdateSnoozeBtn')),
        toggleOverlap: overlaps(document.getElementById('missionAskToggleBtn')),
        applyOverlap: overlaps(document.getElementById('appUpdateApplyBtn')),
      };
    });
    expect(cover.open).toBe('1');
    expect(cover.toggle).toBe(false);
    expect(cover.apply).toBe(false);
    expect(cover.snooze).toBe(false);
    expect(cover.toggleOverlap).toBe(false);
    expect(cover.applyOverlap).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.mission-workspace')?.dataset.askOpen === '0');
    await page.click('#missionAskToggleBtn');
    await page.click('#missionAskCloseBtn');
    await page.waitForFunction(() => document.querySelector('.mission-workspace')?.dataset.askOpen === '0');
  }, 30000);
});
