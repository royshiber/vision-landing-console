/**
 * Flight column dock, map follow, and explicit recording. Loopback only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

describe('flight dock and map source', () => {
  it('drops the duplicate status row and keeps the flight tab strip', () => {
    expect(html).not.toContain('id="missionHorizonFiller"');
    expect(html).not.toContain('id="hudDataGrid"');
    const data = html.slice(html.indexOf('data-mission-region="data"'), html.indexOf('flightStackSplitMsg'));
    expect(data).not.toContain('מצב בקר');
    expect(data).not.toContain('id="hudDataGrid"');
    expect(data).toMatch(/ביטחון נחיתה/);
    expect(data).toMatch(/id="liveConfidenceText"/);
    expect(html).toMatch(/id="flightDockQuickTab"[^>]*>מהיר</);
    expect(html).toMatch(/id="flightDockActionsTab"[^>]*>פעולות</);
    expect(html).toMatch(/id="flightDockMessagesTab"[^>]*>הודעות</);
    expect(html).toMatch(/id="flightDockPreflightTab"[^>]*>טרום</);
    expect(html).not.toMatch(/id="flightDockGaugesTab"/);
    expect(html.match(/id="preflightReadiness"/g)).toHaveLength(1);
    expect(html.indexOf('id="flightDockPreflightPane"')).toBeLessThan(html.indexOf('id="preflightReadiness"'));
    expect(html).toMatch(/id="flightDockDoAction"[^>]*disabled/);
    expect(html).toMatch(/id="flightDockSetWp"[^>]*disabled/);
    expect(html).toMatch(/id="flightDockSetMount"[^>]*disabled/);
    expect(html).toContain('פעולה, נקודה ומתלה בלי שליחה');
    expect(html).toContain('>בית</option>');
    expect(html).toMatch(/id="terrainFollowBtn"[^>]*>עקוב</);
    expect(html).toMatch(/id="terrainFlightRecordState"[^>]*>לא מקליט</);
    expect(js).toContain('function applyFlightDock(');
    expect(js).toContain("fetch('/api/assist/voice-flight'");
    expect(js).toContain('function flightPathActive(');
    expect(js).not.toContain('/api/fc/set-mode');
    expect(js).not.toMatch(/telemetry-archive\/start[\s\S]{0,80}DOMContentLoaded/);
    const boot = js.slice(js.indexOf('function initFlightArchiveRecord'), js.indexOf('function initAppUpdateNotice'));
    expect(boot).toContain("'/api/telemetry-archive/start'");
    expect(boot).toContain('paintRecordChrome(false)');
    expect(boot.indexOf('paintRecordChrome(false)')).toBeLessThan(boot.indexOf('void refresh()'));
  });
});

describe('flight dock and map live', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('switches the bottom pane, follows the aircraft, and records only after a click', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-flight-dock-${process.pid}.sqlite`);
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
    const starts = [];
    const page = await browser.newPage();
    const voice = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/telemetry-archive/start')) starts.push(req.url());
      if (req.method() === 'POST' && req.url().includes('/api/assist/voice-flight')) voice.push(req.postData() || '');
    });

    const sizes = [
      { width: 1024, height: 600 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ];
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.removeItem('visionLandingFlightDockV1');
        localStorage.removeItem('visionLandingFlightFollowV1');
        localStorage.removeItem('visionLandingFlightStackV1');
        localStorage.removeItem('visionLandingMissionMessagesV1');
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightDockMessagesTab');
      await page.waitForSelector('#terrainMap');
      expect(starts, `${size.width}`).toEqual([]);
      const idle = await page.evaluate(() => ({
        filler: !!document.getElementById('missionHorizonFiller'),
        dock: document.querySelector('[data-mission-region="messages"]')?.dataset.flightDock,
        note: getComputedStyle(document.getElementById('flightActionsNote')).display,
        list: getComputedStyle(document.getElementById('flightDockMessagesPane')).display,
        quick: getComputedStyle(document.getElementById('flightDockQuickPane')).display,
        state: document.getElementById('terrainFlightRecordState')?.textContent,
        gs: [...document.querySelectorAll('.hud-slot-label')].map((el) => el.textContent).join(' '),
      }));
      expect(idle.filler).toBe(false);
      expect(idle.dock).toBe('messages');
      expect(idle.note).not.toBe('none');
      expect(idle.list).toBe('flex');
      expect(idle.quick).toBe('none');
      expect(idle.state).toBe('לא מקליט');
      expect(idle.gs).not.toMatch(/GS|Vision/);
      const fit = await page.evaluate(() => ['terrainFollowBtn', 'terrainFlightRecordBtn', 'terrainFlightRecordState', 'flightDockQuickTab', 'flightDockActionsTab', 'flightDockMessagesTab', 'flightDockPreflightTab', 'flightActionsNote'].map((id) => {
        const el = document.getElementById(id);
        return {
          id,
          over: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight),
        };
      }));
      for (const row of fit) expect(row.over, `${size.width} ${row.id}`).toBeLessThanOrEqual(1);

      await page.click('#flightDockActionsTab');
      await page.waitForFunction(() => document.querySelector('[data-mission-region="messages"]').dataset.flightDock === 'actions');
      const actions = await page.evaluate(() => {
        const reason = document.getElementById('flightDockDisabledReason');
        const tab = document.getElementById('flightDockActionsTab');
        const cs = getComputedStyle(reason);
        const tabCs = getComputedStyle(tab);
        const ids = ['flightDockDoAction', 'flightDockSetWp', 'flightDockSetMount', 'flightDockActionSelect', 'flightDockWpSelect', 'flightDockMountSelect'];
        return {
          dock: document.querySelector('[data-mission-region="messages"]').dataset.flightDock,
          reason: reason.textContent,
          shown: cs.display !== 'none',
          list: getComputedStyle(document.getElementById('flightDockMessagesPane')).display,
          preflight: getComputedStyle(document.getElementById('flightDockPreflightPane')).display,
          disabled: ids.every((id) => document.getElementById(id).disabled),
          setMode: document.getElementById('flightDockSetMode').disabled,
          tabColor: tabCs.color,
          tabBg: tabCs.backgroundColor,
          over: Math.max(reason.scrollWidth - reason.clientWidth, reason.scrollHeight - reason.clientHeight),
        };
      });
      expect(actions.dock).toBe('actions');
      expect(actions.shown).toBe(true);
      expect(actions.list).toBe('none');
      expect(actions.preflight).toBe('none');
      expect(actions.disabled).toBe(true);
      expect(actions.setMode).toBe(false);
      expect(actions.reason).toContain('בלי שליחה');
      expect(actions.over).toBeLessThanOrEqual(1);
      const tabRatio = contrastRatio(actions.tabColor, actions.tabBg);
      expect(tabRatio).toBeGreaterThanOrEqual(4.5);

      await page.click('#flightDockQuickTab');
      const quick = await page.evaluate(() => ({
        arm: document.getElementById('flightQuickArm').textContent,
        rtl: document.getElementById('flightQuickRtl').disabled,
      }));
      expect(quick.arm).toContain('לא ידוע');
      expect(quick.rtl).toBe(false);

      await page.click('#flightDockPreflightTab');
      const preflight = await page.evaluate(() => {
        const pane = document.getElementById('flightDockPreflightPane');
        const list = document.getElementById('preflightReadyList');
        return {
          shown: getComputedStyle(pane).display !== 'none',
          inside: pane.contains(list),
          copies: document.querySelectorAll('#preflightReadiness').length,
        };
      });
      expect(preflight.shown).toBe(true);
      expect(preflight.inside).toBe(true);
      expect(preflight.copies).toBe(1);

      await page.click('#flightDockMessagesTab');
      await page.waitForFunction(() => document.querySelector('[data-mission-region="messages"]').dataset.flightDock === 'messages');
    }

    await page.evaluate(() => {
      applyFlightHud({
        connected: true,
        flying: true,
        armed: true,
        armedKnown: true,
        flightMode: 5,
        airspeed: 12,
        altitude: 40,
        heading: 90,
      });
      updateFlightOverlaysOnAllMaps({
        mavlink: { connected: true, map: { gpsLat: 31.5, gpsLon: 34.85, globalHdgDeg: 90 } },
      });
      updateFlightOverlaysOnAllMaps({
        mavlink: { connected: true, map: { gpsLat: 31.51, gpsLon: 34.86, globalHdgDeg: 80 } },
      });
    });
    const tracked = await page.evaluate(() => ({
      points: terrainFlightLayers.liveTrack ? terrainFlightLayers.liveTrack.getLatLngs().length : 0,
    }));
    expect(tracked.points).toBeGreaterThanOrEqual(2);
    await page.click('#terrainFollowBtn');
    const centered = await page.evaluate(() => {
      const c = terrainMap.getCenter();
      return { lat: c.lat, lng: c.lng, label: document.getElementById('terrainFollowBtn').textContent };
    });
    expect(centered.label).toBe('עוקב');
    expect(Math.abs(centered.lat - 31.51)).toBeLessThan(0.02);
    expect(Math.abs(centered.lng - 34.86)).toBeLessThan(0.02);

    await page.click('#terrainFlightRecordBtn');
    await page.waitForFunction(() => document.getElementById('terrainFlightRecordState').textContent === 'מקליט');
    expect(starts.length).toBe(1);
    const recording = await page.evaluate(() => document.getElementById('missionRecordBtn').textContent);
    expect(recording).toBe('מקליט');
    await page.click('#terrainFlightRecordBtn');
    await page.waitForFunction(() => document.getElementById('terrainFlightRecordState').textContent === 'לא מקליט');

    voice.length = 0;
    let asked = 0;
    page.on('dialog', async (dialog) => {
      asked += 1;
      await dialog.dismiss();
    });
    await page.evaluate(() => {
      applyFlightHud({ connected: false, armed: false, simulator: false });
    });
    await page.click('#flightDockQuickTab');
    await page.click('#flightQuickRtl');
    expect(voice).toEqual([]);
    expect(asked).toBe(0);
    const refused = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(refused).toContain('אין חיבור');

    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: false, armed: false, type: 'tcp', host: '10.1.1.1', port: 5760 });
    });
    await page.click('#flightQuickLoiter');
    expect(asked).toBe(1);
    expect(voice).toEqual([]);

    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: true, type: 'tcp', host: '127.0.0.1', port: 5760 });
    });
    const armed = await page.evaluate(() => document.getElementById('flightQuickArm').textContent);
    expect(armed).toBe('חימוש מחומש');
    const before = asked;
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: true, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockCommandNote').textContent = '';
      document.getElementById('flightQuickRtl').click();
    });
    await page.waitForFunction(() => /נדחה|אושר|נכשל/.test(document.getElementById('flightDockCommandNote').textContent || ''));
    expect(asked).toBe(before);
    expect(voice.length).toBe(1);
    expect(voice[0]).toContain('RTL');
  }, 90000);
});
