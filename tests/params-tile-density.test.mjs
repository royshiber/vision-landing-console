import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/params-density';
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');

function startServer(port) {
  const sqlite = path.join(os.tmpdir(), `airvix-param-density-${port}.sqlite`);
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
  throw new Error(`density server did not become healthy at ${base}`);
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe('Parameter tiles are dense and not behind a filter wall', () => {
  it('does not tell the operator to narrow the list before the tiles render', () => {
    expect(js).not.toContain('צמצמו את הרשימה');
    expect(js).not.toContain('יש יותר מדי פרמטרים');
    expect(js).not.toContain('עדיין אין פרמטרים');
    expect(css).not.toContain('grid-auto-rows: minmax(108px, 1fr)');
    expect(css).not.toContain('min-height: 108px');
  });

  let PORT = 0;
  let BASE = '';
  let serverProc = null;
  let browser = null;
  let page = null;

  async function openParams(width, height) {
    await page.setViewportSize({ width, height });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="control"]');
    await page.waitForSelector('#paramsGrid .param-card', { timeout: 15000 });
  }

  async function measure() {
    return page.evaluate(() => {
      const grid = document.getElementById('paramsGrid');
      const cards = [...grid.querySelectorAll('.param-card')];
      const gs = getComputedStyle(grid);
      const gap = parseFloat(gs.rowGap || gs.gap) || 0;
      const parse = (color) => {
        const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      const rows = cards.map((card) => {
        const cs = getComputedStyle(card);
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const cardGap = parseFloat(cs.rowGap || cs.gap) || 0;
        const kids = [...card.children].filter((el) => getComputedStyle(el).display !== 'none');
        const used = kids.reduce((sum, el) => {
          const s = getComputedStyle(el);
          return sum + el.getBoundingClientRect().height + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
        }, 0) + Math.max(0, kids.length - 1) * cardGap;
        const box = card.getBoundingClientRect();
        const textFails = [];
        for (const el of card.querySelectorAll('h3, p, span, button')) {
          if (getComputedStyle(el).display === 'none') continue;
          if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
            textFails.push((el.className || el.tagName).toString().slice(0, 40));
          }
        }
        return {
          key: card.dataset.paramKey,
          height: box.height,
          width: box.width,
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          empty: card.clientHeight - pad - used,
          position: cs.position,
          text: card.innerText,
          hasSlider: !!card.querySelector('input[type="range"]'),
          hasLock: !!card.querySelector('.lock-btn'),
          textFails,
          titleColor: parse(getComputedStyle(card.querySelector('.param-title')).color),
        };
      });
      return {
        display: gs.display,
        gap,
        position: gs.position,
        gridWidth: grid.getBoundingClientRect().width,
        faultHidden: document.getElementById('paramToolFault')?.hidden === true,
        faultText: document.getElementById('paramToolFaultText')?.textContent || '',
        bodyText: document.getElementById('control')?.innerText || '',
        rows,
        innerH: window.innerHeight,
      };
    });
  }

  beforeAll(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    fs.mkdirSync(shotDir, { recursive: true });
    serverProc = startServer(PORT);
    await waitHealth(BASE);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route('**/api/ardu/params**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          connected: false,
          mavlinkConnected: true,
          armed: false,
          paramCount: 0,
          current: null,
          target: {},
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

  async function expectDense(label, { minCards, file }) {
    await page.locator('#paramsGrid').scrollIntoViewIfNeeded();
    const data = await measure();
    expect(data.bodyText, label).toContain('נשמר בקונסולה · לא בבקר');
    expect(data.faultHidden, label).toBe(true);
    expect(data.faultText, label).not.toMatch(/צמצמו|יותר מדי פרמטרים|עדיין אין פרמטרים/);
    expect(data.bodyText, label).not.toMatch(/צמצמו את הרשימה|יש יותר מדי פרמטרים/);
    expect(['grid', 'flex'], label).toContain(data.display);
    expect(data.position, label).not.toBe('absolute');
    expect(data.gap, label).toBeGreaterThanOrEqual(8);
    expect(data.rows.length, label).toBeGreaterThanOrEqual(minCards);
    const visible = data.rows.filter((row) => row.bottom > 0 && row.top < data.innerH);
    expect(visible.length, label).toBeGreaterThanOrEqual(2);
    let minLeft = Infinity;
    let maxRight = 0;
    for (const row of data.rows) {
      expect(row.position, `${label} ${row.key}`).not.toBe('absolute');
      expect(row.empty, `${label} ${row.key}`).toBeLessThanOrEqual(12);
      expect(row.height, `${label} ${row.key}`).toBeLessThan(240);
      expect(row.hasSlider, `${label} ${row.key}`).toBe(true);
      expect(row.hasLock, `${label} ${row.key}`).toBe(true);
      expect(row.text, `${label} ${row.key}`).toContain('דיפולט');
      expect(row.text, `${label} ${row.key}`).not.toContain('נשמר בקונסולה');
      expect(row.text, `${label} ${row.key}`).toMatch(/לא נשמר עדיין|ערך/);
      expect(row.text, `${label} ${row.key}`).toContain('ערך חדש');
      expect(row.textFails, `${label} ${row.key}`).toEqual([]);
      expect(contrast(row.titleColor, [27, 40, 60]), `${label} ${row.key}`).toBeGreaterThanOrEqual(4.5);
      minLeft = Math.min(minLeft, row.left);
      maxRight = Math.max(maxRight, row.right);
    }
    expect(maxRight - minLeft, label).toBeGreaterThanOrEqual(data.gridWidth - 8);
    for (let i = 0; i < data.rows.length; i += 1) {
      for (let j = i + 1; j < data.rows.length; j += 1) {
        const a = data.rows[i];
        const b = data.rows[j];
        const overlap = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        expect(overlap, `${label} ${a.key} ${b.key}`).toBe(false);
      }
    }
    if (file) await page.screenshot({ path: path.join(shotDir, file), fullPage: false });
    return data;
  }

  it('shows every profile tile at 1440x900 without a filter and without a red wall', async () => {
    await openParams(1440, 900);
    const data = await expectDense('1440x900', { minCards: 22, file: 'params-1440x900.png' });
    const keys = data.rows.map((row) => row.key);
    expect(keys).toEqual(expect.arrayContaining([
      'flare_alt_m',
      'vision_conf_min',
      'vision_enable_alt_m',
      'abort_conf_min',
      'to_rotate_speed_ms',
    ]));
    const flare = data.rows.find((row) => row.key === 'flare_alt_m');
    expect(flare.text).toContain('8');
    expect(flare.text).toContain('1–30');

    await page.click('#arduReadBtn');
    await page.waitForTimeout(400);
    const after = await measure();
    expect(after.faultHidden).toBe(true);
    expect(after.faultText).not.toMatch(/צמצמו|יותר מדי|עדיין אין פרמטרים/);
    expect(after.rows.length).toBe(data.rows.length);
    expect(after.rows.find((row) => row.key === 'flare_alt_m').text).toContain('לא נשמר עדיין');
    expect(after.rows.find((row) => row.key === 'flare_alt_m').text).not.toContain('אין חיבור');
  }, 40000);

  it('keeps the same tiles readable at 390px and lets search narrow without being required', async () => {
    await openParams(390, 844);
    const wide = await expectDense('390x844', { minCards: 22, file: 'params-390.png' });
    expect(wide.rows.filter((row) => row.top < 844 && row.bottom > 0).length).toBeGreaterThanOrEqual(2);

    await page.fill('#arduParamSearchInput', 'flare_alt');
    await page.waitForFunction(() => document.querySelectorAll('#paramsGrid .param-card').length === 1);
    const filtered = await measure();
    expect(filtered.rows.map((row) => row.key)).toEqual(['flare_alt_m']);
    expect(filtered.faultHidden).toBe(true);

    await page.click('#arduParamSearchClearBtn');
    await page.waitForFunction(() => document.querySelectorAll('#paramsGrid .param-card').length >= 22);
    const restored = await measure();
    expect(restored.rows.length).toBeGreaterThanOrEqual(22);
    expect(restored.faultHidden).toBe(true);
  }, 40000);

  it('starts the profile grid inside a 390x740 first paint', async () => {
    await openParams(390, 740);
    await page.waitForFunction(() => document.querySelectorAll('#paramsGrid .param-card').length >= 5);
    const layout = await page.evaluate(() => {
      const strip = document.getElementById('plndProfileHonestyKeys');
      const cards = [...document.querySelectorAll('#paramsGrid .param-card')].slice(0, 5).map((el) => el.innerText);
      const grid = document.getElementById('paramsGrid').getBoundingClientRect();
      const firstCard = document.querySelector('#paramsGrid .param-card')?.getBoundingClientRect();
      return {
        stripDisplay: getComputedStyle(strip).display,
        cards,
        gridTop: grid.top,
        cardTop: firstCard ? firstCard.top : 9999,
        innerH: window.innerHeight,
        writeDisabled: document.getElementById('arduWriteBtn')?.disabled === true,
        faultHidden: document.getElementById('paramToolFault')?.hidden === true,
        faultText: document.getElementById('paramToolFaultText')?.textContent || '',
      };
    });
    expect(layout.stripDisplay).toBe('none');
    expect(layout.cards.length).toBeGreaterThanOrEqual(5);
    for (const text of layout.cards) {
      expect(text).toContain('דיפולט');
      expect(text).toContain('לא נשמר עדיין');
    }
    expect(layout.gridTop).toBeGreaterThan(0);
    expect(layout.gridTop).toBeLessThan(layout.innerH);
    expect(layout.cardTop).toBeLessThan(740);
    expect(layout.writeDisabled).toBe(true);
    expect(layout.faultHidden).toBe(true);
    expect(layout.faultText).not.toMatch(/צמצמו|יותר מדי|עדיין אין פרמטרים/);
    await page.screenshot({ path: path.join(shotDir, 'params-390-first.png'), fullPage: false });

    await page.locator('#paramsGrid .param-card .param-info').first().click();
    const open = await page.locator('#paramInfoPopup').evaluate((el) => ({
      hidden: el.classList.contains('hidden'),
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
      text: el.textContent || '',
    }));
    expect(open.hidden).toBe(false);
    expect(open.w).toBeGreaterThan(80);
    expect(open.h).toBeGreaterThan(24);
    expect(open.text).toMatch(/מתי לשנות/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('paramInfoPopup')?.classList.contains('hidden') === true);
  }, 40000);

  it('keeps honesty tiles equal at 1024x600 and paints help above the params tab', async () => {
    await openParams(1024, 600);
    await page.waitForFunction(() => document.querySelectorAll('#paramsGrid .param-card').length >= 5);
    const layout = await page.evaluate(() => {
      const strip = document.getElementById('plndProfileHonestyKeys');
      const cards = [...document.querySelectorAll('#paramsGrid .param-card')].slice(0, 6).map((el) => {
        const box = el.getBoundingClientRect();
        const textFails = [];
        for (const node of el.querySelectorAll('p, span, button, label, h3')) {
          if (getComputedStyle(node).display === 'none') continue;
          if (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1) {
            textFails.push((node.className || node.tagName).toString().slice(0, 40));
          }
        }
        return { key: el.dataset.paramKey, w: box.width, h: box.height, top: box.top, bottom: box.bottom, left: box.left, right: box.right, textFails };
      });
      const grid = document.getElementById('paramsGrid').getBoundingClientRect();
      const firstCard = document.querySelector('#paramsGrid .param-card')?.getBoundingClientRect();
      return {
        stripDisplay: getComputedStyle(strip).display,
        cards,
        gridTop: grid.top,
        cardTop: firstCard ? firstCard.top : 9999,
        innerH: window.innerHeight,
        writeDisabled: document.getElementById('arduWriteBtn')?.disabled === true,
        faultHidden: document.getElementById('paramToolFault')?.hidden === true,
      };
    });
    expect(layout.stripDisplay).toBe('none');
    expect(layout.cards.length).toBeGreaterThanOrEqual(5);
    for (const card of layout.cards) expect(card.textFails, card.key).toEqual([]);
    expect(layout.gridTop).toBeGreaterThan(0);
    expect(layout.gridTop).toBeLessThan(layout.innerH);
    expect(layout.cardTop).toBeLessThan(layout.innerH);
    expect(layout.writeDisabled).toBe(true);
    expect(layout.faultHidden).toBe(true);
    for (let i = 0; i < layout.cards.length; i += 1) {
      for (let j = i + 1; j < layout.cards.length; j += 1) {
        const a = layout.cards[i];
        const b = layout.cards[j];
        const overlap = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        expect(overlap, `${a.key} ${b.key}`).toBe(false);
      }
    }

    await page.locator('#paramsGrid .param-card .param-info').first().click();
    const popup = page.locator('#paramInfoPopup');
    const help = await popup.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      let hiddenAncestor = false;
      let node = el.parentElement;
      while (node) {
        if (getComputedStyle(node).display === 'none') hiddenAncestor = true;
        node = node.parentElement;
      }
      const color = style.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const bg = style.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return {
        w: box.width,
        h: box.height,
        top: box.top,
        left: box.left,
        text: el.textContent || '',
        hiddenAncestor,
        parent: el.parentElement?.tagName || '',
        inTerrain: !!el.closest('#terrain'),
        hiddenClass: el.classList.contains('hidden'),
        color: color ? [Number(color[1]), Number(color[2]), Number(color[3])] : null,
        bg: bg ? [Number(bg[1]), Number(bg[2]), Number(bg[3])] : null,
      };
    });
    expect(help.hiddenClass, 'help paints').toBe(false);
    expect(help.hiddenAncestor).toBe(false);
    expect(help.inTerrain).toBe(false);
    expect(help.parent).toBe('BODY');
    expect(help.w).toBeGreaterThan(80);
    expect(help.h).toBeGreaterThan(24);
    expect(help.top).toBeGreaterThanOrEqual(0);
    expect(help.top + help.h).toBeLessThanOrEqual(600);
    expect(help.left).toBeGreaterThanOrEqual(0);
    expect(help.text).toMatch(/מתי לשנות/);
    expect(contrast(help.color, help.bg)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: path.join(shotDir, 'params-1024-help.png'), fullPage: false });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('paramInfoPopup')?.classList.contains('hidden') === true);
    const closed = await popup.evaluate((el) => ({
      hidden: el.classList.contains('hidden'),
      text: el.textContent || '',
    }));
    expect(closed.hidden).toBe(true);
    expect(closed.text).toBe('');
    await page.screenshot({ path: path.join(shotDir, 'params-1024x600.png'), fullPage: false });
  }, 40000);
});
