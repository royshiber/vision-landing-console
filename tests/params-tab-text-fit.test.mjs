import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaDir = '/opt/cursor/artifacts/params-tab/qa';
const VIEWPORTS = [
  { width: 1024, height: 576, name: '1024x576' },
  { width: 1280, height: 720, name: '1280x720' },
  { width: 1366, height: 768, name: '1366x768' },
  { width: 1440, height: 900, name: '1440x900' },
  { width: 1920, height: 1080, name: '1920x1080' },
  { width: 360, height: 740, name: '360x740' },
];

function startServer(port) {
  const sqlite = path.join(os.tmpdir(), `airvix-params-qa-${port}.sqlite`);
  fs.rmSync(sqlite, { force: true });
  return spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: sqlite,
      GEMINI_API_KEY: '',
      COMPANION_MODE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitHealth(base, maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`params qa server did not become healthy at ${base}`);
}

describe('Parameters tab text fit', () => {
  const PORT = '4037';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;
  let page = null;
  const shots = [];

  async function audit(label) {
    const report = await page.evaluate(() => {
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const offenders = [];
      const roots = [
        document.querySelector('.app-chrome'),
        document.getElementById('control'),
        document.querySelector('.assist-toggle-btn'),
      ].filter(Boolean);
      const seen = new Set();
      const consider = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const inView = r.bottom > 2 && r.top < viewH - 2 && r.right > 2 && r.left < viewW - 2;
        if (!inView) return;
        const id = el.id ? `#${el.id}` : el.className?.toString?.().split(' ').slice(0, 2).join('.') || el.tagName;
        const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const fs = parseFloat(s.fontSize);
        if (text && Number.isFinite(fs) && fs < 11) {
          offenders.push({ kind: 'font', id, fs: Math.round(fs * 10) / 10, sample: el.textContent.trim().slice(0, 48) });
        }
        if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
          offenders.push({ kind: 'ellipsis', id, sample: el.textContent.trim().slice(0, 48) });
        }
        const scrollport = ['auto', 'scroll'].includes(s.overflowY) || ['auto', 'scroll'].includes(s.overflowX);
        if (!scrollport && el.scrollWidth > el.clientWidth + 2) {
          offenders.push({ kind: 'clip-x', id, sample: (el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 48) });
        }
        if (r.left < -1 || r.right > viewW + 1) {
          offenders.push({ kind: 'edge', id, left: Math.round(r.left), right: Math.round(r.right) });
        }
      };
      for (const root of roots) {
        consider(root);
        root.querySelectorAll('*').forEach(consider);
      }
      const banner = document.getElementById('paramSyncBanner');
      const ask = document.querySelector('.assist-toggle-btn');
      let bannerAsk = false;
      if (banner && ask && getComputedStyle(banner).display !== 'none') {
        const a = banner.getBoundingClientRect();
        const b = ask.getBoundingClientRect();
        bannerAsk = a.width > 2 && a.height > 2 && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        if (a.bottom > viewH + 1 || a.right > viewW + 1 || a.left < -1) {
          offenders.push({ kind: 'banner-edge', id: '#paramSyncBanner' });
        }
      }
      const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const search = document.getElementById('arduParamSearchInput');
      const smart = document.getElementById('arduParamSmartSearchBtn');
      return {
        offenders: offenders.slice(0, 12),
        count: offenders.length,
        bannerAsk,
        docOverflow,
        bannerText: banner?.innerText || '',
        placeholder: search?.getAttribute('placeholder') || '',
        smartText: smart?.innerText || '',
        smartBox: smart ? (() => {
          const r = smart.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        })() : null,
        inputPlaceholderDup: !!document.querySelector('.fc-group-next') && [...document.querySelectorAll('.fc-group-row')].some((row) => {
          const now = row.querySelector('.fc-group-now')?.textContent || '';
          const input = row.querySelector('.fc-group-next');
          return input && input.placeholder && input.placeholder === now;
        }),
      };
    });
    expect(report.docOverflow, label).toBeLessThanOrEqual(1);
    expect(report.bannerAsk, `${label} banner under ask`).toBe(false);
    expect(report.inputPlaceholderDup, `${label} duplicate value`).toBe(false);
    expect(report.count, `${label} ${JSON.stringify(report.offenders)}`).toBe(0);
    if (report.smartBox) {
      expect(report.smartBox.left, label).toBeGreaterThanOrEqual(-1);
      expect(report.smartBox.right, label).toBeLessThanOrEqual(page.viewportSize().width + 1);
    }
  }

  async function shot(name) {
    const file = path.join(qaDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    shots.push(file);
  }

  beforeAll(async () => {
    fs.mkdirSync(qaDir, { recursive: true });
    serverProc = startServer(PORT);
    await waitHealth(BASE);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.addInitScript(() => {
      try { sessionStorage.clear(); } catch { /* ignore */ }
    });
    await page.route('**/api/ardu/params', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          connected: true,
          mavlinkConnected: true,
          armed: false,
          paramCount: 2,
          current: { EK3_ENABLE: 1, GPS_TYPE: 1 },
        }),
      });
    });
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (shots.length) {
      const py = `
import os
from PIL import Image, ImageDraw
paths = ${JSON.stringify(shots)}
thumbs = []
for p in paths:
    im = Image.open(p).convert('RGB')
    im.thumbnail((280, 180))
    card = Image.new('RGB', (280, 200), (11, 14, 20))
    card.paste(im, (0, 20))
    d = ImageDraw.Draw(card)
    d.text((4, 2), os.path.basename(p).replace('.png',''), fill=(226, 232, 240))
    thumbs.append(card)
cols = 6
rows = (len(thumbs) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 284 + 4, rows * 204 + 4), (0, 0, 0))
for i, card in enumerate(thumbs):
    sheet.paste(card, (4 + (i % cols) * 284, 4 + (i // cols) * 204))
sheet.save(${JSON.stringify(path.join(qaDir, 'contact-sheet.png'))})
print(len(thumbs))
`;
      fs.writeFileSync(path.join(qaDir, '_sheet.py'), py);
      const { execFileSync } = await import('child_process');
      execFileSync('python3', [path.join(qaDir, '_sheet.py')], { stdio: 'inherit' });
      fs.rmSync(path.join(qaDir, '_sheet.py'), { force: true });
    }
  });

  it('keeps params text inside its boxes in RTL across the size matrix', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const optionValues = await page.locator('#paramSubtabSelect option').evaluateAll((opts) => opts.map((o) => o.value));
    expect(optionValues.length).toBeGreaterThan(8);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.waitForSelector('#paramSubtabSelect');
      await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"]');
      await audit(`${vp.name} no-read`);
      expect(await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-now').innerText()).toBe('לא ידוע');
      expect(await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-next').getAttribute('placeholder')).toBe('—');
      const banner = await page.locator('#paramSyncBanner').innerText();
      expect(banner, vp.name).toContain('לא בוצעה קריאה');
      await shot(`${vp.name}-no-read`);

      await page.click('#arduReadBtn');
      await page.waitForFunction(() => document.querySelector('[data-param-key="EK3_ENABLE"] .fc-group-now')?.textContent === '1');
      await audit(`${vp.name} read`);
      expect(await page.locator('[data-param-key="GPS_TYPE"] .fc-group-now').count()).toBe(0);
      await shot(`${vp.name}-read`);

      for (const value of optionValues) {
        await page.selectOption('#paramSubtabSelect', value);
        await page.waitForTimeout(40);
        await audit(`${vp.name} ${value}`);
        await shot(`${vp.name}-${value}`);
      }
      await page.selectOption('#paramSubtabSelect', 'ardu-gps');
      await page.waitForSelector('#fcGroupList [data-param-key="GPS_TYPE"]');
      await shot(`${vp.name}-gps`);
      await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"]');
      await page.fill('#arduParamSearchInput', 'EK3_GPS');
      await page.waitForFunction(() => {
        const keys = [...document.querySelectorAll('#fcGroupList .fc-group-key')].map((el) => el.textContent);
        return keys.includes('EK3_GPS_CHECK') && !keys.includes('EK3_ENABLE');
      });
      await audit(`${vp.name} search`);
      await shot(`${vp.name}-search`);
      await page.click('#arduParamSearchClearBtn');

      await page.click('[data-subtab="autoConfig"]');
      await page.waitForSelector('#acWhatList .ac-choice', { timeout: 15000 });
      await audit(`${vp.name} wizard`);
      await shot(`${vp.name}-wizard`);
    }
  }, 180000);
});
