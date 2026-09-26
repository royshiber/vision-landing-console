import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectTextFitFailures } from './text-fit-audit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.VLC_TEXT_FIT_PORT || '4035';
const BASE = `http://127.0.0.1:${PORT}`;
const shots = '/opt/cursor/artifacts/text-fit';

const viewports = [
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '360x740', width: 360, height: 740 },
];

const surfaces = [
  { id: 'terrain', tab: 'terrain' },
  { id: 'pulse', tab: 'pulse' },
  { id: 'control', tab: 'control' },
  { id: 'recordings', tab: 'recordings' },
  { id: 'settings', tab: 'terrain', settings: true },
];

function stateCount() {
  return viewports.length * surfaces.length;
}

describe('Text fit matrix', () => {
  let serverProc = null;
  let browser = null;
  const tested = [];

  async function waitHealth(maxMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('text fit server did not become healthy');
  }

  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
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
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    fs.writeFileSync(path.join(shots, 'summary.json'), JSON.stringify({
      states: tested.length,
      expected: stateCount(),
      fails: tested.reduce((n, row) => n + row.fails, 0),
    }, null, 2));
  }, 30000);

  it('fits every visible string on every tab and viewport', async () => {
    const page = await browser.newPage();
    const sampleShots = new Set(['1024x576-terrain', '1024x576-settings', '360x740-terrain', '360x740-pulse']);
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#missionLink');
      await page.evaluate(() => document.fonts?.ready);
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const surface of surfaces) {
          await page.evaluate(async ({ tab, settings }) => {
            if (typeof applyMainTab === 'function') applyMainTab(tab);
            const modal = document.getElementById('globalSettingsModal');
            if (modal) modal.hidden = !settings;
            const set = (id, text) => {
              const el = document.getElementById(id);
              if (el) el.textContent = text;
            };
            set('missionLink', 'מחשב משימה לא מגיב');
            set('pfdModeVal', 'ALT_HOLD');
            set('hudFlightMode', 'ALTITUDE');
            set('pfdArmedBadge', 'DISARMED');
            set('hudNavGpsVal', 'NO GPS FIX');
            const note = document.querySelector('.mission-horizon-filler-note');
            if (note) note.textContent = 'אין חיבור לבקר. אין הודעות נכנסות.';
            const health = document.querySelector('.pulse-health-note');
            if (health) health.textContent = 'מחשב משימה לא מגיב לבדיקת הבריאות דרך הרשת';
            set('pulseJetsonLoad', '98.6%');
            set('pulseJetsonMem', '4096/8192MB');
            set('pulseJetsonTemp', '72.4C');
            set('pulseJetsonVersion', 'companion-1.02.335-long');
            document.querySelectorAll('.param-title').forEach((el, i) => {
              if (i < 4) el.textContent = 'ATC_RAT_PIT_FF ארוך';
            });
            document.querySelectorAll('.gs-hint').forEach((el) => {
              if ((el.textContent || '').trim().length < 24) {
                el.textContent = 'כתובת הזרם ארוכה מדי לתיבה צרה וצריכה להישבר לשתי שורות';
              }
            });
          }, surface);
          await page.waitForTimeout(200);
          const report = await page.evaluate(collectTextFitFailures, 1);
          tested.push({
            viewport: vp.name,
            surface: surface.id,
            checked: report.checked,
            fails: report.fails.length,
          });
          const key = `${vp.name}-${surface.id}`;
          if (sampleShots.has(key)) {
            await page.screenshot({ path: path.join(shots, `${key}.png`), fullPage: false });
          }
          expect(report.fails, `${key}\n${JSON.stringify(report.fails.slice(0, 12), null, 2)}`).toEqual([]);
        }
      }
    } finally {
      expect(tested.length).toBe(stateCount());
      await page.close();
    }
  }, 180000);
});
