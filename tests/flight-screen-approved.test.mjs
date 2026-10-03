import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_VERSION } from '../version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.VLC_FLIGHT_SCREEN_PORT || '4071';
const BASE = `http://127.0.0.1:${PORT}`;
const shots = '/opt/cursor/artifacts';

function shown(page, selector) {
  return page.locator(selector).evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden && r.width > 2 && r.height > 2;
  });
}

describe('approved flight screen', () => {
  let child;
  let browser;
  let page;

  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    child = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT, HOST: '127.0.0.1', COMPANION_MODE: 'off' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#horizonCanvas');
  }, 40000);

  afterAll(async () => {
    await browser?.close();
    if (child) child.kill('SIGTERM');
  });

  it('matches the approved column: square horizon, ASK, and no extra horizon buttons', async () => {
    const face = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      };
      const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && !el.hidden && r.width > 2 && r.height > 2;
      };
      const hud = document.getElementById('flightHud');
      const hudBox = box(hud);
      return {
        ratio: hudBox.w / hudBox.h,
        version: document.querySelector('meta[name="app-version"]')?.content || '',
        ias: visible(document.querySelector('.pfd-side-tape--left')),
        alt: visible(document.querySelector('.pfd-side-tape--right')),
        hdg: visible(document.querySelector('.pfd-heading-lane')),
        video: visible(document.getElementById('horizonVideoToggle')),
        vision: visible(document.getElementById('annotatedVisionToggle')),
        frame: visible(document.getElementById('liveCameraToggle')),
        points: visible(document.getElementById('horizonPointsToggle')),
        arm: visible(document.getElementById('flightArmBtn')),
        disarm: visible(document.getElementById('flightDisarmBtn')),
        askData: visible(document.getElementById('missionAskDataBtn')),
        iasText: (document.getElementById('pfdAirspeedVal')?.textContent || '').trim(),
        altText: (document.getElementById('pfdAltVal')?.textContent || '').trim(),
        hdgText: (document.getElementById('pfdHdgVal')?.textContent || '').trim(),
        noteHidden: document.getElementById('horizonNoData')?.hidden === true,
        noteText: (document.getElementById('horizonNoData')?.textContent || '').trim(),
        mic: (document.getElementById('assistMicBtn')?.innerText || '').replace(/\s+/g, ' ').trim(),
        input: getComputedStyle(document.getElementById('assistInput')).display,
        rtl: visible(document.getElementById('flightDockModeRtl')),
        loiter: visible(document.getElementById('flightDockModeLoiter')),
        auto: visible(document.getElementById('flightDockModeAuto')),
        gimbalBtn: visible(document.getElementById('mapGimbalScreenBtn')),
        close: document.getElementById('gimbalScreenClose')?.textContent?.trim() || '',
      };
    });
    expect(face.version).toBe(APP_VERSION);
    expect(face.ratio).toBeGreaterThan(0.82);
    expect(face.ratio).toBeLessThan(1.22);
    expect(face.ias).toBe(true);
    expect(face.alt).toBe(true);
    expect(face.hdg).toBe(true);
    expect(face.iasText).toBe('—');
    expect(face.altText).toBe('—');
    expect(face.hdgText).toBe('—');
    expect(face.noteHidden).toBe(false);
    expect(face.noteText).toBe('אין נתונים');
    expect(face.video).toBe(false);
    expect(face.vision).toBe(false);
    expect(face.frame).toBe(false);
    expect(face.points).toBe(false);
    expect(face.arm).toBe(false);
    expect(face.disarm).toBe(false);
    expect(face.askData).toBe(false);
    expect(face.mic).toContain('האזינו');
    expect(face.input).toBe('none');
    expect(face.rtl).toBe(false);
    expect(face.loiter).toBe(false);
    expect(face.auto).toBe(false);
    expect(face.gimbalBtn).toBe(false);
    expect(face.close).toBe('סגרו');
    await page.screenshot({ path: path.join(shots, 'flight-screen.png') });
    await page.locator('#flightHud').screenshot({ path: path.join(shots, 'flight-horizon.png') });
  }, 20000);

  it('opens communications from תקשור and a single-link menu with dashes when there is no reading', async () => {
    const tabs = await page.locator('nav.tabs > .tab:not([hidden])').allInnerTexts();
    expect(tabs.map((text) => text.trim())).toEqual(['הטסה', 'סטטוס מחשבים', 'פרמטרים', 'אופטיקה', 'תחקור', 'תקשור']);
    await page.click('#flightCommTab');
    await page.waitForSelector('#flightCommMenu:not([hidden])');
    expect(await page.locator('#flightCommTab').getAttribute('aria-pressed')).toBe('true');
    const comm = await page.evaluate(() => ({
      state: document.getElementById('flightCommState').textContent,
      strength: document.getElementById('flightCommStrength').textContent,
      quality: document.getElementById('flightCommQuality').textContent,
      delay: document.getElementById('flightCommDelay').textContent,
      action: document.getElementById('flightCommAction').textContent,
    }));
    expect(comm.strength).toBe('—');
    expect(comm.quality).toBe('—');
    expect(comm.delay).toBe('—');
    expect(comm.state.length).toBeGreaterThan(0);
    expect(comm.action).toMatch(/התחברו|התנתקו/);
    expect(comm.action).not.toContain('הציגו');
    await page.screenshot({ path: path.join(shots, 'flight-comm-menu.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('flightCommMenu').hidden === true);

    await page.locator('#missionLinkStrip .mission-link-chip[data-link="cellular"]').click({ button: 'right' });
    await page.waitForSelector('#flightLinkMenu:not([hidden])');
    const link = await page.evaluate(() => ({
      strength: document.getElementById('flightLinkStrength').textContent,
      quality: document.getElementById('flightLinkQuality').textContent,
      delay: document.getElementById('flightLinkDelay').textContent,
      action: document.getElementById('flightLinkAction').textContent,
      hiddenComm: document.getElementById('flightCommMenu').hidden,
    }));
    expect(link.strength).toBe('—');
    expect(link.quality).toBe('—');
    expect(link.delay).toBe('—');
    expect(link.action).toMatch(/התחברו|התנתקו/);
    expect(link.action).not.toContain('הציגו');
    expect(link.hiddenComm).toBe(true);
    await page.screenshot({ path: path.join(shots, 'flight-link-menu.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('flightLinkMenu').hidden === true);

    await page.locator('#missionLinkStrip .mission-link-chip[data-link="rc"]').click({ button: 'right' });
    await page.waitForSelector('#flightLinkMenu:not([hidden])');
    const rc = await page.evaluate(() => document.getElementById('flightLinkAction').textContent.trim());
    expect(rc).toBe('התחברו');
    expect(rc).not.toContain('הציגו');
    await page.locator('#flightLinkMenu').screenshot({ path: path.join(shots, 'flight-rc-menu.png') });
    await page.locator('#flightLinkAction').evaluate((el) => el.click());
    await page.waitForFunction(() => document.getElementById('flightLinkAction').textContent.trim() === 'התחברו'
      || document.getElementById('flightLinkAction').textContent.trim() === 'התנתקו');
    const after = await page.evaluate(() => document.getElementById('flightLinkAction').textContent.trim());
    expect(after).toMatch(/התחברו|התנתקו/);
    expect(after).not.toContain('הציגו');
  }, 20000);

  it('keeps horizon tapes as dashes when a dead snapshot still carries numbers', async () => {
    const dead = await page.evaluate(() => {
      applyFlightHud({
        connected: false,
        listening: false,
        heartbeatCount: 0,
        airspeed: 18.4,
        altitude: 120.5,
        heading: 42,
        rollDeg: null,
        pitchDeg: null,
      });
      return {
        ias: document.getElementById('pfdAirspeedVal').textContent.trim(),
        alt: document.getElementById('pfdAltVal').textContent.trim(),
        hdg: document.getElementById('pfdHdgVal').textContent.trim(),
        noteHidden: document.getElementById('horizonNoData').hidden,
        noteText: document.getElementById('horizonNoData').textContent.trim(),
      };
    });
    expect(dead.ias).toBe('—');
    expect(dead.alt).toBe('—');
    expect(dead.hdg).toBe('—');
    expect(dead.noteHidden).toBe(false);
    expect(dead.noteText).toBe('אין נתונים');

    const live = await page.evaluate(() => {
      applyFlightHud({
        connected: true,
        heartbeatCount: 2,
        airspeed: 18.4,
        altitude: 120.5,
        heading: 42,
        rollDeg: null,
        pitchDeg: null,
      });
      const withNumbers = {
        ias: document.getElementById('pfdAirspeedVal').textContent.trim(),
        alt: document.getElementById('pfdAltVal').textContent.trim(),
        hdg: document.getElementById('pfdHdgVal').textContent.trim(),
        noteHidden: document.getElementById('horizonNoData').hidden,
      };
      applyFlightHud({
        connected: false,
        listening: false,
        heartbeatCount: 0,
        airspeed: 18.4,
        altitude: 120.5,
        heading: 42,
        rollDeg: null,
        pitchDeg: null,
      });
      return withNumbers;
    });
    expect(live.ias).toBe('18.4');
    expect(live.alt).toBe('120.5');
    expect(live.hdg).toBe('42°');
    expect(live.noteHidden).toBe(true);
    const restored = await page.evaluate(() => ({
      ias: document.getElementById('pfdAirspeedVal').textContent.trim(),
      noteHidden: document.getElementById('horizonNoData').hidden,
    }));
    expect(restored.ias).toBe('—');
    expect(restored.noteHidden).toBe(false);
  }, 20000);

  it('keeps flight modes in the actions tab and horizon actions in the horizon menu', async () => {
    await page.keyboard.press('Escape');
    await page.click('#flightDockActionsTab');
    expect(await shown(page, '#flightDockModeRtl')).toBe(true);
    expect(await shown(page, '#flightDockModeLoiter')).toBe(true);
    expect(await shown(page, '#flightDockModeAuto')).toBe(true);
    await page.click('#flightDockMessagesTab');
    expect(await shown(page, '#flightDockModeRtl')).toBe(false);

    await page.locator('#pfdHorizonStage').click({ button: 'right' });
    await page.waitForSelector('#horizonCameraMenu:not([hidden])');
    const menu = await page.evaluate(() => {
      const root = document.getElementById('horizonCameraMenu');
      const text = root.innerText;
      return {
        video: !!root.querySelector('#horizonVideoToggle'),
        vision: !!root.querySelector('#annotatedVisionToggle'),
        frame: !!root.querySelector('#liveCameraToggle'),
        points: !!root.querySelector('#horizonPointsToggle'),
        arm: !!root.querySelector('#flightArmBtn'),
        text,
      };
    });
    expect(menu.video).toBe(true);
    expect(menu.vision).toBe(true);
    expect(menu.frame).toBe(true);
    expect(menu.points).toBe(true);
    expect(menu.arm).toBe(true);
    expect(menu.text).not.toMatch(/\bRTL\b|\bLOITER\b|\bAUTO\b/);
    await page.locator('#horizonCameraMenu').screenshot({ path: path.join(shots, 'flight-horizon-menu.png') });
  }, 20000);
});
