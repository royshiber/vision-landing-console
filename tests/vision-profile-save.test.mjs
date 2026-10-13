/**
 * Vision landing profile values live on the console. A slider marks the card
 * and does not change the stored value until שמירת פרופיל reads the save back.
 * An FC read leaves those cards alone.
 */
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './test-server.mjs';

const SIZES = [[360, 640], [360, 800], [1024, 470], [1366, 630], [1536, 730]];

function controlTextFit() {
  const root = document.getElementById('control');
  const fails = [];
  if (!root) return fails;
  root.querySelectorAll('*').forEach((el) => {
    if (el.closest('[hidden]')) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)') return;
    if (el.clientWidth < 2 || el.clientHeight < 2) return;
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const fontPx = Number.parseFloat(style.fontSize) || 0;
    const who = el.id ? `#${el.id}` : String(el.className || el.tagName).slice(0, 40);
    if (fontPx < 10.5) fails.push({ who, reason: 'small', text: text.slice(0, 40), fontPx });
    if (el.clientWidth >= 1 && el.scrollWidth - el.clientWidth > 1) {
      fails.push({ who, reason: 'width', text: text.slice(0, 40), sw: el.scrollWidth, cw: el.clientWidth });
    }
    if (el.clientHeight >= 1 && el.scrollHeight - el.clientHeight > 1) {
      fails.push({ who, reason: 'height', text: text.slice(0, 40), sh: el.scrollHeight, ch: el.clientHeight });
    }
  });
  return fails.slice(0, 8);
}

describe('vision profile save', () => {
  let proc = null;
  let browser = null;
  let base = '';

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('marks an unsaved slider, saves the profile with read-back, and keeps an FC read off the cards', async () => {
    const dbPath = path.join(os.tmpdir(), `airvix-profile-save-${process.pid}.sqlite`);
    const started = await startTestServer({
      env: {
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        GEMINI_API_KEY: '',
      },
    });
    proc = started.child;
    base = started.base;
    const seed = await fetch(`${base}/api/vision/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { motor_hold_s: 6.3 } }),
    });
    expect(seed.ok).toBe(true);

    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      try { localStorage.removeItem('visionLandingProfile'); } catch { /* ignore */ }
    });
    await page.route(/\/api\/ardu\/params\/read$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          connected: true,
          mavlinkConnected: true,
          armed: false,
          paramCount: 1,
          current: { LAND_SPEED: 50 },
        }),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="control"]');
    await page.waitForFunction(() => document.getElementById('rng_motor_hold_s')?.value === '6.3');

    const before = await (await fetch(`${base}/api/vision/config`)).json();
    expect(before.profile.motor_hold_s).toBe(6.3);
    await page.locator('#rng_motor_hold_s').fill('0.8');
    await page.waitForFunction(() => document.querySelector('[data-param-key="motor_hold_s"]')?.classList.contains('param-card--dirty'));
    const held = await (await fetch(`${base}/api/vision/config`)).json();
    expect(held.profile.motor_hold_s).toBe(6.3);
    const card = page.locator('[data-param-key="motor_hold_s"]');
    expect(await card.locator('.param-card-dirty').innerText()).toBe('לא נשמר — 0.8 (שמור: 6.3)');
    expect(await card.locator('.param-card-save').innerText()).toBe('שמירה');
    expect(await card.locator('.param-card-cancel').innerText()).toBe('ביטול');
    expect(await page.locator('#arduWriteBtn').isDisabled()).toBe(true);
    expect(await page.locator('#jetsonToolState').innerText()).toBe('שינוי לא נשמר (1)');

    await page.setViewportSize({ width: 360, height: 640 });
    await page.locator('#jetsonToolState').click();
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-param-key="motor_hold_s"]')?.getBoundingClientRect();
      return box && box.top >= 0 && box.bottom <= window.innerHeight + 1;
    });

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.click('#visionConfigReadBtn');
    expect(await page.locator('#rng_motor_hold_s').inputValue()).toBe('0.8');

    const leave = new Promise((resolve) => page.once('dialog', (dialog) => {
      resolve(dialog.message());
      dialog.dismiss();
    }));
    await page.click('[data-tab="pulse"]');
    expect(await leave).toContain('לא נשמר');
    expect(await page.locator('#control').evaluate((el) => el.classList.contains('visible'))).toBe(true);
    const blocked = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(blocked).toBe(true);

    await page.locator('.param-card-save').click();
    await page.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('נשמר בקונסולה ואומת'));
    const result = await page.locator('#paramWriteResult').innerText();
    expect(result).toContain('נשמר בקונסולה ואומת');
    expect(result).not.toContain('נכתב לבקר ואומת');
    const saved = await (await fetch(`${base}/api/vision/config`)).json();
    expect(saved.profile.motor_hold_s).toBe(0.8);
    expect(await card.evaluate((el) => el.classList.contains('param-card--dirty'))).toBe(false);

    await page.locator('#rng_motor_hold_s').fill('1.2');
    await page.waitForFunction(() => document.querySelector('[data-param-key="motor_hold_s"]')?.classList.contains('param-card--dirty'));
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => document.querySelector('[data-param-key="motor_hold_s"] .param-card-fc-note')?.textContent === 'ערך קונסולה — לא נקרא מהבקר');
    expect(await page.locator('#rng_motor_hold_s').inputValue()).toBe('1.2');
    const afterRead = await (await fetch(`${base}/api/vision/config`)).json();
    expect(afterRead.profile.motor_hold_s).toBe(0.8);
    expect(await card.locator('.param-card-dirty').innerText()).toContain('שמור: 0.8');

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      const fails = await page.evaluate(controlTextFit);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(fails, `${width}x${height}`).toEqual([]);
      expect(overflow, `${width}x${height}`).toBeLessThanOrEqual(1);
    }
  }, 60000);
});
