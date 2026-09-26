import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectTextFitFailures } from './text-fit-audit.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.VLC_ARM_QA_PORT || '4037';
const BASE = `http://127.0.0.1:${PORT}`;
const shots = '/opt/cursor/artifacts/arm-disarm';
const PREARM = 'PreArm: GPS speed error 1.2m/s Need 3D Fix לפני חימוש';

const viewports = [
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '360x740', width: 360, height: 740 },
];

const states = [
  {
    id: 'disarmed',
    mav: { connected: true, armedKnown: true, armed: false, flying: false, lastHeartbeatAgeMs: 200 },
  },
  {
    id: 'armed',
    mav: { connected: true, armedKnown: true, armed: true, flying: false, lastHeartbeatAgeMs: 200 },
  },
  {
    id: 'nolink',
    mav: { connected: false, armedKnown: false, armed: null, flying: false, lastHeartbeatAgeMs: null },
  },
  {
    id: 'refused',
    mav: { connected: true, armedKnown: true, armed: false, flying: false, lastHeartbeatAgeMs: 200 },
    refusal: PREARM,
  },
];

function stateCount() {
  return viewports.length * states.length;
}

function hud(extra) {
  return {
    rollDeg: 2,
    pitchDeg: -1,
    heading: 90,
    airspeed: 12.4,
    altitude: 40,
    flightMode: 5,
    batteryV: 12.4,
    gpsFixType: 3,
    gpsSats: 12,
    recentStatusTexts: [],
    ...extra,
  };
}

describe('ARM DISARM flight screen', () => {
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
    throw new Error('arm disarm server did not become healthy');
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

  it('fits arm controls for link and arm states at every viewport', async () => {
    const page = await browser.newPage();
    const sample = new Set(['1024x576-disarmed', '1024x576-armed', '1024x576-refused', '360x740-nolink']);
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightArmBtn');
      await page.evaluate(() => {
        document.fonts?.ready;
        window.applySseMissionHud = () => null;
      });
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const state of states) {
          const ui = await page.evaluate(({ mav, refusal }) => {
            applyFlightHud(mav);
            if (typeof showFlightArmRefusal === 'function') {
              showFlightArmRefusal(refusal || '');
            }
            const arm = document.getElementById('flightArmBtn');
            const disarm = document.getElementById('flightDisarmBtn');
            const reason = document.getElementById('flightArmReason');
            const note = document.getElementById('flightArmRefusal');
            const row = document.getElementById('flightArmRow');
            const hud = document.getElementById('flightHud');
            const hr = hud.getBoundingClientRect();
            const clipped = [];
            for (const el of [arm, disarm, reason, note]) {
              if (!el || el.hidden) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) continue;
              if (r.left < hr.left - 1 || r.top < hr.top - 1 || r.right > hr.right + 1 || r.bottom > hr.bottom + 1) {
                clipped.push(el.id);
              }
              if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
                clipped.push(`${el.id}-viewport`);
              }
            }
            return {
              armDisabled: arm.disabled,
              disarmDisabled: disarm.disabled,
              reasonHidden: reason.hidden,
              reason: reason.textContent,
              refusalHidden: note.hidden,
              refusal: note.textContent,
              link: row.dataset.armLink,
              clipped,
            };
          }, { mav: hud(state.mav), refusal: state.refusal || '' });
          const report = await page.evaluate(collectTextFitFailures, 1);
          const key = `${vp.name}-${state.id}`;
          if (sample.has(key)) {
            await page.screenshot({ path: path.join(shots, `${key}.png`) });
          }
          tested.push({ viewport: vp.name, state: state.id, fails: report.fails.length + ui.clipped.length });
          expect(ui.clipped, key).toEqual([]);
          expect(report.fails, `${key} ${JSON.stringify(report.fails.slice(0, 6))}`).toEqual([]);
          if (state.id === 'nolink') {
            expect(ui.armDisabled).toBe(true);
            expect(ui.disarmDisabled).toBe(true);
            expect(ui.reasonHidden).toBe(false);
            expect(ui.reason).toBe('אין חיבור לבקר הטיסה');
            expect(ui.link).toBe('off');
          } else if (state.id === 'disarmed' || state.id === 'refused') {
            expect(ui.armDisabled).toBe(false);
            expect(ui.disarmDisabled).toBe(true);
            expect(ui.reasonHidden).toBe(true);
            expect(ui.link).toBe('disarmed');
          } else if (state.id === 'armed') {
            expect(ui.armDisabled).toBe(true);
            expect(ui.disarmDisabled).toBe(false);
            expect(ui.reasonHidden).toBe(true);
            expect(ui.link).toBe('armed');
          }
          if (state.id === 'refused') {
            expect(ui.refusalHidden).toBe(false);
            expect(ui.refusal).toBe(PREARM);
          }
        }
      }
      expect(tested.length).toBe(stateCount());
    } finally {
      await page.close();
    }
  }, 120000);

  it('holds to arm, confirms disarm, and warns again in the air', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
    const posts = [];
    let armCalls = 0;
    await page.route('**/api/mavlink/arm-disarm', async (route) => {
      const body = route.request().postDataJSON();
      posts.push(body);
      if (body.action === 'arm') {
        armCalls += 1;
        const payload = armCalls === 1
          ? { ok: false, sent: true, prearm: PREARM, result: 4 }
          : { ok: true, sent: true, action: 'arm', result: 0 };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
        return;
      }
      if (body.action === 'disarm' && body.confirmFlying !== true && posts.filter((p) => p.action === 'disarm').length === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, sent: false, error: 'flying', flying: true }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, sent: true, action: body.action, result: 0 }),
      });
    });
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightArmBtn');
      await page.evaluate(() => {
        window.applySseMissionHud = () => null;
      });
      await page.evaluate((mav) => applyFlightHud(mav), hud({
        connected: true, armedKnown: true, armed: false, flying: false, lastHeartbeatAgeMs: 100,
      }));
      const arm = page.locator('#flightArmBtn');
      const box = await arm.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(400);
      await page.mouse.up();
      expect(posts.filter((p) => p.action === 'arm')).toHaveLength(0);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(1600);
      await page.mouse.up();
      expect(posts.filter((p) => p.action === 'arm')).toHaveLength(0);
      expect(await page.locator('#flightArmDialogText').textContent()).toBe('אשרו חימוש');
      await page.locator('#flightArmConfirm').click();
      expect(posts.filter((p) => p.action === 'arm')).toHaveLength(1);
      await page.waitForFunction(() => (document.getElementById('flightArmRefusal')?.textContent || '').includes('PreArm'));
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(1600);
      await page.mouse.up();
      expect(posts.filter((p) => p.action === 'arm')).toHaveLength(1);
      await page.locator('#flightArmConfirm').click();
      expect(posts.filter((p) => p.action === 'arm')).toHaveLength(2);
      for (const body of posts) expect(JSON.stringify(body)).not.toContain('21196');

      await page.evaluate((mav) => applyFlightHud(mav), hud({
        connected: true, armedKnown: true, armed: true, flying: false, lastHeartbeatAgeMs: 100,
        landedState: 1, landedStateAgeMs: 100,
      }));
      await page.locator('#flightDisarmBtn').click();
      expect(await page.locator('#flightDisarmDialogText').textContent()).toBe('אשרו נטרול');
      expect(posts.filter((p) => p.action === 'disarm')).toHaveLength(0);
      await page.locator('#flightDisarmConfirm').click();
      await page.waitForFunction(() => (document.getElementById('flightDisarmDialogText')?.textContent || '').includes('אשרו נטרול שוב.'));
      expect(posts.filter((p) => p.action === 'disarm')).toHaveLength(1);
      expect(posts.find((p) => p.action === 'disarm').confirmFlying).toBe(false);
      expect(posts.filter((p) => p.action === 'disarm' && p.confirmFlying === true)).toHaveLength(0);
      await page.locator('#flightDisarmConfirm').click();
      const tConfirm = Date.now();
      while (!posts.some((p) => p.action === 'disarm' && p.confirmFlying === true)) {
        if (Date.now() - tConfirm > 3000) break;
        await page.waitForTimeout(50);
      }
      expect(posts.filter((p) => p.action === 'disarm' && p.confirmFlying === true)).toHaveLength(1);
      for (const body of posts) expect(JSON.stringify(body)).not.toContain('21196');

      posts.length = 0;
      await page.evaluate((mav) => applyFlightHud(mav), hud({
        connected: true, armedKnown: true, armed: true, flying: true, lastHeartbeatAgeMs: 100,
        landedState: 2, landedStateAgeMs: 100,
      }));
      await page.locator('#flightDisarmBtn').click();
      await page.locator('#flightDisarmConfirm').click();
      expect(posts).toHaveLength(0);
      expect(await page.locator('#flightDisarmDialogText').textContent()).toContain('אשרו נטרול שוב.');
      const fit = await page.evaluate(collectTextFitFailures, 1);
      expect(fit.fails).toEqual([]);
      const clipped = await page.evaluate(() => {
        const hud = document.getElementById('flightHud').getBoundingClientRect();
        const text = document.getElementById('flightDisarmDialogText').getBoundingClientRect();
        return text.bottom > hud.bottom + 1 || text.right > hud.right + 1;
      });
      expect(clipped).toBe(false);
      await page.screenshot({ path: path.join(shots, '1024x576-flying-warning.png') });
      await page.locator('#flightDisarmConfirm').click();
      const tFly = Date.now();
      while (posts.length < 1) {
        if (Date.now() - tFly > 3000) break;
        await page.waitForTimeout(50);
      }
      expect(posts[0].confirmFlying).toBe(true);
      expect(JSON.stringify(posts[0])).not.toContain('21196');

      await page.evaluate((mav) => applyFlightHud(mav), hud({
        connected: true, armedKnown: true, armed: false, flying: false, lastHeartbeatAgeMs: 9000,
      }));
      const stale = await page.evaluate(() => ({
        arm: document.getElementById('flightArmBtn').disabled,
        disarm: document.getElementById('flightDisarmBtn').disabled,
        reason: document.getElementById('flightArmReason').textContent,
      }));
      expect(stale.arm).toBe(true);
      expect(stale.disarm).toBe(true);
      expect(stale.reason).toBe('אין חיבור לבקר הטיסה');
    } finally {
      await page.close();
    }
  }, 30000);
});
