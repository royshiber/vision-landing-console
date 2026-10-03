import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { clampGimbalWindowSize, gimbalCornerFromPoint } from '../public/modules/gimbal-screen.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4068';
const BASE = `http://127.0.0.1:${PORT}`;

describe('gimbal window size', () => {
  it('uses plural imperatives on the window controls', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
    const start = html.indexOf('id="gimbalScreen"');
    const end = html.indexOf('mission-region-talk', start);
    const win = html.slice(start, end);
    expect(win).toContain('>סגרו</button>');
    expect(win).not.toContain('>סגור</button>');
    expect(win).toContain('>דברו</button>');
    expect(win).toContain('>שלחו</button>');
    expect(win).toContain('שנו גודל');
    expect(win).toContain('הזינו פקודה');
    expect(win).toContain('גררו לפינה');
  });

  it('keeps the default corner small against the map', () => {
    const map = { left: 0, top: 0, width: 900, height: 700 };
    expect(gimbalCornerFromPoint(40, 680, map)).toBe('bl');
    expect(gimbalCornerFromPoint(860, 40, map)).toBe('tr');
    const size = clampGimbalWindowSize(280, 324, map.width, map.height);
    expect(size.width).toBeLessThan(map.width * 0.5);
    expect(size.height).toBeLessThan(map.height * 0.5);
    const grown = clampGimbalWindowSize(360, 380, map.width, map.height);
    expect(grown.width).toBeGreaterThan(size.width);
    expect(grown.height).toBeGreaterThan(size.height);
    expect(grown.width).toBeLessThan(map.width);
    expect(grown.height).toBeLessThan(map.height);
  });
});

describe('gimbal window on the map', () => {
  let serverProc = null;
  let browser = null;
  let page = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-gimbal-window-${PORT}.sqlite` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function tap(selector) {
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      const kind = btn?.dataset.gimbal;
      if (kind === 'center' || kind === 'lock') {
        btn.click();
        return;
      }
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
    }, selector);
  }

  it('opens in the map corner, resizes, and uses the optics gimbal actions', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="terrain"]');
    await page.click('#flightGimbalScreenBtn');
    await page.waitForSelector('#gimbalScreen:not([hidden])');

    const placed = await page.evaluate(() => {
      const map = document.querySelector('.mission-region-map').getBoundingClientRect();
      const win = document.getElementById('gimbalScreen').getBoundingClientRect();
      const corner = document.getElementById('gimbalScreen').dataset.corner;
      return {
        corner,
        inMap: Boolean(document.getElementById('gimbalScreen').closest('.mission-region-map')),
        mapW: map.width,
        mapH: map.height,
        winW: win.width,
        winH: win.height,
        left: win.left - map.left,
        bottom: map.bottom - win.bottom,
        covers: (win.width * win.height) / (map.width * map.height),
      };
    });
    expect(placed.inMap).toBe(true);
    expect(placed.corner).toBe('bl');
    expect(placed.left).toBeLessThan(20);
    expect(placed.bottom).toBeLessThan(20);
    expect(placed.winW).toBeGreaterThan(160);
    expect(placed.winW).toBeLessThan(placed.mapW * 0.5);
    expect(placed.winH).toBeLessThan(placed.mapH * 0.55);
    expect(placed.covers).toBeLessThan(0.35);

    const handle = await page.locator('#gimbalScreenResize').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 80, handle.y - 48, { steps: 6 });
    await page.mouse.up();
    const resized = await page.evaluate(() => {
      const map = document.querySelector('.mission-region-map').getBoundingClientRect();
      const win = document.getElementById('gimbalScreen').getBoundingClientRect();
      return { winW: win.width, winH: win.height, mapW: map.width, mapH: map.height };
    });
    expect(resized.winW).toBeGreaterThan(placed.winW + 20);
    expect(resized.winH).toBeGreaterThan(placed.winH + 16);
    expect(resized.winW).toBeLessThan(resized.mapW * 0.7);
    expect(resized.winH).toBeLessThan(resized.mapH * 0.7);

    const voice = await page.evaluate(async () => {
      const posts = [];
      const orig = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        const body = String(init.body || '');
        if (String(url).includes('/api/assist/voice-flight')) posts.push(body);
        return orig(input, init);
      };
      const input = document.getElementById('gimbalScreenVoiceInput');
      const form = document.getElementById('gimbalScreenVoiceForm');
      const reply = document.getElementById('gimbalScreenVoiceReply');
      input.value = 'מה אני רואה במצלמות';
      form.requestSubmit();
      const t0 = Date.now();
      while (!reply.textContent && Date.now() - t0 < 4000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const camera = { reply: reply.textContent, posts: posts.slice() };
      posts.length = 0;
      input.value = 'חמש את המטוס';
      form.requestSubmit();
      const armed = { reply: reply.textContent, posts: posts.slice() };
      input.value = 'עבור למצב RTL';
      form.requestSubmit();
      return { camera, armed, mode: { reply: reply.textContent, posts: posts.slice() } };
    });
    expect(voice.camera.posts).toHaveLength(1);
    expect(voice.camera.posts[0]).toBe(JSON.stringify({ text: 'מה אני רואה במצלמות' }));
    expect(voice.camera.reply).toContain('קדמית');
    expect(voice.camera.reply).toContain('גימבל');
    expect(voice.armed.posts).toEqual([]);
    expect(voice.armed.reply).toContain('לא נשלח דבר');
    expect(voice.mode.posts).toEqual([]);
    expect(voice.mode.reply).toContain('לא נשלח דבר');

    await page.evaluate(() => {
      window.__gimbalPosts = [];
      const orig = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (String(url).includes('/api/jetson/v1/gimbal/')) {
          window.__gimbalPosts.push({
            url: String(url),
            method: String(init.method || 'GET'),
            body: String(init.body || ''),
          });
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return orig(input, init);
      };
      document.dispatchEvent(new CustomEvent('vlc-companion-cameras', {
        detail: {
          reachable: true,
          mode: 'real',
          health: {
            gimbal: {
              present: true,
              control_enabled: true,
              mode: 'follow',
              attitude: { yaw: 0, pitch: 0 },
              zoom: 1,
            },
          },
        },
      }));
    });

    async function sameAction(dir) {
      await page.evaluate(() => { window.__gimbalPosts = []; });
      await tap('#gimbalScreen [data-gimbal="center"]');
      await tap(`#gimbalScreen [data-gimbal="${dir}"]`);
      const fromWindow = await page.evaluate(() => window.__gimbalPosts.slice());
      await page.evaluate(() => { window.__gimbalPosts = []; });
      await tap('#gimbalPad [data-gimbal="center"]');
      await tap(`#gimbalPad [data-gimbal="${dir}"]`);
      const fromOptics = await page.evaluate(() => window.__gimbalPosts.slice());
      expect(fromWindow.length).toBeGreaterThan(0);
      expect(fromWindow).toEqual(fromOptics);
      expect(fromWindow.every((row) => row.method === 'POST')).toBe(true);
      expect(fromWindow.some((row) => row.url.includes('/gimbal/rate'))).toBe(false);
    }

    await sameAction('up');
    await sameAction('left');
    await sameAction('zoom-in');
    const commands = await page.evaluate(() => window.__gimbalPosts.map((row) => row.url));
    expect(commands.some((url) => url.includes('/gimbal/center'))).toBe(true);
    expect(commands.some((url) => url.includes('/gimbal/zoom'))).toBe(true);
  }, 30000);
});
