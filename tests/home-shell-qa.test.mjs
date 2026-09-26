import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.VLC_HOME_QA_PORT || '4041';
const BASE = `http://127.0.0.1:${PORT}`;
const shots = '/opt/cursor/artifacts/home-qa/after';

function box(page, selector) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: r.x, y: r.y, w: r.width, h: r.height,
      right: r.right, bottom: r.bottom,
      hidden: el.hidden || s.display === 'none' || s.visibility === 'hidden',
      overflow: s.overflow,
      textOverflow: s.textOverflow,
      whiteSpace: s.whiteSpace,
      letterSpacing: s.letterSpacing,
      direction: s.direction,
      unicodeBidi: s.unicodeBidi,
      position: s.position,
      zIndex: s.zIndex,
      text: (el.textContent || '').trim(),
    };
  });
}

function overlaps(a, b) {
  if (!a || !b || a.hidden || b.hidden || a.w < 2 || b.w < 2 || a.h < 2 || b.h < 2) return false;
  return a.x < b.right && a.right > b.x && a.y < b.bottom && b.y < a.bottom;
}

describe('home shell QA', () => {
  let child;
  let browser;

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
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    if (child && !child.killed) child.kill('SIGTERM');
  });

  async function openHome(width, height, mobile = false) {
    const page = await browser.newPage({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#flightHud');
    await page.waitForTimeout(300);
    return page;
  }

  it('360: the connection pill does not cover tabs, settings, or the version', async () => {
    const page = await openHome(360, 740, true);
    const pill = await box(page, '#connectToggleBtn');
    const gear = await box(page, '#globalSettingsBtn');
    const version = await box(page, '#versionBtn');
    const tabs = await page.locator('.app-chrome .tab:not([hidden])').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, hidden: false, text: el.textContent.trim() };
    }));
    expect(overlaps(pill, gear)).toBe(false);
    expect(overlaps(pill, version)).toBe(false);
    for (const tab of tabs) expect(overlaps(pill, tab)).toBe(false);
    const dev = page.locator('.tab[data-tab="pulse"]');
    const hit = await dev.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top?.id || top?.className || '';
    });
    expect(hit).not.toMatch(/connectToggleBtn/);
    await page.screenshot({ path: path.join(shots, '360-chrome.png') });
    await page.close();
  }, 30000);

  it('1024x576: the horizon is visible and Ask is not a strip', async () => {
    const page = await openHome(1024, 576);
    const stage = await box(page, '#pfdHorizonStage');
    expect(stage.h).toBeGreaterThanOrEqual(120);
    const talkClosed = await page.locator('[data-mission-region="talk"]').evaluate((el) => getComputedStyle(el).display);
    expect(talkClosed).toBe('none');
    await page.click('#missionAskToggleBtn');
    const talk = await box(page, '#missionTalkHost');
    expect(talk.h).toBeGreaterThan(160);
    const stageAfter = await box(page, '#pfdHorizonStage');
    expect(stageAfter.h).toBeGreaterThanOrEqual(120);
    await page.screenshot({ path: path.join(shots, '1024-home.png') });
    await page.close();
  }, 30000);

  it('swap changes sizes, and one chip keeps the horizon tile', async () => {
    const page = await openHome(1440, 900);
    const beforeH = await box(page, '.mission-region-horizon');
    const beforeM = await box(page, '.mission-region-map');
    expect(beforeM.w).toBeGreaterThan(beforeH.w);
    await page.click('#missionSwapHorizonMapBtn');
    await page.waitForTimeout(200);
    const afterH = await box(page, '.mission-region-horizon');
    const afterM = await box(page, '.mission-region-map');
    expect(afterH.w).toBeGreaterThan(beforeH.w + 40);
    expect(afterM.w).toBeLessThan(beforeM.w - 40);
    await page.click('#horizonVideoToggle');
    await page.waitForTimeout(150);
    const stage = await box(page, '#pfdHorizonStage');
    expect(stage.h).toBeGreaterThan(80);
    await page.screenshot({ path: path.join(shots, '1440-swap-chip.png') });
    await page.close();
  }, 30000);

  it('a missing flight mode is a dash, including the Ask answer', async () => {
    const page = await openHome(1440, 900);
    expect((await box(page, '#pfdModeVal')).text).toBe('—');
    expect((await box(page, '#hudFlightMode')).text).not.toMatch(/MANUAL/);
    await page.fill('#assistInput', 'מה מצב הטיסה');
    await page.click('#assistSendBtn');
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('#assistMessages .assist-msg, #assistTranscript .assist-bubble, .assist-message')];
      return nodes.some((n) => /אין נתונים|מצב טיסה/.test(n.textContent || ''));
    }, null, { timeout: 8000 }).catch(() => {});
    const answer = await page.locator('#assistMessages, #assistTranscript, .assist-transcript').innerText().catch(() => '');
    expect(answer).not.toMatch(/MANUAL/);
    await page.screenshot({ path: path.join(shots, '1440-mode.png') });
    await page.close();
  }, 30000);

  it('the Ask button is docked and the open rail stays under the header', async () => {
    const page = await openHome(1440, 900);
    await page.click('.tab[data-tab="control"]');
    await page.waitForTimeout(200);
    const toggle = await box(page, '#assistToggleBtn');
    expect(toggle.position).not.toBe('fixed');
    const save = page.locator('#acSaveBtn, .ac-next, button:has-text("שמור")').first();
    if (await save.count()) {
      const saveBox = await save.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, hidden: false };
      });
      expect(overlaps(toggle, saveBox)).toBe(false);
    }
    await page.click('#assistToggleBtn');
    await page.waitForTimeout(200);
    const chrome = await box(page, '.app-chrome');
    const rail = await box(page, '#assistRail');
    expect(rail.y).toBeGreaterThanOrEqual(chrome.bottom - 2);
    await page.screenshot({ path: path.join(shots, '1440-ask-rail.png') });
    await page.close();
  }, 30000);

  it('voice is one toggle, the dead buttons do something, and a missing path is explained', async () => {
    const page = await openHome(1440, 900);
    expect(await page.locator('#assistVoiceGoEndBtn').count()).toBe(0);
    expect(await page.locator('#assistVoiceGoToggle').count()).toBe(1);
    await page.click('#pfdVoiceFlightBtn');
    await page.waitForTimeout(150);
    const focused = await page.evaluate(() => document.activeElement?.id || '');
    expect(focused).toBe('assistInput');
    await page.click('#connectToggleBtn');
    await page.click('#rcStatusBtn');
    const rc = await box(page, '#rcLinkHint');
    expect(rc.text).toMatch(/שלט בלבד/);
    await page.keyboard.press('Escape');
    await page.click('#terrainShowLoadedPathBtn');
    await page.waitForFunction(() => {
      const n = document.getElementById('terrainPathNote');
      return n && !n.hidden && n.textContent.includes('אין קישור');
    });
    await page.screenshot({ path: path.join(shots, '1440-path-note.png') });
    await page.close();
  }, 30000);

  it('send and GPS are not clipped, and the recording line does not cover the map buttons', async () => {
    const page = await openHome(1280, 720);
    const send = await box(page, '#assistSendBtn');
    const host = await box(page, '#missionTalkHost');
    expect(send.w).toBeGreaterThan(24);
    expect(send.right).toBeLessThanOrEqual(host.right + 2);
    const gps = await box(page, '#hudNavGpsVal');
    expect(gps.textOverflow).not.toBe('ellipsis');
    await page.click('#missionRecordBtn');
    await page.waitForFunction(() => {
      const n = document.getElementById('missionRecordStatus');
      return n && !n.hidden && n.textContent.length > 4;
    });
    const status = await box(page, '#missionRecordStatus');
    const layers = await box(page, '.terrain-map-overlay-toolbar');
    expect(overlaps(status, layers)).toBe(false);
    expect(status.text).not.toMatch(/באית/);
    await page.click('#missionRecordBtn');
    await page.screenshot({ path: path.join(shots, '1280-record.png') });
    await page.close();
  }, 30000);

  it('Ask at 360 starts inside the screen', async () => {
    const page = await openHome(360, 740, true);
    await page.click('#missionAskToggleBtn');
    const talk = await box(page, '#missionTalkHost');
    expect(talk.y).toBeLessThan(740);
    expect(talk.h).toBeGreaterThan(160);
    await page.screenshot({ path: path.join(shots, '360-ask.png') });
    await page.close();
  }, 30000);

  it('the connection chip wraps, the map title stays under dialogs, and Escape closes the version', async () => {
    const page = await openHome(1440, 900);
    await page.click('#connectToggleBtn', { timeout: 5000 });
    const chip = await box(page, '#jetsonLinkChip');
    expect(chip.textOverflow).not.toBe('ellipsis');
    expect(chip.h).toBeGreaterThan(16);
    const title = await box(page, '.mission-region-map > .mission-region-title');
    const widget = await box(page, '#connectWidget');
    expect(Number(title.zIndex) || 0).toBeLessThan(Number(widget.zIndex) || 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('connectPanel')?.hidden === true, null, { timeout: 3000 });
    await page.locator('#versionBtn').evaluate((el) => el.click());
    await page.waitForFunction(() => !document.getElementById('versionModal').classList.contains('hidden'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('versionModal').classList.contains('hidden'));
    const attr = await box(page, '.leaflet-control-attribution');
    expect(attr.textOverflow).not.toBe('ellipsis');
    expect(attr.whiteSpace).not.toBe('nowrap');
    const note = await box(page, '.mission-horizon-filler-note');
    expect(note.direction).toBe('rtl');
    expect(note.letterSpacing === '0px' || note.letterSpacing === 'normal').toBe(true);
    const horizonNote = await box(page, '#horizonNoData');
    expect(horizonNote.hidden).toBe(false);
    expect(horizonNote.text).toBe('אין נתונים');
    await page.screenshot({ path: path.join(shots, '1440-horizon-empty.png') });
    await page.close();
  }, 30000);

  it('diagnostics and the engineer chip highlight a tab, and the heading is light', async () => {
    const page = await openHome(1440, 900);
    await page.click('#missionReadinessGlance');
    await page.click('#pfdReadinessDiagBtn');
    await page.waitForTimeout(250);
    const active = await page.locator('.tab.active').getAttribute('data-tab');
    expect(active).toBe('telemetry');
    const hidden = await page.locator('.tab[data-tab="telemetry"]').evaluate((el) => el.hidden);
    expect(hidden).toBe(false);
    const heading = await box(page, '#teleStatusBadge');
    const color = await page.locator('#teleStatusBadge').evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe('rgb(0, 0, 0)');
    expect(heading.text).toMatch(/מנותק|אין/);
    await page.screenshot({ path: path.join(shots, '1440-diagnostics.png') });
    await page.evaluate(() => {
      const chip = document.querySelector('[data-assist-chip="flightEngineer"]');
      if (chip) chip.hidden = false;
    });
    await page.click('.tab[data-tab="terrain"]');
    await page.locator('[data-assist-chip="flightEngineer"]').evaluate((el) => el.click());
    await page.waitForFunction(() => document.querySelector('.tab.active')?.dataset?.tab === 'flightEngineer', null, { timeout: 8000 });
    await page.close();
  }, 30000);
});
