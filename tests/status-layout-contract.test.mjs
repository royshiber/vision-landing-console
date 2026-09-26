import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/tmp/status-layout-contract';
const PORT = '4052';
const BASE = `http://127.0.0.1:${PORT}`;

function interiorsIntersect(a, b, slack = 1) {
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

describe('Status tab layout contract', () => {
  let serverProc = null;
  let browser = null;
  let page = null;
  const policyFailures = [];

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-status-layout-${PORT}.sqlite` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    let healthy = false;
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { healthy = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(healthy).toBe(true);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on('response', (res) => {
      if (res.url().includes('/api/jetson/v1/policy') && res.status() >= 400) {
        policyFailures.push(`${res.status()} ${res.url()}`);
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /policy|503/.test(msg.text())) policyFailures.push(msg.text());
    });
  }, 30000);

  afterAll(async () => {
    try { await page?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function openStatus(width, height) {
    await page.setViewportSize({ width, height });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="pulse"]');
    await page.waitForSelector('#pulse.panel.visible [data-vlr-host="jetson"] .vlr-row');
    await page.waitForSelector('#pulseSummary .pulse-summary-cat');
    await page.waitForTimeout(250);
  }

  async function audit() {
    return page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const shown = (el) => {
        if (!el || el.closest('[hidden]')) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      const ownText = (el) => [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ');
      const root = document.getElementById('pulse');
      const textFails = [];
      for (const el of root.querySelectorAll('*')) {
        if (!shown(el)) continue;
        const text = ownText(el);
        if (!text) continue;
        const cs = getComputedStyle(el);
        const font = parseFloat(cs.fontSize);
        const card = el.closest('.pulse-cat');
        const er = el.getBoundingClientRect();
        const cr = card ? card.getBoundingClientRect() : null;
        const overflowX = el.scrollWidth - el.clientWidth;
        const overflowY = el.scrollHeight - el.clientHeight;
        const inside = !cr || (
          er.left >= cr.left - 1 && er.right <= cr.right + 1
          && er.top >= cr.top - 1 && er.bottom <= cr.bottom + 1
        );
        if (overflowX > 0 || overflowY > 0 || font < 11 || !inside) {
          textFails.push({
            text: text.slice(0, 80),
            tag: el.tagName,
            cls: el.className && String(el.className).slice(0, 80),
            overflowX,
            overflowY,
            font,
            inside,
          });
        }
      }
      const cats = [...document.querySelectorAll('.pulse-cat')].filter(shown).map((el) => ({
        id: el.dataset.pulseCat,
        ...box(el),
      }));
      const overlaps = [];
      const groups = [
        [...document.querySelectorAll('.pulse-summary-cat')],
        [...document.querySelectorAll('.pulse-cat')],
        [...document.querySelectorAll('.pulse-dock > *')],
      ];
      document.querySelectorAll('.status-row-main, .pulse-cat-rows, .vlr-list').forEach((parent) => {
        groups.push([...parent.children]);
      });
      for (const group of groups) {
        const vis = group.filter(shown);
        for (let i = 0; i < vis.length; i += 1) {
          for (let j = i + 1; j < vis.length; j += 1) {
            const a = box(vis[i]);
            const b = box(vis[j]);
            const hit = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
            if (hit) {
              overlaps.push({
                a: (vis[i].dataset.pulseCat || vis[i].className || vis[i].textContent || '').toString().slice(0, 40),
                b: (vis[j].dataset.pulseCat || vis[j].className || vis[j].textContent || '').toString().slice(0, 40),
              });
            }
          }
        }
      }
      const grid = document.getElementById('pulseCatGrid');
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
      return {
        textFails,
        overlaps,
        cats,
        cols: cols.length,
        dir: document.documentElement.getAttribute('dir'),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        vw: window.innerWidth,
      };
    });
  }

  const viewports = [
    [1024, 576, 3],
    [1280, 720, 3],
    [1366, 768, 3],
    [1440, 900, 3],
    [1920, 1080, 4],
    [360, 740, 1],
  ];

  it.each(viewports)('keeps every visible status string inside its box at %ix%i', async (width, height, cols) => {
    await openStatus(width, height);
    const m = await audit();
    expect(m.dir).toBe('rtl');
    expect(m.cols).toBe(cols);
    expect(m.cats.map((c) => c.id)).toEqual(['links', 'jetson', 'fc', 'vision', 'landing']);
    expect(m.docOverflow).toBeLessThanOrEqual(1);
    expect(m.textFails, JSON.stringify(m.textFails, null, 2)).toEqual([]);
    expect(m.overlaps, JSON.stringify(m.overlaps, null, 2)).toEqual([]);
    const pulseBox = await page.evaluate(() => {
      const pulse = document.getElementById('pulse');
      const title = document.querySelector('.pulse-title');
      const home = document.querySelector('.pulse-home.pulse-status-home');
      return {
        pulseH: pulse.getBoundingClientRect().height,
        title: title?.textContent || '',
        titleH: title?.getBoundingClientRect().height || 0,
        homeClient: home.clientHeight,
      };
    });
    expect(pulseBox.title).toContain('סטטוס מחשבים');
    expect(pulseBox.titleH).toBeGreaterThan(12);
    expect(pulseBox.pulseH).toBeGreaterThan(200);
    expect(pulseBox.homeClient).toBeGreaterThan(120);
    const dock = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const nodes = [
        document.querySelector('.pulse-add-widget-title'),
        document.querySelector('.pulse-version-line'),
        document.querySelector('.pulse-home-pref'),
      ].filter(Boolean);
      const hit = [];
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = box(nodes[i]);
          const b = box(nodes[j]);
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
            hit.push(`${nodes[i].className}~${nodes[j].className}`);
          }
        }
      }
      return hit;
    });
    expect(dock, 'status dock overlaps').toEqual([]);
    for (const cat of m.cats) {
      expect(cat.left).toBeGreaterThanOrEqual(-1);
      expect(cat.right).toBeLessThanOrEqual(m.vw + 1);
      expect(cat.width).toBeGreaterThan(80);
    }
    await page.screenshot({ path: path.join(shotDir, `${width}x${height}.png`) });
  }, 30000);

  it('keeps the extra-widget editor off the version line', async () => {
    await openStatus(1440, 900);
    await page.click('.pulse-add-widget > summary');
    const hit = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, h: r.height };
      };
      const input = document.getElementById('pulseAddWidgetInput');
      const version = document.querySelector('.pulse-version-line');
      const pref = document.querySelector('.pulse-home-pref');
      const a = box(input);
      const b = box(version);
      const c = box(pref);
      const overlap = (x, y) => x.left < y.right - 1 && x.right > y.left + 1 && x.top < y.bottom - 1 && x.bottom > y.top + 1;
      return { inputH: a.h, version: overlap(a, b), pref: overlap(a, c), line: overlap(b, c) };
    });
    expect(hit.inputH).toBeGreaterThan(20);
    expect(hit.version).toBe(false);
    expect(hit.pref).toBe(false);
    expect(hit.line).toBe(false);
  }, 30000);

  it('does not request Jetson policy when the companion is off', async () => {
    await openStatus(1366, 768);
    await page.waitForFunction(() => document.getElementById('policyUiState')?.textContent === 'אין מידע');
    expect(policyFailures).toEqual([]);
  }, 30000);

  it('keeps the opened parameter action inside the landing card', async () => {
    await openStatus(1024, 576);
    await page.evaluate(() => {
      document.querySelector('.vlr-row[data-id="plnd_profile"] .status-row-main')?.click();
    });
    const m = await audit();
    expect(m.textFails, JSON.stringify(m.textFails, null, 2)).toEqual([]);
    expect(m.overlaps, JSON.stringify(m.overlaps, null, 2)).toEqual([]);
    const label = await page.locator('.vlr-row[data-id="plnd_profile"] .vlr-open-params').textContent();
    expect(label).toBe('פתח בפרמטרים');
  }, 30000);
});
