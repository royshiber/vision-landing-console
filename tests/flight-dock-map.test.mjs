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
    expect(html).not.toMatch(/id="flightDockQuickTab"/);
    expect(html).not.toMatch(/id="flightDockPreflightTab"/);
    expect(html).not.toMatch(/id="flightDockGaugesTab"/);
    expect(html).toMatch(/id="flightDockMessagesTab"[^>]*>הודעות</);
    expect(html).toMatch(/id="flightDockActionsTab"[^>]*>פעולות</);
    expect(html.match(/class="flight-dock-tab"/g)).toHaveLength(2);
    expect(html.match(/id="preflightReadiness"/g)).toHaveLength(1);
    expect(html.indexOf('id="preflightReadiness"')).toBeLessThan(html.indexOf('id="teleDashPanel"'));
    expect(html.indexOf('id="preflightReadiness"')).toBeLessThan(html.indexOf('data-mission-region="messages"'));
    expect(js).toContain("const FLIGHT_DOCKS = Object.freeze(['messages', 'actions'])");
    expect(html).toMatch(/id="flightDockDoAction"[^>]*disabled/);
    expect(html).toMatch(/id="flightDockSetWp"[^>]*disabled/);
    expect(html).toMatch(/id="flightDockSetMount"[^>]*disabled/);
    expect(html).toContain('>בצעו</button>');
    expect(html).toContain('>קבעו נקודה</button>');
    expect(html).toContain('>קבעו מתלה</button>');
    expect(html).toContain('>קבעו מצב</button>');
    expect(html).not.toContain('>בצע</button>');
    expect(html).not.toContain('>קבע נקודה</button>');
    expect(html).toContain('פעולה, נקודה ומתלה בלי שליחה');
    expect(js).toContain('operatorConfirmed: true');
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
        actions: getComputedStyle(document.getElementById('flightDockActionsPane')).display,
        tabs: document.querySelectorAll('.flight-dock-tab').length,
        checklist: document.querySelector('[data-mission-region="messages"]').contains(document.getElementById('preflightReadiness')),
        state: document.getElementById('terrainFlightRecordState')?.textContent,
        gs: [...document.querySelectorAll('.hud-slot-label')].map((el) => el.textContent).join(' '),
      }));
      expect(idle.filler).toBe(false);
      expect(idle.dock).toBe('messages');
      expect(idle.note).not.toBe('none');
      expect(idle.list).toBe('flex');
      expect(idle.actions).toBe('none');
      expect(idle.tabs).toBe(2);
      expect(idle.checklist).toBe(false);
      expect(idle.state).toBe('לא מקליט');
      expect(idle.gs).not.toMatch(/GS|Vision/);
      const fit = await page.evaluate(() => ['terrainFollowBtn', 'terrainFlightRecordBtn', 'terrainFlightRecordState', 'flightDockActionsTab', 'flightDockMessagesTab', 'flightActionsNote'].map((id) => {
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
      expect(actions.disabled).toBe(true);
      expect(actions.setMode).toBe(false);
      expect(actions.reason).toContain('בלי שליחה');
      expect(actions.over).toBeLessThanOrEqual(1);
      const tabRatio = contrastRatio(actions.tabColor, actions.tabBg);
      expect(tabRatio).toBeGreaterThanOrEqual(4.5);
      const hud = await page.evaluate(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const pane = document.getElementById('flightDockActionsPane');
        const cmds = [...document.querySelectorAll('#flightDockActionsPane .flight-dock-cmds .flight-dock-cmd')].map(box);
        const rows = [...document.querySelectorAll('#flightDockActionsPane .flight-dock-row')].map((row) => {
          const kids = [...row.children].map(box);
          const texts = [...row.querySelectorAll('.flight-dock-key, select, button')].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              over: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight),
              top: r.top,
              bottom: r.bottom,
            };
          });
          return { kids, texts };
        });
        const reason = document.getElementById('flightDockDisabledReason');
        const reasonBox = box(reason);
        const grid = box(document.querySelector('#flightDockActionsPane .flight-dock-grid'));
        const horizon = box(document.querySelector('[data-mission-region="horizon"]'));
        const hudBox = box(document.querySelector('.mission-region-horizon > .flight-hud'));
        const messages = box(document.querySelector('[data-mission-region="messages"]'));
        const dataGrid = document.getElementById('missionDataGrid');
        const tiles = [...document.querySelectorAll('.mission-data-tile')].map((el) => el.getBoundingClientRect().top);
        const auto = document.getElementById('flightDockModeAuto');
        const autoCs = getComputedStyle(auto);
        const scrollers = [];
        document.querySelector('[data-mission-region="horizon"]').querySelectorAll('*').forEach((el) => {
          const oy = getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') return;
          if (el.scrollHeight > el.clientHeight + 2) scrollers.push(el.id || el.className);
        });
        return {
          cmds,
          rows,
          reasonTop: reasonBox.top,
          gridBottom: grid.bottom,
          reasonBottom: reasonBox.bottom,
          paneBottom: box(pane).bottom,
          paneOver: pane.scrollHeight - pane.clientHeight,
          horizon,
          hud: hudBox,
          messages,
          tileTops: tiles,
          dataOver: Math.max(0, dataGrid.scrollWidth - dataGrid.clientWidth),
          autoColor: autoCs.color,
          autoBg: autoCs.backgroundColor,
          scrollers,
          innerH: window.innerHeight,
          innerW: window.innerWidth,
        };
      });
      expect(hud.cmds, `${size.width} modes`).toHaveLength(3);
      const cmdTops = hud.cmds.map((c) => c.top);
      expect(Math.max(...cmdTops) - Math.min(...cmdTops), `${size.width} mode row`).toBeLessThanOrEqual(2);
      for (const cmd of hud.cmds) expect(cmd.width, `${size.width} mode key`).toBeGreaterThan(hud.horizon.width / 4 - 8);
      expect(hud.rows, `${size.width} rows`).toHaveLength(4);
      for (const row of hud.rows) {
        const tops = row.kids.map((k) => k.top);
        expect(Math.max(...tops) - Math.min(...tops), `${size.width} control row`).toBeLessThanOrEqual(4);
        for (const text of row.texts) expect(text.over, `${size.width} control text`).toBeLessThanOrEqual(1);
      }
      expect(hud.reasonTop - hud.gridBottom, `${size.width} reason gap`).toBeLessThanOrEqual(12);
      expect(hud.reasonTop, `${size.width} reason`).toBeGreaterThanOrEqual(hud.gridBottom - 1);
      expect(hud.paneBottom - hud.reasonBottom, `${size.width} reason tail`).toBeLessThanOrEqual(14);
      expect(hud.hud.height, `${size.width} horizon cap`).toBeLessThanOrEqual(164);
      expect(hud.hud.height, `${size.width} horizon floor`).toBeGreaterThanOrEqual(112);
      expect(hud.messages.height, `${size.width} dock`).toBeGreaterThan(hud.hud.height);
      if (size.width >= 1366) {
        expect(hud.messages.height, `${size.width} dock taller`).toBeGreaterThan(hud.hud.height + 40);
      }
      expect(Math.max(...hud.tileTops) - Math.min(...hud.tileTops), `${size.width} strip`).toBeLessThanOrEqual(2);
      expect(hud.dataOver, `${size.width} strip scroll`).toBeLessThanOrEqual(1);
      expect(hud.horizon.bottom, `${size.width} panel`).toBeLessThanOrEqual(hud.innerH + 1);
      expect(hud.horizon.right, `${size.width} panel`).toBeLessThanOrEqual(hud.innerW + 1);
      expect(contrastRatio(hud.autoColor, hud.autoBg), `${size.width} AUTO`).toBeGreaterThanOrEqual(4.5);
      expect(hud.scrollers.filter((id) => id !== 'flightDockActionsPane' && id !== 'pfcMsgScroll'), `${size.width} nested`).toEqual([]);

      const modes = await page.evaluate(() => ({
        auto: document.getElementById('flightDockModeAuto').disabled,
        loiter: document.getElementById('flightDockModeLoiter').disabled,
        rtl: document.getElementById('flightDockModeRtl').disabled,
        home: document.getElementById('flightDockWpSelect').options[0].textContent,
      }));
      expect(modes.auto).toBe(false);
      expect(modes.loiter).toBe(false);
      expect(modes.rtl).toBe(false);
      expect(modes.home).toBe('בית');

      await page.click('#flightDockMessagesTab');
      await page.waitForFunction(() => document.querySelector('[data-mission-region="messages"]').dataset.flightDock === 'messages');
    }

    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.removeItem('visionLandingFlightStackV1');
      localStorage.removeItem('visionLandingMissionMessagesV1');
      localStorage.removeItem('visionLandingFlightDockV1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#flightDockActionsTab');
    await page.waitForFunction(() => {
      const hudEl = document.querySelector('.mission-region-horizon > .flight-hud');
      const dock = document.querySelector('[data-mission-region="messages"]');
      return dock?.dataset.flightDock === 'actions'
        && hudEl.getBoundingClientRect().height <= 164
        && dock.getBoundingClientRect().height > hudEl.getBoundingClientRect().height;
    });
    const beforeResize = await page.evaluate(() => ({
      hud: document.querySelector('.mission-region-horizon > .flight-hud').getBoundingClientRect().height,
      dock: document.querySelector('[data-mission-region="messages"]').getBoundingClientRect().height,
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction((startDock) => {
      const hudEl = document.querySelector('.mission-region-horizon > .flight-hud');
      const dock = document.querySelector('[data-mission-region="messages"]');
      const hudH = hudEl.getBoundingClientRect().height;
      const dockH = dock.getBoundingClientRect().height;
      return hudH <= 164 && dockH > hudH && dockH > startDock + 40;
    }, beforeResize.dock);
    const afterResize = await page.evaluate(() => ({
      hud: document.querySelector('.mission-region-horizon > .flight-hud').getBoundingClientRect().height,
      dock: document.querySelector('[data-mission-region="messages"]').getBoundingClientRect().height,
      bottom: document.querySelector('[data-mission-region="horizon"]').getBoundingClientRect().bottom,
      innerH: window.innerHeight,
    }));
    expect(afterResize.hud).toBeLessThanOrEqual(164);
    expect(Math.abs(afterResize.hud - beforeResize.hud)).toBeLessThanOrEqual(4);
    expect(afterResize.dock).toBeGreaterThan(afterResize.hud);
    expect(afterResize.dock).toBeGreaterThan(beforeResize.dock + 40);
    expect(afterResize.bottom).toBeLessThanOrEqual(afterResize.innerH + 1);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const ws = document.querySelector('.mission-workspace');
      ws.style.setProperty('--mission-ah-col', '390px');
      ws.style.setProperty('--mission-map-col', '1fr');
    });
    await page.evaluate(() => {
      resetFlightStack();
    });
    await page.click('#flightDockActionsTab');
    await page.waitForFunction(() => {
      const horizon = document.querySelector('[data-mission-region="horizon"]');
      const dock = document.querySelector('[data-mission-region="messages"]');
      const hudEl = document.querySelector('.mission-region-horizon > .flight-hud');
      return dock?.dataset.flightDock === 'actions'
        && Math.abs(horizon.getBoundingClientRect().width - 390) <= 8
        && dock.getBoundingClientRect().height > hudEl.getBoundingClientRect().height;
    });
    const narrow = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const horizon = box(document.querySelector('[data-mission-region="horizon"]'));
      const cmds = [...document.querySelectorAll('#flightDockActionsPane .flight-dock-cmds .flight-dock-cmd')].map(box);
      const rows = [...document.querySelectorAll('#flightDockActionsPane .flight-dock-row')].map((row) => {
        const tops = [...row.children].map((el) => el.getBoundingClientRect().top);
        const over = [...row.querySelectorAll('.flight-dock-key, select, button')].map((el) => Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight));
        return { spread: Math.max(...tops) - Math.min(...tops), over: Math.max(...over) };
      });
      const tiles = [...document.querySelectorAll('.mission-data-tile')].map((el) => el.getBoundingClientRect().top);
      const pane = document.getElementById('flightDockActionsPane');
      return {
        width: horizon.width,
        bottom: horizon.bottom,
        innerH: window.innerHeight,
        cmdSpread: Math.max(...cmds.map((c) => c.top)) - Math.min(...cmds.map((c) => c.top)),
        rows,
        tileSpread: Math.max(...tiles) - Math.min(...tiles),
        paneOver: pane.scrollHeight - pane.clientHeight,
      };
    });
    expect(Math.abs(narrow.width - 390)).toBeLessThanOrEqual(8);
    expect(narrow.bottom).toBeLessThanOrEqual(narrow.innerH + 1);
    expect(narrow.cmdSpread).toBeLessThanOrEqual(2);
    expect(narrow.rows).toHaveLength(4);
    for (const row of narrow.rows) {
      expect(row.spread).toBeLessThanOrEqual(4);
      expect(row.over).toBeLessThanOrEqual(1);
    }
    expect(narrow.tileSpread).toBeLessThanOrEqual(2);
    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    await page.locator('[data-mission-region="horizon"]').screenshot({
      path: '/opt/cursor/artifacts/flight-column-actions.png',
    });
    await page.evaluate(() => {
      const ws = document.querySelector('.mission-workspace');
      ws.style.removeProperty('--mission-ah-col');
      ws.style.removeProperty('--mission-map-col');
    });
    await page.setViewportSize({ width: 1440, height: 900 });

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
    await page.click('#flightDockActionsTab');
    await page.click('#flightDockModeRtl');
    expect(voice).toEqual([]);
    expect(asked).toBe(0);
    const refused = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(refused).toContain('אין חיבור');

    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: false, armed: false, type: 'tcp', host: '10.1.1.1', port: 5760 });
      document.getElementById('flightDockModeLoiter').click();
    });
    expect(asked).toBe(1);
    expect(voice).toEqual([]);

    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: true, type: 'tcp', host: '127.0.0.1', port: 5760 });
    });
    const before = asked;
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: true, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockCommandNote').textContent = '';
      document.getElementById('flightDockModeRtl').click();
    });
    await page.waitForFunction(() => /נדחה|אושר|נכשל/.test(document.getElementById('flightDockCommandNote').textContent || ''));
    expect(asked).toBe(before);
    expect(voice.length).toBe(1);
    expect(voice[0]).toContain('RTL');
    expect(voice[0]).toContain('operatorConfirmed');
  }, 90000);
});
