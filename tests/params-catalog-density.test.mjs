import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/params-catalog-density';
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');

function startServer(port) {
  const sqlite = path.join(os.tmpdir(), `airvix-catalog-density-${port}.sqlite`);
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
  throw new Error(`catalog density server did not become healthy at ${base}`);
}

function lum(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function contrast(a, b) {
  const L = (rgb) => 0.2126 * lum(rgb[0]) + 0.7152 * lum(rgb[1]) + 0.0722 * lum(rgb[2]);
  const hi = Math.max(L(a), L(b));
  const lo = Math.min(L(a), L(b));
  return (hi + 0.05) / (lo + 0.05);
}

const CONNECTED = {
  RNGFND1_MAX: 40,
  RNGFND1_ORIENT: 25,
  RNGFND1_TYPE: 0,
  LOG_BITMASK: 65535,
  LAND_FLARE_ALT: 3,
  GPS_TYPE: 1,
  EK3_ENABLE: 1,
  ARMING_OPTIONS: 0,
};

describe('Catalog parameter cards use the dense profile card', () => {
  it('does not keep a sparse one-line row for catalog cards', () => {
    expect(css).not.toContain('grid-template-areas: "key he now input"');
    expect(css).toMatch(/#control\.panel\.visible \.fc-group-row \.fc-card-cell\s*\{[^}]*flex-direction:\s*row/);
    expect(css).toMatch(/#control\.panel\.visible \.fc-group-list[\s\S]*align-items:\s*start/);
    expect(css).toMatch(/#control\.panel\.visible \.fc-group-list[\s\S]*grid-auto-rows:\s*max-content/);
  });

  const PORT = '4039';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;
  let page = null;
  let linked = false;

  async function measure(selector) {
    return page.evaluate((sel) => {
      const cards = [...document.querySelectorAll(sel)];
      const parse = (color) => {
        const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      return cards.map((card) => {
        const cs = getComputedStyle(card);
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const cardGap = parseFloat(cs.rowGap || cs.gap) || 0;
        const kids = [...card.children].filter((el) => getComputedStyle(el).display !== 'none');
        const used = kids.reduce((sum, el) => {
          const s = getComputedStyle(el);
          return sum + el.getBoundingClientRect().height
            + (parseFloat(s.marginTop) || 0)
            + (parseFloat(s.marginBottom) || 0);
        }, 0) + Math.max(0, kids.length - 1) * cardGap;
        const box = card.getBoundingClientRect();
        const textFails = [];
        for (const el of card.querySelectorAll('h3, p, span, button, label')) {
          if (getComputedStyle(el).display === 'none') continue;
          if (el.closest('select')) continue;
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (Number.isFinite(fs) && fs < 11) textFails.push(`font ${el.className}`);
          if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
            textFails.push((el.className || el.tagName).toString().slice(0, 48));
          }
        }
        const facts = [...card.querySelectorAll('.fc-card-cell:not(.fc-card-control)')].map((cell) => {
          const kick = cell.querySelector('.fc-card-kicker')?.getBoundingClientRect();
          const value = cell.querySelector('.fc-card-value, .fc-group-now, .fc-group-unit, .fc-group-meta')?.getBoundingClientRect();
          return {
            dir: getComputedStyle(cell).flexDirection,
            sameLine: !!(kick && value && Math.abs(((kick.top + kick.bottom) / 2) - ((value.top + value.bottom) / 2)) <= 8),
          };
        });
        const control = card.querySelector('.fc-card-control');
        const title = card.querySelector('.fc-group-he, .param-title');
        const live = card.querySelector('.fc-group-now');
        return {
          key: card.dataset.paramKey || '',
          height: box.height,
          width: box.width,
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          empty: card.clientHeight - pad - used,
          display: cs.display,
          text: card.innerText,
          control: card.querySelector('select, input')?.tagName || '',
          facts,
          textFails,
          titleColor: title ? parse(getComputedStyle(title).color) : null,
          liveColor: live ? parse(getComputedStyle(live).color) : null,
          liveText: live?.textContent || '',
          controlDir: control ? getComputedStyle(control).flexDirection : '',
        };
      });
    }, selector);
  }

  function expectDenseCards(rows, label) {
    expect(rows.length, label).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.display, `${label} ${row.key}`).toBe('flex');
      expect(row.empty, `${label} ${row.key}`).toBeLessThanOrEqual(12);
      expect(row.height, `${label} ${row.key}`).toBeGreaterThan(70);
      expect(row.height, `${label} ${row.key}`).toBeLessThan(280);
      expect(row.textFails, `${label} ${row.key}`).toEqual([]);
      expect(row.text, `${label} ${row.key}`).toContain('דיפולט');
      expect(row.text, `${label} ${row.key}`).toMatch(/בבקר|ערך|לא נשמר עדיין/);
      expect(row.text, `${label} ${row.key}`).toContain('יחידה');
      expect(row.text, `${label} ${row.key}`).toContain('טווח');
      expect(row.text, `${label} ${row.key}`).toContain('ערך חדש');
      expect(row.facts.length, `${label} ${row.key}`).toBeGreaterThanOrEqual(4);
      for (const fact of row.facts) {
        expect(fact.dir, `${label} ${row.key}`).toBe('row');
        expect(fact.sameLine, `${label} ${row.key}`).toBe(true);
      }
      expect(row.controlDir, `${label} ${row.key}`).toBe('row');
      expect(contrast(row.titleColor, [27, 40, 60]), `${label} ${row.key} title`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(row.liveColor, [27, 40, 60]), `${label} ${row.key} live`).toBeGreaterThanOrEqual(4.5);
    }
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        const overlap = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        expect(overlap, `${label} ${a.key} ${b.key}`).toBe(false);
      }
    }
  }

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
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
          connected: linked,
          mavlinkConnected: linked,
          armed: false,
          paramCount: linked ? Object.keys(CONNECTED).length : 0,
          current: linked ? CONNECTED : null,
        }),
      });
    });
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  async function openGroup(value, key) {
    await page.selectOption('#paramSubtabSelect', value);
    await page.waitForSelector(`#fcGroupList [data-param-key="${key}"]`, { timeout: 15000 });
  }

  it('packs every catalog type on a laptop and on a phone, disconnected and connected', async () => {
    const viewports = [
      { width: 1440, height: 900, name: '1440x900' },
      { width: 390, height: 844, name: '390x844' },
    ];
    const groups = [
      { value: 'ardu-rangefinder', key: 'RNGFND1_ORIENT', file: 'rangefinder' },
      { value: 'ardu-logs', key: 'LOG_BITMASK', file: 'logs' },
      { value: 'ardu-land', key: 'LAND_FLARE_ALT', file: 'land' },
      { value: 'ardu-gps', key: 'GPS_TYPE', file: 'gps' },
      { value: 'ardu-arming', key: 'ARMING_OPTIONS', file: 'arming' },
      { value: 'ardu-ekf', key: 'EK3_ENABLE', file: 'ekf' },
    ];

    for (const vp of viewports) {
      linked = false;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.click('[data-tab="control"]');
      await page.waitForSelector('#paramsGrid .param-card', { timeout: 15000 });
      const profile = await measure('#paramsGrid .param-card');
      expectDenseCards(profile.slice(0, 4), `${vp.name} profile`);

      for (const group of groups) {
        await openGroup(group.value, group.key);
        const rows = await measure('#fcGroupList .fc-group-row');
        expectDenseCards(rows, `${vp.name} ${group.value} off`);
        for (const row of rows) expect(row.liveText, row.key).toBe('אין חיבור');
        const orient = rows.find((row) => row.key === 'RNGFND1_ORIENT');
        const max = rows.find((row) => row.key === 'RNGFND1_MAX');
        const mask = rows.find((row) => row.key === 'LOG_BITMASK');
        const flare = rows.find((row) => row.key === 'LAND_FLARE_ALT');
        if (orient) expect(orient.control).toBe('SELECT');
        if (max) expect(max.control).toBe('INPUT');
        if (mask) expect(mask.control).toBe('INPUT');
        if (flare) {
          expect(flare.control).toBe('INPUT');
          expect(flare.text).toMatch(/\d/);
        }
        if (vp.width >= 1440 && rows.length >= 2) {
          const tops = rows.map((row) => Math.round(row.top));
          expect(new Set(tops).size, group.value).toBeLessThan(rows.length);
        }
        for (const row of rows) {
          expect(row.left, `${vp.name} ${row.key}`).toBeGreaterThanOrEqual(-1);
          expect(row.right, `${vp.name} ${row.key}`).toBeLessThanOrEqual(vp.width + 1);
        }
        await page.screenshot({ path: path.join(shotDir, `${group.file}-${vp.name}-off.png`), fullPage: false });
      }

      linked = true;
      await page.click('#arduReadBtn');
      await page.waitForFunction(() => document.querySelector('[data-param-key="EK3_ENABLE"] .fc-group-now')?.textContent === '1');
      for (const group of groups) {
        await openGroup(group.value, group.key);
        const rows = await measure('#fcGroupList .fc-group-row');
        expectDenseCards(rows, `${vp.name} ${group.value} on`);
      }
      await openGroup('ardu-rangefinder', 'RNGFND1_MAX');
      const linkedRows = await measure('#fcGroupList .fc-group-row');
      const liveMax = linkedRows.find((row) => row.key === 'RNGFND1_MAX');
      const missingMin = linkedRows.find((row) => row.key === 'RNGFND1_MIN');
      const liveOrient = linkedRows.find((row) => row.key === 'RNGFND1_ORIENT');
      expect(liveMax.liveText).toBe('40');
      expect(liveMax.text).toContain('40');
      expect(missingMin.liveText).toBe('חסר');
      expect(liveOrient.liveText).toBe('25');
      expect(liveOrient.control).toBe('SELECT');
      await openGroup('ardu-logs', 'LOG_BITMASK');
      const logs = await measure('#fcGroupList .fc-group-row');
      expect(logs.find((row) => row.key === 'LOG_BITMASK').liveText).toBe('65535');
      await page.screenshot({ path: path.join(shotDir, `rangefinder-${vp.name}-on.png`), fullPage: false });
    }
  }, 90000);
});
