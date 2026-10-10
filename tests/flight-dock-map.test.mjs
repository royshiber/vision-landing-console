/**
 * Flight column dock, map follow, and explicit recording. Loopback only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { isVisionFlightCompound, matchVoiceFlightPhrase, pilotModeWord } from '../public/modules/voice-flight-phrases.mjs';
import { arduPlaneModeName } from '../lib/arduplane-flight-modes.mjs';
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
    expect(html).toContain('<option value="TAKEOFF">TAKEOFF</option>');
    expect(html).not.toContain('value="ACRO"');
    expect(js).toContain('mode: name');
    expect(js).toContain('function flightVoiceCommandText(');
    expect(js).toContain('function submitFlightPhrase(');
    expect(html).toContain('id="flightPhraseInput"');
    expect(html).toContain('>שלחו</button>');
    const askSend = js.slice(js.indexOf('async function assistSendText'), js.indexOf('async function assistConfirm'));
    expect(askSend).toContain('askFlightRoute');
    expect(askSend).toContain('postFlightVoice');
    expect(askSend).toContain('operatorConfirmed: true');
    expect(askSend).toContain("action === 'readback'");
    expect(askSend).toContain('flightModeReadbackLine(flightRoute.askedMode, text)');
    const readbackFn = js.slice(js.indexOf('function flightModeReadbackLine'), js.indexOf('function flightVoiceCommandText'));
    expect(readbackFn).toContain('כן.');
    expect(readbackFn).toContain('אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.');
    expect(readbackFn).not.toContain('אין מצב טיסה');
    const phraseFn = js.slice(js.indexOf('async function submitFlightPhrase'), js.indexOf('function applyFlightDock'));
    expect(phraseFn).toContain('flightModeReadbackLine(match.askedMode, text)');
    expect(askSend).toContain('נחסם. הפקודה אינה ברשימה');
    expect(askSend).toContain('נחסם. חימוש וניטרול חסומים');
    expect(askSend.indexOf('postFlightVoice')).toBeLessThan(askSend.indexOf("fetch('/api/assist/message'"));
    expect(js).toContain('function showFlightTalkback(');
    expect(js).toContain('paintFlightDockCommand(line)');
    expect(js.indexOf('paintFlightDockCommand(line)')).toBeLessThan(js.indexOf('void window.__vlcSpeakAnswer'));
    expect(js).toContain('__vlcMatchVoiceFlightPhrase');
    expect(html).toContain('voice-flight-phrases.mjs');
    expect(html).not.toContain('>בצע</button>');
    expect(html).not.toContain('>קבע נקודה</button>');
    expect(html).toContain('פעולה, נקודה ומתלה בלי שליחה');
    expect(js).toContain('operatorConfirmed: true');
    expect(html).toContain('>בית</option>');
    expect(html).toMatch(/id="terrainFollowBtn"[^>]*>עקבו</);
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

describe('flight mode yes/no uses the real readback', () => {
  function loadReadback(hud) {
    const voiceMatch = js.slice(js.indexOf('function flightVoiceMatch'), js.indexOf('function flightModeReadbackLine'));
    const readback = js.slice(js.indexOf('function flightModeReadbackLine'), js.indexOf('function flightVoiceCommandText'));
    const route = js.slice(js.indexOf('function askFlightRoute'), js.indexOf('async function postFlightVoice'));
    const src = `${voiceMatch}\n${readback}\n${route}\nreturn { flightModeReadbackLine, askFlightRoute };`;
    const windowStub = {
      __vlcMatchVoiceFlightPhrase: matchVoiceFlightPhrase,
      __vlcPilotModeWord: pilotModeWord,
      __vlcVisionFlightCompound: isVisionFlightCompound,
    };
    const vlcFlightModeName = (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) ? arduPlaneModeName(n) : null;
    };
    return new Function('latestHudMavlink', 'window', 'vlcFlightModeName', src)(hud, windowStub, vlcFlightModeName);
  }

  it('calls flightModeReadbackLine and askFlightRoute from app.js', () => {
    const cruise = loadReadback({ connected: true, flightMode: 7 });
    const route = cruise.askFlightRoute('האם אנחנו בשיוט');
    expect(route).toEqual({ action: 'readback', askedMode: 'CRUISE' });
    const yes = cruise.flightModeReadbackLine(route.askedMode, 'האם אנחנו בשיוט');
    expect(yes).toBe('כן. שיוט.');
    expect(yes).not.toBe('מצב הטיסה שיוט.');
    const stable = loadReadback({ connected: true, flightMode: 2 });
    const no = stable.flightModeReadbackLine(route.askedMode, 'האם אנחנו בשיוט');
    expect(no).toBe('לא. עכשיו יציב.');
    const down = loadReadback({ connected: false, flightMode: null });
    const missing = down.flightModeReadbackLine(route.askedMode, 'האם אנחנו בשיוט');
    expect(missing).toBe('אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.');
    expect(missing).not.toBe('אין מצב טיסה.');
    const tune = loadReadback({ connected: true, flightMode: 8 });
    const autotune = tune.flightModeReadbackLine(route.askedMode, 'האם אנחנו בשיוט');
    expect(autotune).toBe('לא. עכשיו אוטוטיון.');
    expect(autotune).not.toBe('אין חיבור');
    const named = tune.flightModeReadbackLine(null, 'מה המצב');
    expect(named).toBe('אוטוטיון.');
    expect(named).not.toBe('אין חיבור');
    const quad = loadReadback({ connected: true, flightMode: 18 });
    const qhover = quad.flightModeReadbackLine(null, 'מה המצב');
    expect(qhover).toBe('QHOVER.');
    expect(qhover).not.toBe('אין חיבור');
    expect(cruise.askFlightRoute('מה המצב של הסוללה')).toBeNull();
    expect(cruise.askFlightRoute('לא שיוט')).toBeNull();
    expect(isVisionFlightCompound('נעל על האדם ותחזור הביתה')).toBe(true);
    expect(cruise.askFlightRoute('נעל על האדם ותחזור הביתה')).toBeNull();
    expect(cruise.askFlightRoute('תחזור הביתה')).toEqual({ action: 'send', mode: 'RTL' });
    expect(cruise.askFlightRoute('חימוש')).toEqual({ action: 'block' });
    expect(cruise.askFlightRoute('נטרול')).toEqual({ action: 'block' });
    expect(cruise.askFlightRoute('אל תחזור הביתה')).toEqual({ action: 'refuse' });
    expect(isVisionFlightCompound('תחזור הביתה')).toBe(false);
    expect(isVisionFlightCompound('חימוש')).toBe(false);
    expect(cruise.flightModeReadbackLine.toString()).toContain('אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.');
    expect(cruise.flightModeReadbackLine.toString()).not.toContain('אין מצב טיסה');
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
      expect(hud.hud.height, `${size.width} horizon floor`).toBeGreaterThanOrEqual(160);
      expect(hud.messages.top, `${size.width} dock below horizon`).toBeGreaterThanOrEqual(hud.hud.bottom - 4);
      if (size.height >= 800) {
        expect(hud.hud.height, `${size.width} horizon fill`).toBeGreaterThan(hud.messages.height);
      }
      expect(Math.max(...hud.tileTops) - Math.min(...hud.tileTops), `${size.width} strip`).toBeLessThanOrEqual(4);
      expect(hud.dataOver, `${size.width} strip scroll`).toBeLessThanOrEqual(1);
      expect(hud.horizon.bottom, `${size.width} panel`).toBeLessThanOrEqual(hud.innerH + 1);
      expect(hud.horizon.right, `${size.width} panel`).toBeLessThanOrEqual(hud.innerW + 1);
      expect(contrastRatio(hud.autoColor, hud.autoBg), `${size.width} AUTO`).toBeGreaterThanOrEqual(4.5);
      expect(hud.scrollers.filter((id) => id !== 'pfcMsgScroll'), `${size.width} nested`).toEqual([]);
      expect(hud.paneOver, `${size.width} actions scroll`).toBeLessThanOrEqual(1);

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
        && hudEl.getBoundingClientRect().height >= 112
        && dock.getBoundingClientRect().top >= hudEl.getBoundingClientRect().bottom - 4;
    });
    const beforeResize = await page.evaluate(() => ({
      hud: document.querySelector('.mission-region-horizon > .flight-hud').getBoundingClientRect().height,
      dock: document.querySelector('[data-mission-region="messages"]').getBoundingClientRect().height,
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction((startHud) => {
      const hudEl = document.querySelector('.mission-region-horizon > .flight-hud');
      const dock = document.querySelector('[data-mission-region="messages"]');
      const hudH = hudEl.getBoundingClientRect().height;
      const dockH = dock.getBoundingClientRect().height;
      return hudH > dockH && hudH > startHud + 40;
    }, beforeResize.hud);
    const afterResize = await page.evaluate(() => ({
      hud: document.querySelector('.mission-region-horizon > .flight-hud').getBoundingClientRect().height,
      dock: document.querySelector('[data-mission-region="messages"]').getBoundingClientRect().height,
      bottom: document.querySelector('[data-mission-region="horizon"]').getBoundingClientRect().bottom,
      innerH: window.innerHeight,
    }));
    expect(afterResize.hud).toBeGreaterThan(beforeResize.hud + 40);
    expect(afterResize.hud).toBeGreaterThan(afterResize.dock);
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
        && hudEl.getBoundingClientRect().height > dock.getBoundingClientRect().height;
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
    expect(narrow.tileSpread).toBeLessThanOrEqual(4);
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
    await page.locator('#terrainFollowBtn').evaluate((el) => el.click());
    const centered = await page.evaluate(() => {
      const c = terrainMap.getCenter();
      return { lat: c.lat, lng: c.lng, label: document.getElementById('terrainFollowBtn').textContent };
    });
    expect(centered.label).toBe('עוקב');
    expect(Math.abs(centered.lat - 31.51)).toBeLessThan(0.02);
    expect(Math.abs(centered.lng - 34.86)).toBeLessThan(0.02);

    await page.locator('#terrainFlightRecordBtn').evaluate((el) => el.click());
    await page.waitForFunction(() => document.getElementById('terrainFlightRecordState').textContent === 'מקליט');
    expect(starts.length).toBe(1);
    const recording = await page.evaluate(() => document.getElementById('missionRecordBtn').textContent);
    expect(recording).toBe('מקליט');
    await page.locator('#terrainFlightRecordBtn').evaluate((el) => el.click());
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
    expect(voice[0]).toContain('"mode":"RTL"');

    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: true, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockModeSelect').value = 'FBWA';
      document.getElementById('flightDockCommandNote').textContent = '';
      document.getElementById('flightDockSetMode').click();
    });
    await page.waitForFunction(() => /נדחה|אושר|נכשל|אינו ברשימה|לא נשלח|סירב/.test(document.getElementById('flightDockCommandNote').textContent || ''));
    expect(voice.length).toBe(2);
    expect(voice[1]).toContain('FBWA');
    expect(voice[1]).toContain('"mode":"FBWA"');
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: true, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockModeSelect').value = 'TAKEOFF';
      document.getElementById('flightDockCommandNote').textContent = '';
      document.getElementById('flightDockSetMode').click();
    });
    await page.waitForFunction(() => (document.getElementById('flightDockCommandNote').textContent || '').length > 0);
    expect(voice.at(-1)).toContain('"mode":"TAKEOFF"');

    const phrasePosts = [];
    page.on('request', (req) => {
      if (req.method() !== 'POST') return;
      if (req.url().includes('/api/assist/message') || req.url().includes('/api/mavlink/arm-disarm')) {
        phrasePosts.push(req.url());
      }
    });
    const voiceBeforePhrase = voice.length;
    await page.locator('#pfdVoiceFlightBtn').evaluate((el) => el.click());
    await page.waitForFunction(() => document.activeElement?.id === 'flightPhraseInput');
    const phraseFocus = await page.evaluate(() => ({
      dock: document.querySelector('[data-mission-region="messages"]')?.dataset.flightDock,
      ask: document.getElementById('assistInput') === document.activeElement,
    }));
    expect(phraseFocus.dock).toBe('actions');
    expect(phraseFocus.ask).toBe(false);
    await page.evaluate(() => {
      applyFlightHud({ connected: false, armed: false, simulator: false });
      document.getElementById('flightDockCommandNote').textContent = '';
    });
    await page.fill('#flightPhraseInput', 'עבור למצב יציב');
    await page.click('#flightPhraseSend');
    expect(voice.length).toBe(voiceBeforePhrase);
    expect(phrasePosts).toEqual([]);
    const noLinkPhrase = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(noLinkPhrase).toContain('אין חיבור');
    await page.fill('#flightPhraseInput', 'שלום');
    await page.click('#flightPhraseSend');
    expect(voice.length).toBe(voiceBeforePhrase);
    const unknownPhrase = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(unknownPhrase).toContain('אינה ברשימה');
    await page.fill('#flightPhraseInput', 'חמש');
    await page.click('#flightPhraseSend');
    expect(voice.length).toBe(voiceBeforePhrase);
    expect(phrasePosts).toEqual([]);
    const blockedPhrase = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(blockedPhrase).toContain('חימוש');
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: false, type: 'tcp', host: '127.0.0.1', port: 5760 });
      const input = document.getElementById('flightPhraseInput');
      input.value = 'תמריא';
      document.getElementById('flightDockCommandNote').textContent = '';
      document.getElementById('flightPhraseForm').requestSubmit();
    });
    await page.waitForFunction(() => (document.getElementById('flightDockCommandNote').textContent || '').length > 0);
    expect(voice.length).toBe(voiceBeforePhrase + 1);
    expect(voice.at(-1)).toContain('"mode":"TAKEOFF"');
    expect(phrasePosts).toEqual([]);
    await page.evaluate(() => {
      window.__talkLog = [];
      window.__vlcSpeakAnswer = async (spoken) => {
        window.__talkLog.push({
          text: String(spoken || ''),
          note: document.getElementById('flightDockCommandNote')?.textContent || '',
        });
      };
    });
    const askPosts = [];
    page.on('request', (req) => {
      if (req.method() !== 'POST') return;
      if (req.url().includes('/api/assist/message')) askPosts.push('message');
    });
    const natural = [
      ['שיוט', 'CRUISE'],
      ['מצב ידני', 'MANUAL'],
      ['חזרה הביתה', 'RTL'],
      ['stabilize', 'STABILIZE'],
      ['manual', 'MANUAL'],
      ['rtl', 'RTL'],
    ];
    for (const [phrase, mode] of natural) {
      const before = voice.length;
      await page.evaluate((value) => {
        applyFlightHud({ connected: true, simulator: true, armed: false, type: 'tcp', host: '127.0.0.1', port: 5760 });
        const input = document.getElementById('flightPhraseInput');
        input.value = value;
        document.getElementById('flightDockCommandNote').textContent = '';
        document.getElementById('flightPhraseForm').requestSubmit();
      }, phrase);
      await page.waitForFunction(() => (document.getElementById('flightDockCommandNote').textContent || '').length > 0);
      expect(voice.length, phrase).toBe(before + 1);
      expect(voice.at(-1), phrase).toContain(`"mode":"${mode}"`);
      expect(phrasePosts, phrase).toEqual([]);
      const heard = await page.evaluate(() => window.__talkLog.at(-1));
      expect(heard.note, phrase).toBe(heard.text);
      expect(heard.text.length, phrase).toBeGreaterThan(0);
    }
    const beforeAsk = voice.length;
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: false, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockCommandNote').textContent = '';
      return assistSendText('עבור למצב יציב');
    });
    expect(voice.length).toBe(beforeAsk + 1);
    expect(voice.at(-1)).toContain('"mode":"STABILIZE"');
    expect(voice.at(-1)).toContain('operatorConfirmed');
    expect(askPosts).toEqual([]);
    const askNote = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(askNote).not.toContain('שיחת הקול סגורה');
    const askHeard = await page.evaluate(() => window.__talkLog.at(-1));
    expect(askHeard.note).toBe(askHeard.text);
    const beforeArmAsk = voice.length;
    await page.evaluate(() => assistSendText('חימוש'));
    expect(voice.length).toBe(beforeArmAsk);
    expect(askPosts).toEqual([]);
    const armAsk = await page.evaluate(() => ({
      note: document.getElementById('flightDockCommandNote').textContent,
      heard: window.__talkLog.at(-1),
    }));
    expect(armAsk.note).toBe('נחסם. חימוש וניטרול חסומים');
    expect(armAsk.heard.note).toBe(armAsk.heard.text);
    expect(armAsk.heard.text).toBe('נחסם. חימוש וניטרול חסומים');
    await page.evaluate(() => {
      applyFlightHud({ connected: false, armed: false });
      return assistSendText('המריאו');
    });
    const takeoff = await page.evaluate(() => ({
      note: document.getElementById('flightDockCommandNote').textContent,
      transcript: (document.getElementById('assistMessages') || document.querySelector('.assist-messages'))?.textContent || '',
    }));
    expect(takeoff.note).toBe('המראה לא נשלחה: אין חיבור לבקר הטיסה');
    expect(takeoff.transcript).toContain('המראה לא נשלחה: אין חיבור לבקר הטיסה');
    const askTranscript = await page.evaluate(() => {
      const host = document.getElementById('assistMessages') || document.querySelector('.assist-messages');
      return host ? host.textContent : '';
    });
    expect(askTranscript).not.toContain('תמריא');
    expect(askTranscript).toContain('עבור למצב יציב');
    expect(askTranscript).toContain('נחסם. חימוש וניטרול חסומים');

    for (const phrase of ['set the cruise altitude', 'חמש דקות', 'אל תחזור הביתה']) {
      const beforeVoice = voice.length;
      const beforePosts = askPosts.length;
      await page.evaluate((value) => assistSendText(value), phrase);
      expect(voice.length, phrase).toBe(beforeVoice);
      expect(askPosts.length, phrase).toBe(beforePosts);
      const note = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
      expect(note, phrase).toContain('אינה ברשימה');
      expect(note, phrase).not.toContain('חימוש ונטרול חסומים');
      expect(note, phrase).not.toContain('אושר');
    }
    const beforePhraseRefuse = voice.length;
    await page.evaluate(() => {
      const input = document.getElementById('flightPhraseInput');
      input.value = 'חמש דקות';
      document.getElementById('flightDockCommandNote').textContent = '';
      document.getElementById('flightPhraseForm').requestSubmit();
    });
    expect(voice.length).toBe(beforePhraseRefuse);
    const five = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(five).toContain('אינה ברשימה');
    expect(five).not.toContain('חימוש ונטרול חסומים');

    const direct = await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: false, flightMode: 7, type: 'tcp', host: '127.0.0.1', port: 5760 });
      const route = askFlightRoute('האם אנחנו בשיוט');
      const yes = flightModeReadbackLine(route && route.askedMode, 'האם אנחנו בשיוט');
      applyFlightHud({ connected: true, simulator: true, armed: false, flightMode: 2, type: 'tcp', host: '127.0.0.1', port: 5760 });
      const no = flightModeReadbackLine(route && route.askedMode, 'האם אנחנו בשיוט');
      applyFlightHud({ connected: false, armed: false, simulator: false, flightMode: null });
      const missing = flightModeReadbackLine(route && route.askedMode, 'האם אנחנו בשיוט');
      applyFlightHud({ connected: true, simulator: true, armed: false, flightMode: 8, type: 'tcp', host: '127.0.0.1', port: 5760 });
      const autotune = flightModeReadbackLine(route && route.askedMode, 'האם אנחנו בשיוט');
      applyFlightHud({ connected: true, simulator: true, armed: false, flightMode: 18, type: 'tcp', host: '127.0.0.1', port: 5760 });
      const qhover = flightModeReadbackLine(null, 'מה המצב');
      return { route, yes, no, missing, autotune, qhover, body: flightModeReadbackLine.toString() };
    });
    expect(direct.route).toEqual({ action: 'readback', askedMode: 'CRUISE' });
    expect(direct.yes).toBe('כן. שיוט.');
    expect(direct.yes).not.toBe('מצב הטיסה שיוט.');
    expect(direct.no).toBe('לא. עכשיו יציב.');
    expect(direct.missing).toBe('אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.');
    expect(direct.missing).not.toBe('אין מצב טיסה.');
    expect(direct.autotune).toBe('לא. עכשיו אוטוטיון.');
    expect(direct.autotune).not.toBe('אין חיבור');
    expect(direct.qhover).toBe('QHOVER.');
    expect(direct.qhover).not.toBe('אין חיבור');
    expect(direct.body).toContain('אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.');
    expect(direct.body).not.toContain('אין מצב טיסה');
    const beforeQuestion = voice.length;
    const postsBeforeQuestion = askPosts.length;
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: false, flightMode: 7, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockCommandNote').textContent = '';
      return assistSendText('האם אנחנו בשיוט');
    });
    expect(voice.length).toBe(beforeQuestion);
    expect(askPosts.length).toBe(postsBeforeQuestion);
    const questionNote = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(questionNote).toBe('כן. שיוט.');
    await page.evaluate(() => {
      applyFlightHud({ connected: true, simulator: true, armed: false, flightMode: 2, type: 'tcp', host: '127.0.0.1', port: 5760 });
      document.getElementById('flightDockCommandNote').textContent = '';
      return assistSendText('האם אנחנו בשיוט');
    });
    expect(voice.length).toBe(beforeQuestion);
    expect(askPosts.length).toBe(postsBeforeQuestion);
    const noNote = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(noNote).toBe('לא. עכשיו יציב.');
    await page.evaluate(() => {
      applyFlightHud({ connected: false, armed: false, simulator: false, flightMode: null });
      document.getElementById('flightDockCommandNote').textContent = '';
      return assistSendText('האם אנחנו בשיוט');
    });
    expect(voice.length).toBe(beforeQuestion);
    const missing = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(missing).toBe('אין חיבור לבקר הטיסה. מצב הטיסה לא ידוע.');
    const beforeBattery = voice.length;
    const postsBeforeBattery = askPosts.length;
    await page.evaluate(() => {
      document.getElementById('flightDockCommandNote').textContent = '';
      return assistSendText('מה המצב של הסוללה');
    });
    expect(voice.length).toBe(beforeBattery);
    expect(askPosts.length).toBe(postsBeforeBattery + 1);
    const batteryNote = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(batteryNote).not.toContain('שיוט');
    const beforeStatus = voice.length;
    const postsBeforeStatus = askPosts.length;
    await page.evaluate(() => assistSendText('לא יציב'));
    expect(voice.length).toBe(beforeStatus);
    expect(askPosts.length).toBe(postsBeforeStatus + 1);
    await page.evaluate(() => assistSendText('לא שיוט'));
    expect(voice.length).toBe(beforeStatus);
    expect(askPosts.length).toBe(postsBeforeStatus + 2);
    const statusNote = await page.evaluate(() => document.getElementById('flightDockCommandNote').textContent);
    expect(statusNote).not.toContain('אינה ברשימה');

    const confirm = await page.evaluate(() => {
      const dialog = document.getElementById('flightArmDialog');
      const disarm = document.getElementById('flightDisarmDialog');
      const column = document.querySelector('[data-mission-region="horizon"]');
      dialog.hidden = false;
      disarm.hidden = true;
      const btn = document.getElementById('flightArmConfirm');
      const cancel = document.getElementById('flightArmCancel');
      const card = dialog.querySelector('.flight-arm-popup-card');
      const br = btn.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      const over = (el) => Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight);
      const result = {
        text: btn.textContent.trim(),
        cancel: cancel.textContent.trim(),
        align: getComputedStyle(btn).textAlign,
        height: br.height,
        position: getComputedStyle(dialog).position,
        inColumn: column.contains(dialog),
        centerX: Math.abs((box.left + box.right) / 2 - window.innerWidth / 2),
        centerY: Math.abs((box.top + box.bottom) / 2 - window.innerHeight / 2),
        labelOver: over(btn),
        cancelOver: over(cancel),
      };
      dialog.hidden = true;
      return result;
    });
    expect(confirm.text).toBe('אשרו חימוש');
    expect(confirm.cancel).toBe('ביטול');
    expect(confirm.align).toBe('center');
    expect(confirm.height).toBeGreaterThanOrEqual(52);
    expect(confirm.position).toBe('fixed');
    expect(confirm.inColumn).toBe(false);
    expect(confirm.centerX).toBeLessThanOrEqual(8);
    expect(confirm.centerY).toBeLessThanOrEqual(8);
    expect(confirm.labelOver).toBeLessThanOrEqual(1);
    expect(confirm.cancelOver).toBeLessThanOrEqual(1);
  }, 90000);
});
