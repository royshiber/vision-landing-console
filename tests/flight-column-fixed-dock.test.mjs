import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from './test-server.mjs';

const widths = [
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1024x470', width: 1024, height: 470 },
  { name: '1280x600', width: 1280, height: 600 },
  { name: '1366x630', width: 1366, height: 630 },
  { name: '1536x730', width: 1536, height: 730 },
  { name: '1920x950', width: 1920, height: 950 },
];

function nearly(a, b, slack = 2) {
  return Math.abs(a - b) <= slack;
}

describe('flight column dock stays put', () => {
  let browser = null;
  let page = null;
  let serverProc = null;

  beforeAll(async () => {
    const started = await startTestServer({
      env: (port) => ({ SQLITE_PATH: `/tmp/airvix-flight-dock-fixed-${port}.sqlite` }),
    });
    serverProc = started.child;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(started.base, { waitUntil: 'domcontentloaded' });
    await page.locator('.tab[data-tab="terrain"]').click();
    await page.waitForSelector('#pfdHorizonStage', { state: 'visible' });
    await page.evaluate(() => {
      const ws = document.querySelector('.mission-workspace');
      if (ws) ws.dataset.askOpen = '0';
    });
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  async function measure(swap) {
    return page.evaluate((mode) => {
      const ws = document.querySelector('.mission-workspace');
      if (ws) ws.dataset.missionSwap = mode;
      const stage = document.getElementById('pfdHorizonStage');
      const dock = document.querySelector('[data-mission-region="messages"]');
      const hud = document.querySelector('.mission-region-horizon > .flight-hud');
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const actions = document.getElementById('flightDockActionsTab');
      const messages = document.getElementById('flightDockMessagesTab');
      actions.click();
      const actionStage = box(stage);
      const actionDock = box(dock);
      messages.click();
      const messageStage = box(stage);
      const messageDock = box(dock);
      const scroll = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const overlap = actionStage.y + actionStage.h > actionDock.y + 2
        && actionStage.y < actionDock.y + actionDock.h;
      return {
        actionStage,
        messageStage,
        actionDock,
        messageDock,
        scroll,
        overlap,
        ratio: actionStage.w / Math.max(1, actionStage.h),
      };
    }, swap);
  }

  for (const vp of widths) {
    it(`keeps the horizon box when the dock tab changes at ${vp.name}`, async () => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const map = await measure('map-horizon');
      expect(nearly(map.actionStage.w, map.messageStage.w)).toBe(true);
      expect(nearly(map.actionStage.h, map.messageStage.h)).toBe(true);
      expect(nearly(map.actionStage.y, map.messageStage.y)).toBe(true);
      expect(nearly(map.actionDock.h, map.messageDock.h)).toBe(true);
      expect(map.scroll).toBeLessThanOrEqual(4);
      expect(map.overlap).toBe(false);
      expect(map.ratio).toBeGreaterThan(0.7);
      expect(map.ratio).toBeLessThan(vp.height < 520 ? 2.15 : 1.55);
      const swapped = await measure('horizon-map');
      expect(nearly(swapped.actionStage.h, swapped.messageStage.h)).toBe(true);
      expect(nearly(swapped.actionDock.h, swapped.messageDock.h)).toBe(true);
      expect(swapped.scroll).toBeLessThanOrEqual(4);
      expect(swapped.ratio).toBeGreaterThan(0.85);
      expect(swapped.ratio).toBeLessThan(vp.height < 520 ? 2.4 : 1.7);
    });
  }
});
