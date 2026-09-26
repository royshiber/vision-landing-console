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

function visibleScript(selectors) {
  function visibleOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    let left = Math.max(r.left, 0);
    let top = Math.max(r.top, 0);
    let right = Math.min(r.right, window.innerWidth);
    let bottom = Math.min(r.bottom, window.innerHeight);
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
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const inView = cx >= left && cx <= right && cy >= top && cy <= bottom;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    const owned = hit && (hit === el || el.contains(hit) || el.closest('.pfd-horizon-instrument') === hit || el.closest('.mission-data-tile') === hit || el.closest('.pfd-bottom-bar') === hit || el.closest('.pfd-top-bar') === hit || el.parentElement === hit);
    const hitOk = !!owned;
    return {
      id: el.id,
      boxW: r.width,
      boxH: r.height,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top),
      hit: hit ? (hit.id || hit.className || hit.tagName) : '',
      hitOk,
    };
  }
  return selectors.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { id: sel, missing: true, w: 0, h: 0, boxW: 0, boxH: 0, hitOk: false, hit: '' };
    return visibleOf(el);
  });
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
    }
  }

  it('keeps core instruments fully visible at every viewport', async () => {
    for (const viewport of viewports) {
      for (const banner of [false, true]) {
        for (const linked of [false, true]) {
          await paint(viewport, { banner, linked });
          const rows = await page.evaluate(visibleScript, CORE);
          const label = `${viewport.name} banner=${banner} linked=${linked}`;
          assertVisible(rows, label);
          if (viewport.name === '1024x576') {
            const stage = await page.evaluate(visibleScript, ['#pfdHorizonStage']);
            expect(stage[0].h, label).toBeGreaterThanOrEqual(120);
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
      const rows = await page.evaluate(visibleScript, ['#pfdAltVal', '#pfdAirspeedVal', '#hudAltitude']);
      assertVisible(rows, viewport.name + ' after vision');
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
});
