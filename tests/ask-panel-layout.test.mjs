import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

function interiorsIntersect(a, b, slack = 1) {
  if (!a || !b || a.width < 2 || b.width < 2 || a.height < 2 || b.height < 2) return false;
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

describe('Ask panel layout', () => {
  it('keeps the coding-agent key out of the rail and hides the development tab', () => {
    const railStart = html.indexOf('<aside id="assistRail"');
    const rail = html.slice(railStart, html.indexOf('</aside>', railStart));
    expect(rail).not.toContain('id="assistAgentKey"');
    expect(rail).not.toContain('type="password"');
    expect(rail).toContain('פקודות קול ללא אישור');
    expect(rail).toContain('id="assistAgentSettingsLink"');
    expect(html).toMatch(/id="gsCodingAgent"[\s\S]*סוכן קוד/);
    expect(html).toMatch(/data-tab="development"[^>]*\bhidden\b/);
    expect(html).not.toContain('id="assistVoiceGoBtn"');
  });
});

describe('Ask panel — no control overlap', () => {
  const PORT = process.env.VLC_ASK_PANEL_PORT || '4023';
  const BASE = `http://127.0.0.1:${PORT}`;
  const shots = '/opt/cursor/artifacts/ask-panel';
  let serverProc = null;
  let browser = null;

  const viewports = [
    { name: '1024x576', width: 1024, height: 576 },
    { name: '1366x768', width: 1366, height: 768 },
    { name: '1440x900', width: 1440, height: 900 },
    { name: '360', width: 360, height: 640 },
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
    throw new Error('ask-panel server did not become healthy');
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

  async function measure(page) {
    return page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          display: cs.display,
          visibility: cs.visibility,
        };
      };
      const chips = [...document.querySelectorAll('#assistQuickChips .assist-quick-chip')]
        .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
        .map(box);
      const key = document.getElementById('assistAgentKey');
      const rail = document.getElementById('assistRail');
      const keyInRail = !!(key && rail && rail.contains(key));
      return {
        input: box(document.getElementById('assistInput')),
        send: box(document.getElementById('assistSendBtn')),
        mic: box(document.getElementById('assistMicBtn')),
        form: box(document.getElementById('assistForm')),
        composer: box(document.querySelector('.assist-composer')),
        toggle: box(document.getElementById('assistVoiceGoToggle')),
        floatBtn: box(document.getElementById('assistToggleBtn')),
        devTab: box(document.querySelector('[data-tab="development"]')),
        key: box(key),
        offline: box(document.getElementById('assistAgentSettingsLink')),
        chips,
        keyInRail,
        modalHidden: document.getElementById('globalSettingsModal')?.hidden === true,
      };
    });
  }

  function assertNoOverlap(measured, label) {
    const { input, send, mic, form, composer, toggle, floatBtn, chips } = measured;
    expect(interiorsIntersect(input, send), `${label} send overlaps input`).toBe(false);
    expect(interiorsIntersect(input, mic), `${label} mic overlaps input`).toBe(false);
    expect(interiorsIntersect(send, mic), `${label} send overlaps mic`).toBe(false);
    expect(input.width, `${label} input width`).toBeGreaterThan(80);
    expect(send.right, `${label} send inside form`).toBeLessThanOrEqual(form.right + 1);
    expect(send.left, `${label} send inside form`).toBeGreaterThanOrEqual(form.left - 1);
    expect(mic.left, `${label} mic inside form`).toBeGreaterThanOrEqual(form.left - 1);
    expect(input.bottom, `${label} input inside composer`).toBeLessThanOrEqual(composer.bottom + 1);
    expect(toggle.width, `${label} voice toggle`).toBeGreaterThan(40);
    if (floatBtn && floatBtn.display !== 'none' && floatBtn.visibility !== 'hidden' && floatBtn.width > 2) {
      expect(interiorsIntersect(floatBtn, composer), `${label} float covers composer`).toBe(false);
      expect(interiorsIntersect(floatBtn, form), `${label} float covers form`).toBe(false);
    }
    for (let i = 0; i < chips.length; i += 1) {
      expect(interiorsIntersect(chips[i], input), `${label} chip overlaps input`).toBe(false);
      expect(interiorsIntersect(chips[i], send), `${label} chip overlaps send`).toBe(false);
      for (let j = i + 1; j < chips.length; j += 1) {
        expect(interiorsIntersect(chips[i], chips[j]), `${label} chips overlap`).toBe(false);
      }
    }
  }

  it('keeps Ask controls from overlapping at the layout viewports', async () => {
    for (const vp of viewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#assistVoiceGoToggle', { state: 'visible' });
      await page.waitForTimeout(200);
      const measured = await measure(page);
      expect(measured.keyInRail, vp.name).toBe(false);
      expect(measured.modalHidden, vp.name).toBe(true);
      expect(measured.key?.display === 'none' || measured.modalHidden, vp.name).toBe(true);
      expect(measured.devTab?.display, vp.name).toBe('none');
      expect(measured.offline?.width || 0, vp.name).toBeGreaterThan(0);
      assertNoOverlap(measured, vp.name);
      if (vp.name !== '1366x768') {
        await page.screenshot({ path: path.join(shots, `after-${vp.name}.png`), type: 'png' });
      }
      await page.close();
    }
  }, 60000);

  it('toggles voice commands without changing the safety lock, and opens the key only in settings', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const sessionReady = page.waitForResponse((r) => r.url().includes('/api/assist/session') && r.ok());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#assistVoiceGoToggle', { state: 'visible' });
    await sessionReady;
    expect(await page.locator('#assistVoiceGoToggle').getAttribute('aria-pressed')).toBe('false');
    expect(await page.locator('#assistVoiceGoHint').isHidden()).toBe(true);
    await page.click('#assistVoiceGoInfo');
    const hintText = await page.locator('#assistVoiceGoHint').innerText();
    expect(hintText).toContain('חימוש ונטרול חסומים');
    expect(hintText).toContain('פרמטר דורש אישור');
    const goOn = page.waitForResponse((r) => r.url().includes('/api/assist/voice-go') && r.ok());
    await page.click('#assistVoiceGoToggle');
    const onBody = await (await goOn).json();
    expect(onBody.ask_voice_go_active).toBe(true);
    expect(onBody.ask_voice_safety_lock).toBe('voice_session_go');
    expect(await page.locator('#assistVoiceGoToggle').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#assistVoiceGoBadge').innerText()).toBe('פעיל');
    const session = await page.evaluate(async () => {
      const r = await fetch('/api/assist/session');
      return r.json();
    });
    expect(session.ask_voice_go_active).toBe(true);
    expect(session.ask_voice_safety_lock).toBe('voice_session_go');
    const goOff = page.waitForResponse((r) => r.url().includes('/api/assist/voice-go') && r.ok());
    await page.click('#assistVoiceGoToggle');
    expect((await (await goOff).json()).ask_voice_go_active).toBe(false);
    expect(await page.locator('#assistVoiceGoBadge').innerText()).toBe('כבוי');
    await page.click('#assistAgentSettingsLink');
    expect(await page.locator('#globalSettingsModal').isVisible()).toBe(true);
    expect(await page.locator('#gsCodingAgent').innerText()).toContain('סוכן קוד');
    expect(await page.locator('#assistAgentKey').isVisible()).toBe(true);
    expect(await page.locator('#assistAgentKey').getAttribute('type')).toBe('password');
    const railHasKey = await page.evaluate(() => {
      const rail = document.getElementById('assistRail');
      return !!rail?.querySelector('#assistAgentKey');
    });
    expect(railHasKey).toBe(false);
    await page.screenshot({ path: path.join(shots, 'after-settings-1440x900.png'), type: 'png' });
    await page.close();
  }, 30000);
});
