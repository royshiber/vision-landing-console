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

  async function settle() {
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  }

  async function readLayout(seed) {
    return page.evaluate((seedLines) => {
      const list = document.getElementById('pfcMsgScroll');
      if (seedLines && list) {
        list.hidden = false;
        list.replaceChildren();
        for (let i = 0; i < 30; i += 1) {
          const line = document.createElement('p');
          line.className = 'pfc-msg-line';
          line.textContent = `14:52:40 CRITICAL PreArm line ${i} still configuring this GPS`;
          list.appendChild(line);
        }
      }
      const box = (el) => {
        if (!el) return { x: 0, y: 0, w: 0, h: 0 };
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const stage = document.getElementById('pfdHorizonStage');
      const dock = document.querySelector('[data-mission-region="messages"]');
      const data = document.querySelector('[data-mission-region="data"]');
      const map = document.querySelector('[data-mission-region="map"]');
      const horizon = document.querySelector('[data-mission-region="horizon"]');
      const msgScroll = document.getElementById('pfcMsgScroll');
      const actionsPane = document.getElementById('flightDockActionsPane');
      const msgCs = msgScroll ? getComputedStyle(msgScroll) : null;
      const actionsCs = actionsPane ? getComputedStyle(actionsPane) : null;
      return {
        stage: box(stage),
        dock: box(dock),
        data: box(data),
        map: box(map),
        horizon: box(horizon),
        msgScroll: box(msgScroll),
        scrollHeight: msgScroll ? msgScroll.scrollHeight : 0,
        clientHeight: msgScroll ? msgScroll.clientHeight : 0,
        overflowY: msgCs ? msgCs.overflowY : '',
        actionsDisplay: actionsCs ? actionsCs.display : '',
      };
    }, seed);
  }

  async function measure(swap) {
    await page.evaluate((mode) => {
      const ws = document.querySelector('.mission-workspace');
      if (ws) ws.dataset.missionSwap = mode;
    }, swap);
    await page.locator('#flightDockActionsTab').click();
    await settle();
    const actions = await readLayout(false);
    await page.locator('#flightDockMessagesTab').click();
    await settle();
    const messages = await readLayout(true);
    const scroll = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
    const overlap = actions.stage.y + actions.stage.h > actions.dock.y + 2
      && actions.stage.y < actions.dock.y + actions.dock.h;
    return {
      actionStage: actions.stage,
      messageStage: messages.stage,
      actionDock: actions.dock,
      messageDock: messages.dock,
      actionData: actions.data,
      messageData: messages.data,
      actionMap: actions.map,
      messageMap: messages.map,
      actionHorizon: actions.horizon,
      messageHorizon: messages.horizon,
      msgScroll: messages.msgScroll,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      overflowY: messages.overflowY,
      actionsDisplay: messages.actionsDisplay,
      scroll,
      overlap,
      ratio: actions.stage.w / Math.max(1, actions.stage.h),
    };
  }

  for (const vp of widths) {
    it(`keeps the horizon box when the dock tab changes at ${vp.name}`, async () => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const map = await measure('map-horizon');
      expect(nearly(map.actionStage.x, map.messageStage.x)).toBe(true);
      expect(nearly(map.actionStage.y, map.messageStage.y)).toBe(true);
      expect(nearly(map.actionStage.w, map.messageStage.w)).toBe(true);
      expect(nearly(map.actionStage.h, map.messageStage.h)).toBe(true);
      expect(nearly(map.actionData.x, map.messageData.x)).toBe(true);
      expect(nearly(map.actionData.y, map.messageData.y)).toBe(true);
      expect(nearly(map.actionData.w, map.messageData.w)).toBe(true);
      expect(nearly(map.actionData.h, map.messageData.h)).toBe(true);
      expect(nearly(map.actionDock.h, map.messageDock.h)).toBe(true);
      expect(map.actionsDisplay).toBe('none');
      expect(map.overflowY).toBe('auto');
      expect(map.clientHeight).toBeGreaterThanOrEqual(vp.height < 520 ? 40 : map.messageDock.h * 0.4);
      expect(map.scrollHeight).toBeGreaterThan(map.clientHeight);
      expect(map.msgScroll.y).toBeGreaterThanOrEqual(map.messageDock.y - 1);
      expect(map.msgScroll.y + map.msgScroll.h).toBeLessThanOrEqual(map.messageDock.y + map.messageDock.h + 2);
      expect(map.scroll).toBeLessThanOrEqual(4);
      expect(map.overlap).toBe(false);
      expect(map.ratio).toBeGreaterThan(0.7);
      expect(map.ratio).toBeLessThanOrEqual(1.2);
      const swapped = await measure('horizon-map');
      expect(nearly(swapped.actionStage.x, swapped.messageStage.x)).toBe(true);
      expect(nearly(swapped.actionStage.y, swapped.messageStage.y)).toBe(true);
      expect(nearly(swapped.actionStage.w, swapped.messageStage.w)).toBe(true);
      expect(nearly(swapped.actionStage.h, swapped.messageStage.h)).toBe(true);
      expect(nearly(swapped.actionData.h, swapped.messageData.h)).toBe(true);
      expect(nearly(swapped.actionDock.h, swapped.messageDock.h)).toBe(true);
      expect(swapped.actionsDisplay).toBe('none');
      expect(swapped.overflowY).toBe('auto');
      expect(swapped.clientHeight).toBeGreaterThanOrEqual(vp.height < 520 ? 40 : swapped.messageDock.h * 0.4);
      expect(swapped.scrollHeight).toBeGreaterThan(swapped.clientHeight);
      expect(swapped.scroll).toBeLessThanOrEqual(4);
      expect(swapped.ratio).toBeGreaterThan(0.7);
      expect(swapped.ratio).toBeLessThanOrEqual(1.2);
      expect(swapped.actionHorizon.w).toBeGreaterThan(swapped.actionMap.w * 1.4);
      expect(swapped.actionStage.w).toBeGreaterThan(map.actionStage.w);
      expect(nearly(swapped.actionMap.w, swapped.messageMap.w)).toBe(true);
      expect(nearly(swapped.actionMap.h, swapped.messageMap.h)).toBe(true);
      expect(nearly(map.actionDock.h, swapped.actionDock.h)).toBe(true);
      const cover = await page.evaluate(() => {
        const img = document.getElementById('horizonCameraBg');
        const stage = document.getElementById('pfdHorizonStage');
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#16a34a';
        ctx.fillRect(0, 0, 160, 90);
        img.hidden = false;
        img.src = canvas.toDataURL('image/png');
        if (typeof fitHorizonPicture === 'function') fitHorizonPicture(img);
        const picture = img.getBoundingClientRect();
        const horizon = stage.getBoundingClientRect();
        const style = getComputedStyle(img);
        return {
          dw: Math.abs(picture.width - horizon.width),
          dh: Math.abs(picture.height - horizon.height),
          fit: style.objectFit,
          transform: style.transform,
        };
      });
      expect(cover.fit).toBe('cover');
      expect(cover.dw).toBeLessThan(3);
      expect(cover.dh).toBeLessThan(3);
      expect(cover.transform === 'none' || cover.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
    });
  }
});
