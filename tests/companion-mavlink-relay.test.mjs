import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import {
  DEFAULT_RELAY_PORT,
  companionMavlinkRelayTarget,
  buildJetsonRelayTargets,
} from '../lib/jetson-companion-proxy.mjs';
import {
  COMPANION_RELAY_HE,
  applyMavlinkRelayHint,
  closeCompanionMavlinkRelay,
  isCompanionRelayStatus,
  openCompanionMavlinkRelay,
} from '../lib/companion-mavlink-relay.mjs';
import { summarizeCompanionLink, hebrewFcState } from '../lib/companion-link.mjs';
import { DEFAULT_COMPANION_BASE_URL } from '../lib/companion-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

describe('server start re-opens a surviving Companion relay', () => {
  it('calls ensureCompanionMavlinkRelay after companionService.start', () => {
    const serverSrc = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
    expect(serverSrc).toContain('ensureCompanionMavlinkRelay');
    expect(serverSrc).toMatch(/companionService\.start\(\)[\s\S]*ensureCompanionMavlinkRelay\(routeCtx\)/);
  });
});

describe('companion MAVLink TCP relay target', () => {
  it('derives host:5770 from Companion HTTP base URL', () => {
    expect(DEFAULT_RELAY_PORT).toBe(5770);
    expect(companionMavlinkRelayTarget('http://100.82.59.45:8081')).toEqual({
      type: 'tcp',
      host: '100.82.59.45',
      port: 5770,
      label: 'Jetson MAVLink relay (100.82.59.45:5770)',
    });
    expect(companionMavlinkRelayTarget(DEFAULT_COMPANION_BASE_URL).host).toBe('100.82.59.45');
    expect(companionMavlinkRelayTarget('http://jetson.example:8081/api/v1/')).toMatchObject({
      host: 'jetson.example',
      port: 5770,
    });
    expect(companionMavlinkRelayTarget('http://jetson.example:8081', 5771).port).toBe(5771);
    expect(companionMavlinkRelayTarget('')).toBeNull();
    expect(companionMavlinkRelayTarget('not-a-url')).toBeNull();
  });

  it('adds Companion URL host to smart-connect Jetson relay targets', () => {
    const fromUrl = buildJetsonRelayTargets({}, {}, 'http://100.82.59.45:8081');
    expect(fromUrl.some((t) => t.host === '100.82.59.45' && t.port === 5770)).toBe(true);
    const fromEnv = buildJetsonRelayTargets({}, { JETSON_COMPANION_BASE_URL: 'http://jetson.ts:8081' });
    expect(fromEnv.some((t) => t.host === 'jetson.ts' && t.port === 5770)).toBe(true);
  });
});

describe('open / close companion MAVLink relay', () => {
  function memDb() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-relay-'));
    const db = openDatabase(path.join(root, 'app.sqlite'));
    return { db, root, close() { try { db.close(); } catch { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); } };
  }

  it('activates TCP to the Companion host relay port and disconnect cleans up', async () => {
    const bag = memDb();
    const activated = [];
    const deactivated = [];
    const live = [];
    const opened = await openCompanionMavlinkRelay({
      db: bag.db,
      baseUrl: 'http://100.82.59.45:8081',
      activate: async (cfg) => {
        activated.push(cfg);
        live.push({
          id: cfg.id,
          type: 'tcp',
          host: cfg.host,
          port: cfg.port,
          linkRole: 'radio',
          connected: true,
          heartbeatCount: 2,
        });
        return { id: cfg.id, connected: true };
      },
      deactivate: (id) => { deactivated.push(id); return true; },
      listStatuses: () => live.filter((s) => !deactivated.includes(s.id)),
      statusOf: (id) => live.find((s) => s.id === id) || { id, connected: true, heartbeatCount: 2 },
    });
    expect(opened.ok).toBe(true);
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({ type: 'tcp', host: '100.82.59.45', port: 5770 });
    expect(opened.heartbeat).toBe(true);
    const rows = bag.db.prepare(`SELECT * FROM connections`).all();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].active)).toBe(1);

    const closed = closeCompanionMavlinkRelay({
      db: bag.db,
      baseUrl: 'http://100.82.59.45:8081',
      lastRelay: opened,
      deactivate: (id) => { deactivated.push(id); return true; },
      listStatuses: () => live.filter((s) => !deactivated.includes(s.id)),
    });
    expect(closed.closed.length).toBeGreaterThan(0);
    expect(deactivated).toContain(opened.id);
    expect(Number(bag.db.prepare(`SELECT active FROM connections WHERE id = ?`).get(opened.id).active)).toBe(0);
    bag.close();
  });

  it('does not steal an already-live USB/SITL radio link', async () => {
    const activated = [];
    const opened = await openCompanionMavlinkRelay({
      baseUrl: 'http://100.82.59.45:8081',
      activate: async (cfg) => { activated.push(cfg); },
      listStatuses: () => [{
        id: 9,
        type: 'serial',
        linkRole: 'radio',
        connected: true,
        serialPort: '/dev/ttyUSB0',
      }],
    });
    expect(opened.ok).toBe(false);
    expect(opened.skipped).toBe('live_radio');
    expect(activated).toHaveLength(0);
  });

  it('skips mock Companion mode', async () => {
    const activated = [];
    const opened = await openCompanionMavlinkRelay({
      baseUrl: 'http://100.82.59.45:8081',
      mock: true,
      activate: async (cfg) => { activated.push(cfg); },
    });
    expect(opened.skipped).toBe('mock');
    expect(activated).toHaveLength(0);
  });

  it('treats matching live TCP as already open', async () => {
    const activated = [];
    const opened = await openCompanionMavlinkRelay({
      baseUrl: 'http://jetson.example:8081',
      activate: async (cfg) => { activated.push(cfg); },
      listStatuses: () => [{
        id: 3,
        type: 'tcp',
        host: 'jetson.example',
        port: 5770,
        linkRole: 'radio',
        connected: true,
        heartbeatCount: 4,
      }],
    });
    expect(opened.ok).toBe(true);
    expect(opened.skipped).toBe('already_open');
    expect(opened.id).toBe(3);
    expect(activated).toHaveLength(0);
    expect(isCompanionRelayStatus(
      { type: 'tcp', host: 'jetson.example', port: 5770 },
      { host: 'jetson.example', port: 5770 },
    )).toBe(true);
  });
});

describe('honesty: UART heartbeat is not a fake GCS stream', () => {
  it('keeps דופק חי and overlay Hebrew when the relay is down', () => {
    const live = summarizeCompanionLink({
      mode: 'real',
      reachable: true,
      health: { fc_linked: true, fc_heartbeat: true },
    });
    expect(live.fc).toBe('heartbeat');
    expect(live.fcStatusHe).toBe('דופק חי');
    expect(live.fcStatusHe).not.toBe('מחובר');
    const noted = applyMavlinkRelayHint(live, {
      ok: false,
      error: 'activate_failed',
      status_he: COMPANION_RELAY_HE.failed,
    });
    expect(noted.fc).toBe('heartbeat');
    expect(noted.fcStatusHe).toBe('דופק חי');
    expect(noted.hint_he).toBe(COMPANION_RELAY_HE.failedWhileHeartbeat);
    expect(noted.mavlinkRelay.ok).toBe(false);
    expect(hebrewFcState('heartbeat')).toBe('דופק חי');
  });

  it('does not turn Status FC into fake green מחובר when MAVLink HUD is empty', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    const src = [
      sliceFunction(js, 'companionFiniteMetric'),
      sliceFunction(js, 'pulseFcObject'),
      sliceFunction(js, 'pulseCompanionFcLink'),
      sliceFunction(js, 'pulseResolveFcHonesty'),
      'return { pulseResolveFcHonesty };',
    ].join('\n');
    const ui = new Function(src)();
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
      fc_linked: true,
      mavlinkRelay: { ok: false, status_he: COMPANION_RELAY_HE.failedWhileHeartbeat },
    }, { connected: false, fcLoadPct: null, fcMemPct: null, fcTempC: null });
    expect(honesty.labelHe).toBe('דופק חי');
    expect(honesty.card).toBe('heartbeat');
    expect(honesty.card).not.toBe('connected');
    expect(honesty.load).toBeNull();
    expect(honesty.mem).toBeNull();
    expect(honesty.temp).toBeNull();
    expect(honesty.showGcsMissingNote).toBe(true);
  });

  it('Mission HUD empty copy uses ממסר hint when Companion has fc_heartbeat', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    const src = [
      `const MISSION_FC_EMPTY_PRIMARY_HE = 'אין חיבור לבקר — לא מתקבלות הודעות MAVLink.';`,
      `const MISSION_FC_EMPTY_NOTE_HE = 'אין חיבור לבקר. אין הודעות נכנסות.';`,
      `const MISSION_FC_RELAY_HINT_HE = '${COMPANION_RELAY_HE.failedWhileHeartbeat}';`,
      sliceFunction(js, 'companionReportsFcHeartbeat'),
      sliceFunction(js, 'missionFcEmptyPrimaryHe'),
      sliceFunction(js, 'missionFcEmptyNoteHe'),
      'return { companionReportsFcHeartbeat, missionFcEmptyPrimaryHe, missionFcEmptyNoteHe };',
    ].join('\n');
    const ui = new Function(src)();
    expect(ui.companionReportsFcHeartbeat({ fc_heartbeat: true })).toBe(true);
    expect(ui.companionReportsFcHeartbeat({ link: { fc: 'heartbeat' } })).toBe(true);
    expect(ui.companionReportsFcHeartbeat({ fc_heartbeat: false })).toBe(false);
    expect(ui.missionFcEmptyPrimaryHe({ fc_heartbeat: true })).toBe(COMPANION_RELAY_HE.failedWhileHeartbeat);
    expect(ui.missionFcEmptyNoteHe({ fc: 'heartbeat' })).toBe(COMPANION_RELAY_HE.failedWhileHeartbeat);
    expect(ui.missionFcEmptyPrimaryHe({ hint_he: COMPANION_RELAY_HE.failedWhileHeartbeat, fc_heartbeat: true }))
      .toBe(COMPANION_RELAY_HE.failedWhileHeartbeat);
    expect(ui.missionFcEmptyPrimaryHe(null)).toBe('אין חיבור לבקר — לא מתקבלות הודעות MAVLink.');
    expect(ui.missionFcEmptyNoteHe(null)).toBe('אין חיבור לבקר. אין הודעות נכנסות.');
    expect(ui.missionFcEmptyPrimaryHe({ fc_heartbeat: true })).toMatch(/ממסר/);
    expect(js).toMatch(/pfcMsgPrimaryHe\.textContent = missionFcEmptyPrimaryHe\(companion\)/);
    expect(js).toMatch(/note\.textContent = missionFcEmptyNoteHe\(companion\)/);
  });

  it('treats live SSE attitude as HUD-live so the filler note is not אין חיבור לבקר', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    const src = [
      sliceFunction(js, 'isHudMavlinkLive'),
      'return { isHudMavlinkLive };',
    ].join('\n');
    const ui = new Function(src)();
    expect(ui.isHudMavlinkLive({ connected: true })).toBe(true);
    expect(ui.isHudMavlinkLive({ listening: true })).toBe(true);
    expect(ui.isHudMavlinkLive({ heartbeatCount: 3 })).toBe(true);
    expect(ui.isHudMavlinkLive({ connected: false, rollDeg: 4.2, pitchDeg: -1.1 })).toBe(true);
    expect(ui.isHudMavlinkLive({ connected: false, rollDeg: null, pitchDeg: null })).toBe(false);
    expect(ui.isHudMavlinkLive(null)).toBe(false);
    const hud = sliceFunction(js, 'applyFlightHud');
    expect(hud).toMatch(/syncMissionFcEmptyNote\(mav\)/);
  });
});
