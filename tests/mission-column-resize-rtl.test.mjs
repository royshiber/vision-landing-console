import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function loadSplit() {
  const src = [
    sliceFunction(js, 'missionSplitAtPointer'),
    'return missionSplitAtPointer;',
  ].join('\n');
  return new Function(src)();
}

describe('Mission column resize — pointer direction', () => {
  it('moves the boundary with the pointer so the left column grows when the pointer moves right', () => {
    const splitAt = loadSplit();
    const leftEdge = 40;
    const rightEdge = 640;
    const gap = 4;
    const minPx = 140;
    const at = (x) => splitAt(x, leftEdge, rightEdge, gap, minPx);
    const start = at(300);
    const right = at(380);
    const left = at(220);
    expect(right.left - start.left).toBeCloseTo(80, 5);
    expect(start.right - right.right).toBeCloseTo(80, 5);
    expect(start.left - left.left).toBeCloseTo(80, 5);
    expect(left.right - start.right).toBeCloseTo(80, 5);
    expect(right.x).toBeCloseTo(380, 5);
    expect(left.x).toBeCloseTo(220, 5);
    expect(right.left).toBeGreaterThan(start.left);
    expect(right.right).toBeLessThan(start.right);
  });

  it('keeps a usable floor and still follows a large drag', () => {
    const splitAt = loadSplit();
    const clamped = splitAt(20, 0, 800, 4, 140);
    expect(clamped.left).toBe(140);
    expect(clamped.right).toBe(800 - 4 - 140);
    const wide = splitAt(700, 0, 800, 4, 140);
    expect(wide.right).toBe(140);
    expect(wide.left).toBeGreaterThan(500);
  });

  it('binds column splitters with pointer events, not an inverted delta', () => {
    const split = sliceFunction(js, 'bindMissionSplitters');
    expect(split).toContain("addEventListener('pointerdown'");
    expect(split).toContain("addEventListener('pointermove'");
    expect(split).toContain("addEventListener('pointerup'");
    expect(split).toContain("addEventListener('pointercancel'");
    expect(split).toContain('setPointerCapture');
    expect(split).toContain('dblclick');
    expect(split).toContain('missionSplitAtPointer(ev.clientX');
    expect(split).not.toContain('base.c1 + delta');
    expect(split).not.toContain('base.c3 - delta');
    expect(css).toMatch(/\.mission-split\s*\{[^}]*touch-action:\s*none/);
  });
});

describe('Mission column resize — RTL flight screen', () => {
  const PORT = process.env.VLC_RESIZE_PORT || '4063';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;

  async function waitHealth(maxMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('column-resize server did not become healthy');
  }

  beforeAll(async () => {
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

  async function openFlight(width, height) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('vlc-resize-init') === '1') return;
      sessionStorage.setItem('vlc-resize-init', '1');
      localStorage.removeItem('visionLandingMissionSizeV4');
      localStorage.removeItem('visionLandingMissionColOpenV1');
      localStorage.setItem('visionLandingMissionSwapV1', 'map-horizon');
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#missionColSplit');
    await page.waitForFunction(() => {
      const map = document.querySelector('[data-mission-region="map"]');
      const horizon = document.querySelector('[data-mission-region="horizon"]');
      const talk = document.querySelector('[data-mission-region="talk"]');
      return map && horizon && talk
        && map.getBoundingClientRect().width > 200
        && horizon.getBoundingClientRect().width > 80
        && talk.getBoundingClientRect().width > 80;
    });
    return page;
  }

  async function measure(page) {
    return page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          top: r.top,
          height: r.height,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
        };
      };
      return {
        dir: document.documentElement.getAttribute('dir'),
        map: box(document.querySelector('[data-mission-region="map"]')),
        horizon: box(document.querySelector('[data-mission-region="horizon"]')),
        talk: box(document.querySelector('[data-mission-region="talk"]')),
        split: box(document.getElementById('missionColSplit')),
        splitB: box(document.getElementById('missionColSplitB')),
        ws: box(document.querySelector('.mission-workspace')),
      };
    });
  }

  async function drag(page, from, dx) {
    await page.mouse.move(from.cx, from.cy);
    await page.mouse.down();
    await page.mouse.move(from.cx + dx, from.cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(50);
  }

  async function touchDrag(page, from, dx) {
    const client = await page.context().newCDPSession(page);
    const y = from.cy;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.cx, y, id: 1 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.cx + dx, y, id: 1 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await page.waitForTimeout(50);
  }

  it('follows a rightward drag on an RTL page at 1440×900', async () => {
    const page = await openFlight(1440, 900);
    const before = await measure(page);
    expect(before.dir).toBe('rtl');
    expect(before.map.left).toBeLessThan(before.horizon.left);
    expect(before.horizon.left).toBeLessThan(before.talk.left);
    await drag(page, before.split, 100);
    const after = await measure(page);
    expect(after.map.width - before.map.width).toBeGreaterThan(70);
    expect(before.horizon.width - after.horizon.width).toBeGreaterThan(70);
    expect(Math.abs((after.map.width - before.map.width) - 100)).toBeLessThan(16);
    expect(Math.abs(after.split.cx - (before.split.cx + 100))).toBeLessThan(16);
    expect(after.talk.width).toBeGreaterThan(before.talk.width - 8);
    await page.close();
  }, 30000);

  it('opens the instruments column past the old 20% cap at 1366×768', async () => {
    const page = await openFlight(1366, 768);
    const before = await measure(page);
    expect(before.horizon.width / before.ws.width).toBeLessThan(0.22);
    await drag(page, before.split, -260);
    const after = await measure(page);
    expect(after.horizon.width).toBeGreaterThan(before.horizon.width + 180);
    expect(after.horizon.width / after.ws.width).toBeGreaterThan(0.28);
    expect(after.map.width).toBeGreaterThan(140);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visionLandingMissionSizeV4')));
    expect(saved.c1).toBeGreaterThan(200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-mission-region="horizon"]')?.getBoundingClientRect().width > 300);
    const kept = await measure(page);
    expect(Math.abs(kept.horizon.width - after.horizon.width)).toBeLessThan(12);
    await page.click('#missionResetLayoutBtn');
    await page.waitForTimeout(50);
    const reset = await measure(page);
    expect(Math.abs(reset.horizon.width - before.horizon.width)).toBeLessThan(16);
    expect(Math.abs(reset.map.width - before.map.width)).toBeLessThan(16);
    await page.close();
  }, 30000);

  it('follows a touch drag and collapses Ask on double-click', async () => {
    const page = await openFlight(1440, 900);
    const before = await measure(page);
    await touchDrag(page, before.splitB, -80);
    const dragged = await measure(page);
    expect(dragged.talk.width - before.talk.width).toBeGreaterThan(50);
    expect(before.horizon.width - dragged.horizon.width).toBeGreaterThan(50);
    await page.dblclick('#missionColSplitB');
    await page.waitForTimeout(50);
    const collapsed = await measure(page);
    expect(collapsed.talk.width).toBeLessThan(48);
    expect(collapsed.talk.width).toBeGreaterThan(20);
    await page.dblclick('#missionColSplitB');
    await page.waitForTimeout(50);
    const restored = await measure(page);
    expect(restored.talk.width).toBeGreaterThan(180);
    await page.close();
  }, 30000);
});
