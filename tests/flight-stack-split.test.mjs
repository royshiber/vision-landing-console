/**
 * The flight column splits horizon, tiles, and messages with two drag borders.
 * Heights persist. A double-click restores the defaults. Loopback only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/screenshots';
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

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

function contrastRatio(a, b) {
  const parse = (color) => {
    const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return [1, 2, 3].map((i) => {
      const x = Number(m[i]) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
  };
  const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return 0;
  const hi = Math.max(lum(A), lum(B));
  const lo = Math.min(lum(A), lum(B));
  return (hi + 0.05) / (lo + 0.05);
}

describe('flight stack splitters', () => {
  it('shares two in-flow horizontal splitters for the flight column', () => {
    expect(html).toMatch(/id="flightStackSplitData"/);
    expect(html).toMatch(/id="flightStackSplitMsg"/);
    expect(html.indexOf('flightStackSplitData')).toBeLessThan(html.indexOf('data-mission-region="data"'));
    expect(html.indexOf('data-mission-region="data"')).toBeLessThan(html.indexOf('flightStackSplitMsg'));
    expect(html.indexOf('flightStackSplitMsg')).toBeLessThan(html.indexOf('data-mission-region="messages"'));
    expect(js).toContain("const FLIGHT_STACK_KEY = 'visionLandingFlightStackV1'");
    expect(js).toContain('function bindFlightStackSplitters(');
    expect(js).toContain('function resetFlightStack(');
    expect(css).toMatch(/\.flight-stack-split\s*\{[^}]*cursor:\s*row-resize/);
    expect(css).toMatch(/\.flight-stack-split\s*\{[^}]*touch-action:\s*none/);
    expect(css).toMatch(/\.flight-stack-split::after\s*\{[^}]*background:\s*#e2e8f0/);
  });
});

describe('flight stack splitters live', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('drags both borders, keeps the sizes after reload, and resets on double-click', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-flight-stack-${process.pid}.sqlite`);
    proc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
      },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(up).toBe(true);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    fs.mkdirSync(shotDir, { recursive: true });

    async function measure() {
      return page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
        };
        const horizon = document.querySelector('[data-mission-region="horizon"]');
        const data = document.querySelector('[data-mission-region="data"]');
        const messages = document.querySelector('[data-mission-region="messages"]');
        const hud = document.querySelector('.mission-region-horizon > .flight-hud');
        const stage = document.getElementById('pfdHorizonStage');
        const scroll = document.getElementById('pfcMsgScroll');
        const summary = document.getElementById('missionMessagesSummary');
        const count = document.getElementById('missionMessagesCount');
        const dataSplit = document.getElementById('flightStackSplitData');
        const msgSplit = document.getElementById('flightStackSplitMsg');
        const handleCs = dataSplit ? getComputedStyle(dataSplit, '::after') : null;
        const splitCs = dataSplit ? getComputedStyle(dataSplit) : null;
        const grid = document.getElementById('missionDataGrid');
        const gridOver = grid ? Math.max(0, grid.scrollWidth - grid.clientWidth, grid.scrollHeight - grid.clientHeight) : 0;
        const tiles = [...document.querySelectorAll('.mission-data-tile')].map((el) => {
          const r = el.getBoundingClientRect();
          const label = el.querySelector('.mission-data-label');
          const value = el.querySelector('.mission-data-value');
          const unit = el.querySelector('.mission-data-unit');
          const track = el.querySelector('.confidence-track');
          const pair = el.querySelector('.mission-data-pair') || value;
          const vr = value ? value.getBoundingClientRect() : null;
          const ur = unit ? unit.getBoundingClientRect() : null;
          const tr = track ? track.getBoundingClientRect() : null;
          const lr = label ? label.getBoundingClientRect() : null;
          const pr = pair ? pair.getBoundingClientRect() : null;
          const readout = el.querySelector('.mission-data-readout');
          const rr = readout ? readout.getBoundingClientRect() : null;
          return {
            bottom: r.bottom,
            top: r.top,
            height: r.height,
            width: r.width,
            textH: (lr?.height || 0) + (rr?.height || 0),
            labelOver: label ? Math.max(label.scrollWidth - label.clientWidth, label.scrollHeight - label.clientHeight) : 0,
            valueOver: value ? Math.max(value.scrollWidth - value.clientWidth, value.scrollHeight - value.clientHeight) : 0,
            valueCenter: vr ? (vr.top + vr.bottom) / 2 : null,
            unitCenter: ur ? (ur.top + ur.bottom) / 2 : null,
            labelCenterX: lr ? (lr.left + lr.right) / 2 : null,
            pairCenterX: pr ? (pr.left + pr.right) / 2 : null,
            valueBottom: vr ? vr.bottom : null,
            trackTop: tr ? tr.top : null,
            trackWidth: tr ? tr.width : null,
          };
        });
        const stack = [hud, data, messages, horizon];
        const vertical = [];
        horizon.querySelectorAll('*').forEach((el) => {
          const oy = getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') return;
          if (el.scrollHeight > el.clientHeight + 2) vertical.push(el.id || el.className);
        });
        const summaryOver = summary ? summary.scrollHeight - summary.clientHeight : 0;
        return {
          hud: box(hud),
          data: box(data),
          messages: box(messages),
          stage: box(stage),
          scrollH: scroll ? scroll.clientHeight : 0,
          expanded: messages?.dataset.messagesExpanded || '',
          summary: summary?.textContent || '',
          countHidden: count ? count.hidden : true,
          summaryOver,
          gridOver,
          tiles,
          vertical,
          cursor: splitCs?.cursor || '',
          handle: handleCs?.backgroundColor || '',
          splitBg: splitCs?.backgroundColor || '',
          touch: splitCs?.touchAction || '',
          stored: localStorage.getItem('visionLandingFlightStackV1'),
          order: {
            hud: box(hud)?.bottom,
            dataSplit: box(dataSplit)?.top,
            data: box(data)?.top,
            msgSplit: box(msgSplit)?.top,
            messages: box(messages)?.top,
          },
        };
      });
    }

    async function drag(id, dy, pointerType) {
      if (pointerType === 'touch') {
        await page.evaluate(({ id: targetId, dy: delta }) => {
          const el = document.getElementById(targetId);
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const opts = (clientY, type) => ({
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY,
            pointerId: 7,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            isPrimary: true,
          });
          el.dispatchEvent(new PointerEvent('pointerdown', opts(y, 'pointerdown')));
          window.dispatchEvent(new PointerEvent('pointermove', opts(y + delta, 'pointermove')));
          window.dispatchEvent(new PointerEvent('pointerup', opts(y + delta, 'pointerup')));
        }, { id, dy });
        return;
      }
      const handle = page.locator(`#${id}`);
      const box = await handle.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy, { steps: 6 });
      await page.mouse.up();
    }

    const sizes = [
      { width: 1024, height: 600, name: '1024x600' },
      { width: 1366, height: 768, name: '1366x768' },
      { width: 1440, height: 900, name: '1440x900' },
    ];

    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.removeItem('visionLandingFlightStackV1');
        localStorage.removeItem('visionLandingMissionMessagesV1');
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightStackSplitData');
      await page.waitForSelector('[data-mission-region="messages"]');
      await page.waitForFunction(() => {
        const messages = document.querySelector('[data-mission-region="messages"]');
        return messages && messages.getBoundingClientRect().height >= 120;
      });
      await page.waitForFunction(() => {
        const data = document.querySelector('[data-mission-region="data"]');
        const grid = document.getElementById('missionDataGrid');
        if (!data || !grid) return false;
        return data.getBoundingClientRect().bottom + 1 >= grid.getBoundingClientRect().bottom;
      });
      const before = await measure();
      expect(before.cursor, size.name).toBe('row-resize');
      expect(before.touch, size.name).toBe('none');
      expect(contrastRatio(before.handle, before.splitBg), size.name).toBeGreaterThanOrEqual(4.5);
      expect(before.expanded, size.name).toBe('1');
      expect(before.summary, size.name).toContain('אין הודעות');
      expect(before.summaryOver, size.name).toBeLessThanOrEqual(1);
      expect(before.messages.height, size.name).toBeGreaterThanOrEqual(120);
      expect(before.hud.height, size.name).toBeGreaterThan(before.messages.height);
      expect(before.stage.width, size.name).toBeGreaterThan(before.hud.width * 0.9);
      expect(before.stage.height, size.name).toBeGreaterThanOrEqual(48);
      const tallestText = Math.max(...before.tiles.map((tile) => tile.textH));
      expect(tallestText, size.name).toBeGreaterThanOrEqual(20);
      expect(before.data.height, size.name).toBeGreaterThanOrEqual(tallestText);
      expect(before.data.height, size.name).toBeLessThanOrEqual(tallestText + 28);
      expect(before.data.height, size.name).toBeLessThan(88);
      for (const tile of before.tiles) {
        expect(tile.height, size.name).toBeLessThanOrEqual(before.data.height);
        expect(tile.height, size.name).toBeGreaterThanOrEqual(tile.textH);
      }
      const tileTops = before.tiles.map((tile) => tile.top);
      expect(Math.max(...tileTops) - Math.min(...tileTops), size.name).toBeLessThanOrEqual(4);
      const tileWidths = before.tiles.map((tile) => tile.width);
      expect(Math.max(...tileWidths) - Math.min(...tileWidths), size.name).toBeLessThanOrEqual(8);
      expect(before.hud.height, size.name).toBeGreaterThanOrEqual(200);
      for (const tile of before.tiles) {
        if (tile.unitCenter != null) {
          expect(Math.abs(tile.valueCenter - tile.unitCenter), size.name).toBeLessThan(4);
        }
        if (tile.labelCenterX != null && tile.pairCenterX != null) {
          expect(Math.abs(tile.labelCenterX - tile.pairCenterX), size.name).toBeLessThan(4);
        }
        if (tile.trackWidth != null) {
          expect(tile.trackTop, size.name).toBeGreaterThanOrEqual(tile.valueBottom - 1);
          expect(tile.trackWidth, size.name).toBeGreaterThan(tile.width * 0.7);
        }
      }
      expect(before.gridOver, size.name).toBeLessThanOrEqual(1);
      expect(before.order.hud, size.name).toBeLessThanOrEqual(before.order.dataSplit + 2);
      expect(before.order.data, size.name).toBeLessThanOrEqual(before.order.msgSplit + 2);
      expect(before.order.msgSplit, size.name).toBeLessThanOrEqual(before.order.messages + 2);
      for (const tile of before.tiles) {
        expect(tile.labelOver, size.name).toBeLessThanOrEqual(1);
        expect(tile.valueOver, size.name).toBeLessThanOrEqual(1);
        expect(tile.bottom, size.name).toBeLessThanOrEqual(before.data.bottom + 1);
        expect(tile.top, size.name).toBeGreaterThanOrEqual(before.data.top - 1);
      }
      expect(before.vertical.filter((id) => id !== 'pfcMsgScroll'), size.name).toEqual([]);

      await drag('flightStackSplitMsg', 48, 'touch');
      const lower = await measure();
      expect(lower.messages.height, size.name).toBeLessThan(before.messages.height - 20);
      expect(lower.data.height, size.name).toBeGreaterThan(before.data.height + 12);
      await drag('flightStackSplitData', 28, 'mouse');
      const dragged = await measure();
      expect(dragged.messages.height, size.name).toBeLessThan(before.messages.height - 20);
      expect(dragged.hud.height, size.name).toBeGreaterThan(lower.hud.height + 12);
      expect(dragged.data.height, size.name).toBeLessThan(lower.data.height - 12);
      expect(dragged.expanded, size.name).toBe('1');
      expect(dragged.hud.height, size.name).toBeGreaterThanOrEqual(140);
      expect(dragged.stage.height, size.name).toBeGreaterThanOrEqual(64);
      for (const tile of dragged.tiles) {
        expect(tile.bottom, size.name).toBeLessThanOrEqual(dragged.data.bottom + 1);
        expect(tile.labelOver, size.name).toBeLessThanOrEqual(1);
      }
      expect(dragged.vertical.filter((id) => id !== 'pfcMsgScroll'), size.name).toEqual([]);
      expect(dragged.summary, size.name).toContain('אין הודעות');
      await drag('flightStackSplitData', -20, 'mouse');
      const raised = await measure();
      expect(raised.hud.height, size.name).toBeLessThan(dragged.hud.height - 8);
      const saved = {
        data: raised.data.height,
        msg: raised.messages.height,
      };
      await page.screenshot({
        path: path.join(shotDir, `flight-stack-${size.name}.png`),
        fullPage: false,
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightStackSplitMsg');
      const kept = await measure();
      expect(Math.abs(kept.data.height - saved.data), size.name).toBeLessThanOrEqual(3);
      expect(Math.abs(kept.messages.height - saved.msg), size.name).toBeLessThanOrEqual(3);
      expect(kept.expanded, size.name).toBe('1');
      expect(kept.stored, size.name).toBeTruthy();

      await page.dblclick('#flightStackSplitData');
      const reset = await measure();
      expect(reset.expanded, size.name).toBe('1');
      expect(reset.messages.height, size.name).toBeGreaterThanOrEqual(120);
      expect(Math.abs(reset.messages.height - before.messages.height), size.name).toBeLessThanOrEqual(24);
      expect(Math.abs(reset.data.height - before.data.height), size.name).toBeLessThanOrEqual(8);
      expect(reset.summary, size.name).toContain('אין הודעות');
      expect(reset.summaryOver, size.name).toBeLessThanOrEqual(1);
    }
  }, 90000);
});
