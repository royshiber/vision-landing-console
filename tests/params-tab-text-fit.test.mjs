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
    stdio: 'ignore',
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
  let readArmed = false;
  let writePosts = 0;
  const shots = [];

  async function audit(label) {
    const report = await page.evaluate(() => {
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const offenders = [];
      const roots = [
        document.querySelector('.app-chrome'),
        document.getElementById('control'),
        document.getElementById('applyConfirmModal'),
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

  async function visibleSpan(selector) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { height: 0, width: 0 };
      const base = el.getBoundingClientRect();
      let top = base.top;
      let bottom = base.bottom;
      let left = base.left;
      let right = base.right;
      const clips = (value) => value === 'hidden' || value === 'clip' || value === 'auto' || value === 'scroll';
      let node = el.parentElement;
      while (node) {
        const s = getComputedStyle(node);
        const clipY = clips(s.overflowY) || s.overflow === 'hidden' || s.overflow === 'clip';
        const clipX = clips(s.overflowX) || s.overflow === 'hidden' || s.overflow === 'clip';
        if (clipY || clipX) {
          const p = node.getBoundingClientRect();
          if (clipY) {
            top = Math.max(top, p.top);
            bottom = Math.min(bottom, p.bottom);
          }
          if (clipX) {
            left = Math.max(left, p.left);
            right = Math.min(right, p.right);
          }
        }
        node = node.parentElement;
      }
      return {
        height: Math.max(0, bottom - top),
        width: Math.max(0, right - left),
      };
    }, selector);
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
    await page.route(/\/api\/ardu\/params(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          connected: true,
          mavlinkConnected: true,
          armed: readArmed,
          paramCount: 3,
          current: { EK3_ENABLE: 1, GPS_TYPE: 1, STAT_RUNTIME: 10 },
        }),
      });
    });
    await page.route(/\/api\/ardu\/params\/write$/, async (route) => {
      const body = route.request().postDataJSON() || {};
      const verified = body.params && typeof body.params === 'object' ? body.params : {};
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          simulated: false,
          written: Object.keys(verified).length,
          failed: [],
          verified,
          rejected: {},
          message: 'WRITE SUCCESS',
        }),
      });
    });
    await page.route(/\/api\/ardu\/param-files/, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/param-files/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            file: {
              id: '1700000000000-read-abcd1234',
              source: 'read',
              savedAt: '2026-09-26T08:00:00.000Z',
              count: 2,
              params: { EK3_ENABLE: 2, GPS_TYPE: 1 },
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          files: [{
            id: '1700000000000-read-abcd1234',
            source: 'read',
            savedAt: '2026-09-26T08:00:00.000Z',
            count: 2,
          }],
        }),
      });
    });
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/ardu/params/write')) writePosts += 1;
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
  }, 60000);

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
      const closedWizard = await page.locator('#autoConfig').evaluate((el) => getComputedStyle(el).display);
      expect(closedWizard, `${vp.name} wizard closed`).toBe('none');
      const listH = await visibleSpan('#fcGroupList');
      expect(listH.height, `${vp.name} group list`).toBeGreaterThanOrEqual(120);
      if (vp.width <= 360) {
        const rows = await page.evaluate(() => {
          const clips = (value) => value === 'hidden' || value === 'clip' || value === 'auto' || value === 'scroll';
          const visibleH = (el) => {
            const base = el.getBoundingClientRect();
            let top = base.top;
            let bottom = base.bottom;
            let node = el.parentElement;
            while (node) {
              const s = getComputedStyle(node);
              if (clips(s.overflowY) || s.overflow === 'hidden' || s.overflow === 'clip') {
                const p = node.getBoundingClientRect();
                top = Math.max(top, p.top);
                bottom = Math.min(bottom, p.bottom);
              }
              node = node.parentElement;
            }
            return Math.max(0, bottom - top);
          };
          return [...document.querySelectorAll('#fcGroupList .fc-group-row')].filter((row) => visibleH(row) >= 8).length;
        });
        expect(rows, `${vp.name} visible rows`).toBeGreaterThanOrEqual(3);
      }
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

      await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"] .fc-group-he');
      expect(await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-he').innerText()).toBe('הפעלת מסנן הניווט EKF3');
      await page.selectOption('#paramSubtabSelect', 'ardu-land');
      await page.waitForSelector('[data-param-key="LAND_FLARE_ALT"] .fc-group-meta');
      expect(await page.locator('[data-param-key="LAND_FLARE_ALT"] .fc-group-he').innerText()).toBe('גובה תחילת היישור לפני נגיעה');
      expect(await page.locator('[data-param-key="LAND_FLARE_ALT"] .fc-group-meta').innerText()).toContain('m');
      await page.selectOption('#paramSubtabSelect', 'ardu-all');
      await page.waitForSelector('[data-param-key="STAT_RUNTIME"]');
      expect(await page.locator('[data-param-key="STAT_RUNTIME"] .fc-group-he').innerText()).toBe('');
      const columns = await page.locator('#fcGroupList').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      if (vp.width >= 1440) expect(columns, vp.name).toBeGreaterThan(1);
      if (vp.width <= 360) expect(columns, vp.name).toBe(1);

      await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"] .fc-group-next');
      await page.fill('[data-param-key="EK3_ENABLE"] .fc-group-next', '0');
      await page.waitForFunction(() => document.querySelector('#fcChangeList')?.innerText.includes('ממתין'));
      expect(await page.locator('[data-param-key="EK3_ENABLE"]').getAttribute('class')).toContain('fc-group-row--pending');
      await page.locator('#fcChangePane').scrollIntoViewIfNeeded();
      await audit(`${vp.name} pending`);
      await shot(`${vp.name}-pending`);

      await page.locator('#fcFileList').scrollIntoViewIfNeeded();
      await page.waitForSelector('.fc-file-restore');
      expect(await page.locator('#fcFileLatest').innerText()).toContain('קריאה מהבקר');
      expect(await page.locator('#fcFileLatest').innerText()).toContain('2');
      await audit(`${vp.name} history`);
      await shot(`${vp.name}-history`);

      const postsBeforeRestore = writePosts;
      await page.click('.fc-file-restore');
      await page.waitForFunction(() => {
        const modal = document.getElementById('applyConfirmModal');
        const body = document.getElementById('applyConfirmBody');
        return modal && !modal.classList.contains('hidden') && body && body.innerText.includes('EK3_ENABLE');
      });
      expect(await page.locator('#applyConfirmTitle').innerText()).toContain('כתיבה לבקר');
      await shot(`${vp.name}-restore`);
      await page.click('#applyConfirmCancelBtn');
      await page.waitForFunction(() => document.getElementById('applyConfirmModal').classList.contains('hidden'));
      expect(writePosts, `${vp.name} restore cancel`).toBe(postsBeforeRestore);

      await page.click('#fcGroupApply');
      await page.waitForFunction(() => !document.getElementById('applyConfirmModal').classList.contains('hidden'));
      await page.click('#applyConfirmOkBtn');
      await page.waitForFunction(() => document.querySelector('#fcChangeList')?.innerText.includes('הבקר אישר'));
      await page.locator('#fcChangePane').scrollIntoViewIfNeeded();
      await audit(`${vp.name} written`);
      await shot(`${vp.name}-written`);

      await page.click('[data-subtab="autoConfig"]');
      await page.waitForSelector('#acWhatList .ac-choice', { timeout: 15000 });
      const wizardFit = await page.evaluate(() => {
        const ask = document.querySelector('.assist-toggle-btn');
        const body = document.querySelector('.ac-step-body');
        const br = body.getBoundingClientRect();
        const covered = [];
        for (const el of document.querySelectorAll('#acWhatList .ac-choice, .ac-step-nav button, #acApplyBtn')) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2 || r.top > br.bottom - 4 || r.bottom < br.top + 4) continue;
          const y = Math.min(br.bottom - 4, Math.max(br.top + 4, r.top + 12));
          const x = Math.min(r.right - 8, Math.max(r.left + 8, (r.left + r.right) / 2));
          const hit = document.elementFromPoint(x, y);
          if (hit === ask || (ask && ask.contains(hit))) covered.push((el.id || el.textContent || '').trim().slice(0, 24));
        }
        const clips = (value) => value === 'hidden' || value === 'clip' || value === 'auto' || value === 'scroll';
        let top = br.top;
        let bottom = br.bottom;
        let node = body.parentElement;
        while (node) {
          const s = getComputedStyle(node);
          if (clips(s.overflowY) || s.overflow === 'hidden' || s.overflow === 'clip') {
            const p = node.getBoundingClientRect();
            top = Math.max(top, p.top);
            bottom = Math.min(bottom, p.bottom);
          }
          node = node.parentElement;
        }
        return { body: Math.max(0, bottom - top), covered };
      });
      expect(wizardFit.body, `${vp.name} wizard body`).toBeGreaterThanOrEqual(80);
      expect(wizardFit.covered, `${vp.name} ask covers wizard`).toEqual([]);
      await page.locator('#acWhatList .ac-choice').first().click();
      await page.waitForSelector('#acWhereList .ac-choice');
      await page.locator('#acWhereList .ac-choice').first().click();
      await page.locator('#acApplyBtn').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const el = document.getElementById('acApplyBtn');
        const r = el?.getBoundingClientRect();
        return r && r.height > 20 && r.top < window.innerHeight && r.bottom > 0;
      });
      const applyHit = await page.evaluate(() => {
        const ask = document.querySelector('.assist-toggle-btn');
        const el = document.getElementById('acApplyBtn');
        const r = el.getBoundingClientRect();
        const x = Math.min(r.right - 8, Math.max(r.left + 8, (r.left + r.right) / 2));
        const y = Math.min(r.bottom - 4, Math.max(r.top + 4, r.top + r.height / 2));
        const hit = document.elementFromPoint(x, y);
        return { covered: !!(hit === ask || (ask && ask.contains(hit))), h: Math.round(r.height) };
      });
      expect(applyHit.covered, `${vp.name} ask covers apply`).toBe(false);
      expect(applyHit.h, `${vp.name} apply`).toBeGreaterThan(20);
      const contrast = await page.evaluate(() => {
        const el = document.querySelector('.ac-param-row .ac-param-key');
        if (!el) return 0;
        const parse = (color) => {
          const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
        };
        const lin = (value) => {
          const s = value / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
        const fg = lum(parse(getComputedStyle(el).color));
        const bg = lum(parse(getComputedStyle(el.parentElement).backgroundColor));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
      expect(contrast, `${vp.name} param name contrast`).toBeGreaterThanOrEqual(4.5);
      await audit(`${vp.name} wizard`);
      await shot(`${vp.name}-wizard`);

      await page.fill('#arduParamSearchInput', 'GPS');
      await page.click('#arduParamSmartSearchBtn');
      await page.waitForSelector('.ardu-smart-result-card', { timeout: 20000 });
      const smart = await page.locator('#arduSmartSearchResults').innerText();
      expect(smart, `${vp.name} smart current`).toContain('לא ידוע');
      expect(smart, `${vp.name} smart score`).not.toContain('התאמה');
      expect(smart, `${vp.name} smart fake`).not.toMatch(/ערך נוכחי:\s*(900|1000)\b/);
      await audit(`${vp.name} smart`);
      await shot(`${vp.name}-smart`);
      await page.click('#arduParamSearchClearBtn');
    }

    readArmed = true;
    await page.setViewportSize({ width: 360, height: 740 });
    await page.click('[data-tab="control"]');
    await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => document.querySelector('.fc-file-restore')?.disabled === true);
    expect(await page.locator('.fc-file-restore').getAttribute('title')).toContain('חמוש');
    await shot('360x740-restore-armed');
  }, 300000);

  it('shows a failed FC write when there is no link', async () => {
    const clean = await browser.newPage();
    await clean.addInitScript(() => { try { sessionStorage.clear(); } catch { /* ignore */ } });
    await clean.setViewportSize({ width: 1024, height: 576 });
    await clean.goto(BASE, { waitUntil: 'domcontentloaded' });
    await clean.click('[data-tab="control"]');
    await clean.waitForSelector('#arduWriteBtn');
    expect(await clean.locator('#arduWriteBtn').isDisabled()).toBe(true);
    await clean.evaluate(() => { document.getElementById('arduWriteBtn').disabled = false; });
    await clean.click('#arduWriteBtn');
    await clean.waitForFunction(() => (document.getElementById('paramWriteResult')?.textContent || '').includes('אין חיבור לבקר הטיסה'));
    expect(await clean.locator('#paramWriteResult').getAttribute('data-tone')).toBe('bad');
    expect(await clean.locator('#paramToolFault').isHidden()).toBe(true);
    const cls = await clean.locator('#arduWriteStatus').getAttribute('class');
    expect(cls || '').not.toContain('success');
    expect(await clean.locator('#arduWriteBtn').isDisabled()).toBe(true);
    const file = path.join(qaDir, '1024x576-write-no-link.png');
    await clean.screenshot({ path: file, fullPage: false });
    shots.push(file);
    await clean.close();
  }, 60000);

  it('keeps the list and wizard visible while the update banner is showing', async () => {
    const sizes = [
      { width: 1024, height: 576, name: '1024x576-banner' },
      { width: 360, height: 740, name: '360x740-banner' },
    ];
    for (const vp of sizes) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        const banner = document.getElementById('appUpdateBanner');
        banner.hidden = false;
        document.getElementById('appUpdateBannerText').textContent = 'יש עדכון לקונסולה';
      });
      await page.click('[data-tab="control"]');
      await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
      await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"]');
      const list = await visibleSpan('#fcGroupList');
      expect(list.height, `${vp.name} list`).toBeGreaterThanOrEqual(120);
      await page.waitForSelector('.fc-file-restore');
      await page.locator('.fc-file-restore').scrollIntoViewIfNeeded();
      const restoreCovered = await page.evaluate(() => {
        const ask = document.querySelector('.assist-toggle-btn');
        const el = document.querySelector('.fc-file-restore');
        const r = el.getBoundingClientRect();
        const x = Math.min(r.right - 4, Math.max(r.left + 4, (r.left + r.right) / 2));
        const y = Math.min(window.innerHeight - 2, Math.max(2, r.top + r.height / 2));
        const hit = document.elementFromPoint(x, y);
        return !!(hit === ask || (ask && ask.contains(hit)));
      });
      expect(restoreCovered, `${vp.name} ask covers restore`).toBe(false);
      await page.click('[data-subtab="autoConfig"]');
      await page.waitForSelector('#acWhatList .ac-choice');
      const wizard = await visibleSpan('.ac-step-body');
      expect(wizard.height, `${vp.name} wizard`).toBeGreaterThanOrEqual(80);
      const covered = await page.evaluate(() => {
        const ask = document.querySelector('.assist-toggle-btn');
        const hits = [];
        for (const el of document.querySelectorAll('.ac-step-nav button, #acWhatList .ac-choice')) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2 || r.bottom < 2 || r.top > window.innerHeight - 2) continue;
          const x = Math.min(r.right - 4, Math.max(r.left + 4, (r.left + r.right) / 2));
          const y = Math.min(r.bottom - 2, Math.max(r.top + 2, (r.top + r.bottom) / 2));
          const hit = document.elementFromPoint(x, y);
          if (hit === ask || (ask && ask.contains(hit))) hits.push((el.textContent || '').trim().slice(0, 24));
        }
        return hits;
      });
      expect(covered, `${vp.name} ask covers wizard`).toEqual([]);
      await shot(vp.name);
    }
  }, 90000);
});
