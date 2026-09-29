import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4038';
const BASE = `http://127.0.0.1:${PORT}`;
const axePath = path.join(repoRoot, 'node_modules/axe-core/axe.min.js');

const viewports = [
  { name: '1024x600', width: 1024, height: 600 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
];

const tabs = [
  { id: 'terrain', root: '#terrain', exclude: ['.leaflet-container'] },
  { id: 'pulse', root: '#pulse', exclude: [] },
  { id: 'control', root: '#control', exclude: [] },
  { id: 'optics', root: '#optics', exclude: [] },
  { id: 'recordings', root: '#recordings', exclude: [] },
  { id: 'telemetry', root: '#telemetry', exclude: [] },
];

describe('WCAG AA color contrast across tabs', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, COMPANION_MODE: 'off', JETSON_COMPANION_BASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  async function openTab(page, id) {
    await page.evaluate((tabId) => {
      const btn = document.querySelector(`[data-tab="${tabId}"]`);
      if (btn) {
        btn.hidden = false;
        btn.disabled = false;
      }
      if (typeof applyMainTab === 'function') applyMainTab(tabId);
    }, id);
    await page.waitForSelector(`${tabs.find((t) => t.id === id).root}.panel.visible`, { timeout: 5000 });
  }

  it('flags no color-contrast violations at laptop sizes', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#missionLink');
      await page.addScriptTag({ path: axePath });
      const failures = [];
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const tab of tabs) {
          await openTab(page, tab.id);
          await page.waitForTimeout(150);
          const hits = await page.evaluate(async ({ root, exclude }) => {
            const result = await window.axe.run({ include: [[root]], exclude: exclude.map((sel) => [sel]) }, {
              runOnly: { type: 'rule', values: ['color-contrast'] },
              resultTypes: ['violations'],
            });
            return result.violations.flatMap((v) => v.nodes.map((n) => ({
              target: (n.target || []).join(' '),
              html: String(n.html || '').slice(0, 160),
              summary: String(n.failureSummary || '').split('\n')[0].slice(0, 180),
            })));
          }, tab);
          for (const hit of hits) failures.push(`${vp.name} ${tab.id} ${hit.target} ${hit.summary} ${hit.html}`);
        }
      }
      expect(failures, failures.slice(0, 24).join('\n')).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180000);

  it('keeps messages compact, the connect card inside the viewport, and params filled at 1024x600', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
    try {
      await page.addInitScript(() => {
        localStorage.removeItem('visionLandingMissionMessagesV1');
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-mission-region="messages"]');
      const messages = await page.evaluate(() => {
        const msg = document.querySelector('[data-mission-region="messages"]');
        const hud = document.querySelector('.mission-region-horizon > .flight-hud');
        const summary = document.getElementById('missionMessagesSummary');
        const count = document.getElementById('missionMessagesCount');
        const mr = msg.getBoundingClientRect();
        const hr = hud.getBoundingClientRect();
        return {
          expanded: msg.dataset.messagesExpanded,
          msgH: mr.height,
          hudH: hr.height,
          summary: summary ? summary.textContent : '',
          countHidden: count ? count.hidden : true,
          summaryOverflow: summary ? summary.scrollWidth - summary.clientWidth : 0,
        };
      });
      expect(messages.expanded).toBe('0');
      expect(messages.msgH).toBeLessThan(80);
      expect(messages.hudH).toBeGreaterThan(messages.msgH);
      expect(messages.summary).toContain('אין הודעות');
      expect(messages.summaryOverflow).toBeLessThanOrEqual(1);

      await page.click('#connectToggleBtn');
      await page.waitForSelector('#connectPanel:not([hidden])');
      const pop = await page.evaluate(() => {
        const panel = document.getElementById('connectPanel');
        const map = document.getElementById('terrainMap');
        const pr = panel.getBoundingClientRect();
        const mr = map.getBoundingClientRect();
        const cx = mr.left + mr.width / 2;
        const cy = mr.top + mr.height / 2;
        const coversCenter = cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom;
        const cs = getComputedStyle(panel);
        return {
          left: pr.left,
          right: pr.right,
          top: pr.top,
          bottom: pr.bottom,
          height: pr.height,
          vw: window.innerWidth,
          vh: window.innerHeight,
          coversCenter,
          overflowY: cs.overflowY,
          clipped: panel.scrollHeight - panel.clientHeight,
        };
      });
      expect(pop.left).toBeGreaterThanOrEqual(-1);
      expect(pop.right).toBeLessThanOrEqual(pop.vw + 1);
      expect(pop.top).toBeGreaterThanOrEqual(-1);
      expect(pop.bottom).toBeLessThanOrEqual(pop.vh + 1);
      expect(pop.height).toBeLessThanOrEqual(360);
      expect(pop.clipped).toBeLessThanOrEqual(2);
      expect(pop.coversCenter).toBe(false);

      await page.evaluate(() => applyMainTab('control'));
      await page.waitForSelector('#control.panel.visible');
      await page.waitForSelector('#paramsGrid .param-title');
      const params = await page.evaluate(() => {
        const honesty = document.getElementById('plndProfileHonesty');
        const grid = document.getElementById('paramsGrid');
        const control = document.getElementById('control');
        const title = document.querySelector('#paramsGrid .param-title');
        const card = title.closest('.param-card');
        const titleCs = getComputedStyle(title);
        const cardCs = getComputedStyle(card);
        const hCs = getComputedStyle(honesty);
        const gr = grid.getBoundingClientRect();
        const cr = control.getBoundingClientRect();
        return {
          honestyOverflow: hCs.overflowY,
          honestyClip: honesty.scrollHeight - honesty.clientHeight,
          gridGap: cr.bottom - gr.bottom,
          titleColor: titleCs.color,
          cardBg: cardCs.backgroundColor,
        };
      });
      expect(params.honestyOverflow).toBe('visible');
      expect(params.honestyClip).toBeLessThanOrEqual(2);
      expect(params.gridGap).toBeLessThanOrEqual(28);
      expect(params.titleColor).not.toBe('rgb(25, 28, 30)');
    } finally {
      await page.close();
    }
  }, 60000);
});
