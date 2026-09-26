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

  async function measure() {
    return page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const cats = [...document.querySelectorAll('.pulse-cat')].map((el) => ({
        id: el.dataset.pulseCat,
        ...box(el),
      }));
      const summary = [...document.querySelectorAll('.pulse-summary-cat')].map(box);
      const rows = [...document.querySelectorAll('.pulse-cat .status-row-main')].map((el) => {
        const r = box(el);
        const name = el.querySelector('.status-row-name, .vlr-name');
        const pill = el.querySelector('.status-row-pill, .vlr-chip');
        const nameBox = name ? box(name) : null;
        const pillBox = pill ? box(pill) : null;
        return {
          ...r,
          nameOverflow: name ? name.scrollWidth - name.clientWidth : 0,
          pillText: pill?.textContent || '',
          nameInside: !nameBox || (nameBox.left >= r.left - 1 && nameBox.right <= r.right + 1),
          pillInside: !pillBox || (pillBox.left >= r.left - 1 && pillBox.right <= r.right + 1),
        };
      });
      const home = document.querySelector('.pulse-home.pulse-status-home');
      const grid = document.getElementById('pulseCatGrid');
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
      return {
        cats,
        summary,
        rows,
        cols: cols.length,
        homeScroll: home.scrollHeight - home.clientHeight,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dir: document.documentElement.getAttribute('dir'),
        vh: window.innerHeight,
        vw: window.innerWidth,
      };
    });
  }

  it('fits every category on one screen at 1366x768 without page scroll', async () => {
    await openStatus(1366, 768);
    const m = await measure();
    expect(m.dir).toBe('rtl');
    expect(m.cols).toBe(3);
    expect(m.cats.map((c) => c.id)).toEqual(['links', 'jetson', 'fc', 'vision', 'landing']);
    expect(m.homeScroll).toBeLessThanOrEqual(2);
    expect(m.docOverflow).toBeLessThanOrEqual(1);
    expect(m.summary.length).toBe(5);
    for (const cat of m.cats) {
      expect(cat.top).toBeGreaterThanOrEqual(-1);
      expect(cat.bottom).toBeLessThanOrEqual(m.vh + 1);
      expect(cat.width).toBeGreaterThan(80);
      expect(cat.height).toBeGreaterThan(40);
    }
    for (let i = 0; i < m.cats.length; i += 1) {
      for (let j = i + 1; j < m.cats.length; j += 1) {
        expect(interiorsIntersect(m.cats[i], m.cats[j]), `${m.cats[i].id} overlaps ${m.cats[j].id}`).toBe(false);
      }
    }
    for (const row of m.rows) {
      expect(row.pillInside, row.pillText).toBe(true);
      expect(row.nameInside).toBe(true);
      expect(row.height).toBeGreaterThan(16);
    }
    await page.screenshot({ path: path.join(shotDir, '1366x768.png') });
  }, 30000);

  it('uses four columns at 1920x1080 and one column at 360x800', async () => {
    await openStatus(1920, 1080);
    const wide = await measure();
    expect(wide.cols).toBe(4);
    expect(wide.homeScroll).toBeLessThanOrEqual(2);
    expect(wide.docOverflow).toBeLessThanOrEqual(1);
    for (let i = 0; i < wide.cats.length; i += 1) {
      for (let j = i + 1; j < wide.cats.length; j += 1) {
        expect(interiorsIntersect(wide.cats[i], wide.cats[j])).toBe(false);
      }
      expect(wide.cats[i].bottom).toBeLessThanOrEqual(wide.vh + 1);
    }
    await page.screenshot({ path: path.join(shotDir, '1920x1080.png') });

    await openStatus(360, 800);
    const narrow = await measure();
    expect(narrow.cols).toBe(1);
    expect(narrow.docOverflow).toBeLessThanOrEqual(1);
    for (const cat of narrow.cats) {
      expect(cat.left).toBeGreaterThanOrEqual(-1);
      expect(cat.right).toBeLessThanOrEqual(narrow.vw + 1);
    }
    await page.evaluate(() => {
      const btn = document.querySelector('.vlr-row[data-id="plnd_profile"] .status-row-main');
      const home = document.querySelector('.pulse-home.pulse-status-home');
      if (home && btn) {
        const homeRect = home.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        home.scrollTop += (btnRect.top - homeRect.top) - 12;
      }
      btn?.click();
    });
    const overlap = await page.evaluate(() => {
      const row = document.querySelector('.vlr-row[data-id="plnd_profile"]');
      const btn = row.querySelector('.vlr-open-params');
      const pill = row.querySelector('.vlr-chip');
      const a = btn.getBoundingClientRect();
      const b = pill.getBoundingClientRect();
      const card = row.closest('.pulse-cat').getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        overlap: a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1,
        inside: a.left >= card.left - 1 && a.right <= card.right + 1,
        label: btn.textContent,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && a.width > 0 && a.height > 0,
      };
    });
    expect(overlap.visible).toBe(true);
    expect(overlap.label).toBe('פתח בפרמטרים');
    expect(overlap.overlap).toBe(false);
    expect(overlap.inside).toBe(true);
    await page.screenshot({ path: path.join(shotDir, '360x800.png') });
  }, 40000);
});
