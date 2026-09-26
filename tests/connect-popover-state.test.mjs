import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, getConfig } from '../lib/db.mjs';
import {
  barsFromRsrpDbm,
  snapshotRcLink,
  barsFromRssiDbm,
  deriveHomeDisplay,
  deriveMavlinkDisplay,
  displayFromUplink,
  qualityFromCompanionSignal,
  qualityFromHeartbeatAge,
  qualityFromHttpRtt,
  qualityFromTrustedPercent,
  readLinkPrefs,
  rowActionStyle,
  summarizeCommLinks,
  uplinkRefusalHe,
  UPLINK_CONSOLE_ONLY_HE,
  UPLINK_LAST_LINK_HE,
  UPLINK_UNSUPPORTED_HE,
  writeLinkPrefs,
} from '../lib/comm-links.mjs';
import { applyLinkPrefs, disconnectLink, setCompanionUplink } from '../lib/dual-link-runtime.mjs';
import { registerDualLinkApi } from '../lib/routes/dual-link-api.mjs';
import {
  disconnectCompanionSession,
  ensureCompanionMavlinkRelay,
  registerCompanionConnectionApi,
} from '../lib/routes/companion-connection-api.mjs';
import { createCompanionService } from '../lib/companion-service.mjs';
import {
  COMPANION_CONNECTION_KEY,
  writeStoredCompanionConnection,
} from '../lib/companion-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('connect popover state, bars, and actions', () => {
  it('does not treat a listener or a stale heartbeat as connected', () => {
    const listening = deriveMavlinkDisplay({
      listening: true,
      connected: false,
      framesRx: 0,
      heartbeatCount: 0,
      bytesRx: 0,
    });
    expect(listening.connected).toBe(false);
    expect(listening.state).toBe('listening');
    expect(listening.tone).toBe('wait');
    expect(listening.statusHe).toBe('ממתין');

    const stale = deriveMavlinkDisplay({
      connected: true,
      listening: false,
      heartbeatCount: 4,
      framesRx: 20,
      lastHeartbeatAgeMs: 8000,
    });
    expect(stale.connected).toBe(false);
    expect(stale.state).toBe('degraded');
    expect(stale.tone).toBe('wait');
    expect(stale.statusHe).toBe('דופק ישן');

    const live = deriveMavlinkDisplay({
      connected: true,
      heartbeatCount: 3,
      framesRx: 10,
      lastHeartbeatAgeMs: 400,
    });
    expect(live.connected).toBe(true);
    expect(live.tone).toBe('ok');

    const boundary = deriveMavlinkDisplay({
      connected: true,
      heartbeatCount: 2,
      lastHeartbeatAgeMs: 3000,
    });
    expect(boundary.connected).toBe(true);

    const justStale = deriveMavlinkDisplay({
      connected: true,
      heartbeatCount: 2,
      lastHeartbeatAgeMs: 3001,
    });
    expect(justStale.connected).toBe(false);
    expect(justStale.statusHe).toBe('דופק ישן');

    const framesOnly = deriveMavlinkDisplay({
      connected: true,
      heartbeatCount: 0,
      framesRx: 40,
      lastHeartbeatAgeMs: 200,
    });
    expect(framesOnly.connected).toBe(false);
    expect(framesOnly.state).toBe('listening');

    const linkDown = deriveMavlinkDisplay({
      connected: false,
      listening: false,
      heartbeatCount: 8,
      framesRx: 40,
      lastHeartbeatAgeMs: 200,
    });
    expect(linkDown.connected).toBe(false);
    expect(linkDown.state).toBe('off');
    expect(linkDown.statusHe).toBe('מנותק');
  });

  it('marks home reachable without FC data as degraded', () => {
    const degraded = deriveHomeDisplay({ jetson: 'reachable', fc: 'linked', fc_heartbeat: false });
    expect(degraded.connected).toBe(false);
    expect(degraded.tone).toBe('wait');
    expect(degraded.statusHe).toBe('אין נתוני בקר');
    expect(degraded.sessionOpen).toBe(true);

    const fresh = deriveHomeDisplay({
      jetson: 'reachable',
      fc: 'heartbeat',
      fc_heartbeat: true,
      healthAgeMs: 500,
    });
    expect(fresh.connected).toBe(true);
    expect(fresh.tone).toBe('ok');

    const old = deriveHomeDisplay({
      jetson: 'reachable',
      fc: 'heartbeat',
      fc_heartbeat: true,
      healthAgeMs: 9000,
    });
    expect(old.connected).toBe(false);
    expect(old.state).toBe('degraded');

    const relayDown = deriveHomeDisplay({
      jetson: 'reachable',
      fc: 'heartbeat',
      fc_heartbeat: true,
      healthAgeMs: 200,
      mavlinkRelay: { ok: false, connected: false, heartbeat: false, error: 'socket_closed' },
    });
    expect(relayDown.connected).toBe(false);
    expect(relayDown.statusHe).toBe('אין נתוני בקר');

    const relayStale = deriveHomeDisplay({
      jetson: 'reachable',
      fc: 'heartbeat',
      fc_heartbeat: true,
      mavlinkRelay: { ok: false, connected: true, heartbeat: false, error: 'heartbeat_stale' },
    });
    expect(relayStale.connected).toBe(false);
    expect(relayStale.statusHe).toBe('דופק ישן');
  });

  it('keeps the button label as the action and danger only on disconnect', () => {
    const snap = summarizeCommLinks({
      radio: 'listening',
      cellular: 'disconnected',
      modemPresent: false,
      companion: { jetson: 'off' },
    });
    const radio = snap.rows.find((r) => r.id === 'radio');
    const home = snap.rows.find((r) => r.id === 'home');
    const cell = snap.rows.find((r) => r.id === 'cellular');
    expect(radio.connected).toBe(false);
    expect(radio.actionHe).toBe('התנתק');
    expect(radio.actionStyle).toBe('danger');
    expect(rowActionStyle(radio.actionHe)).toBe('danger');
    expect(home.actionHe).toBe('התחבר');
    expect(home.actionStyle).toBe('neutral');
    expect(cell.actionHe).toBe('התחבר');
    expect(cell.actionStyle).toBe('neutral');
    expect(rowActionStyle('התחבר')).toBe('neutral');
    expect(rowActionStyle('סטטוס')).toBe('neutral');
  });

  it('maps RSRP, RSSI, and heartbeat age, and leaves unknown empty', () => {
    expect(barsFromRsrpDbm(-80)).toBe(4);
    expect(barsFromRsrpDbm(-90)).toBe(3);
    expect(barsFromRsrpDbm(-100)).toBe(2);
    expect(barsFromRsrpDbm(-110)).toBe(1);
    expect(barsFromRsrpDbm(-111)).toBe(0);
    expect(barsFromRssiDbm(-70)).toBe(3);
    const rsrp = qualityFromCompanionSignal({ rsrp: -95, rsrq: -12 });
    expect(rsrp.known).toBe(true);
    expect(rsrp.percent).toBeNull();
    expect(rsrp.bars).toBe(2);
    expect(rsrp.tooltipHe).toMatch(/-95/);
    expect(rsrp.tooltipHe).toMatch(/אין נתונים|דציבל|איכות/);
    const age = qualityFromHeartbeatAge(800, { sourceHe: 'לפי זמן דופק' });
    expect(age.known).toBe(true);
    expect(age.bars).toBe(4);
    expect(age.percent).toBeNull();
    expect(age.sourceHe).toBe('לפי זמן דופק');
    expect(qualityFromHeartbeatAge(null).known).toBe(false);
    expect(qualityFromHeartbeatAge(3001).bars).toBe(0);
    const decodedRc = snapshotRcLink([{
      hasRcChannels: true,
      rcRssi: 200,
      rcAgeMs: 100,
      rcChannels: null,
    }]);
    expect(decodedRc.state).toBe('off');
    expect(decodedRc.quality.known).toBe(false);
    expect(qualityFromHttpRtt(null).known).toBe(false);
    expect(qualityFromTrustedPercent(null).percent).toBeNull();
    const unknown = qualityFromCompanionSignal({ present: true });
    expect(unknown.known).toBe(false);
    expect(unknown.bars).toBe(0);
    const relay = summarizeCommLinks({
      radioLive: {
        connected: true,
        type: 'tcp',
        heartbeatCount: 5,
        framesRx: 12,
        lastHeartbeatAgeMs: 600,
        heartbeatRateHz: 1,
      },
      radioViaRelay: true,
      modemPresent: true,
      cellularSignal: { rsrp: -88 },
      companion: { jetson: 'reachable', fc_heartbeat: true, fc: 'heartbeat', httpRttMs: 40 },
    });
    expect(relay.rows.find((r) => r.id === 'radio').connected).toBe(false);
    expect(relay.rows.find((r) => r.id === 'radio').statusHe).toBe('לא מחובר');
    expect(relay.rows.find((r) => r.id === 'radio').hintHe).not.toBe('דרך מחשב משימה · ממסר');
    expect(relay.rows.find((r) => r.id === 'cellular').connected).toBe(false);
    expect(relay.rows.find((r) => r.id === 'cellular').statusHe).toBe('אות בלבד');
    expect(relay.rows.find((r) => r.id === 'cellular').quality.bars).toBe(3);
    expect(relay.rows.find((r) => r.id === 'home').quality.known).toBe(true);
    expect(relay.rows.find((r) => r.id === 'home').connected).toBe(true);
    expect(relay.pillLabelHe).toBe('מחובר · רשת בית');
  });

  it('styles disconnect as danger inside the popover and not green for connect', () => {
    const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
    expect(css).toMatch(/data-tone="ok"/);
    expect(css).toMatch(/data-tone="wait"/);
    expect(css).toMatch(/data-tone="bad"/);
    expect(css).toMatch(/data-tone="off"/);
    expect(css).toMatch(/#companionLinkBtn\.conn-btn-primary\[data-action="disconnect"\][\s\S]*?#dc2626/);
    expect(css).not.toMatch(/#companionLinkBtn\.conn-btn-primary\[data-connected="1"\]\s*\{[^}]*#16a34a/);
    expect(css).toMatch(/\[data-action="disconnect"\][\s\S]*#dc2626/);
  });
});

describe('connect popover relay cache, home ownership, and prefs', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-popover-${Date.now()}-${process.pid}.sqlite`);
  let db;
  let server;
  let base;

  beforeAll(async () => {
    db = openDatabase(tmpPath);
    const app = express();
    app.use(express.json());
    const ctx = { db, env: {}, lastCompanionMavlinkRelay: null, companionService: null };
    registerDualLinkApi(app, ctx);
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('clears the relay cache when radio disconnects', () => {
    const ctx = {
      db,
      lastCompanionMavlinkRelay: { ok: true, id: 6, connected: true },
      closeCompanionMavlinkRelay: () => ({ ok: true, closed: [6] }),
    };
    const result = disconnectLink(ctx, 'radio');
    expect(result.ok).toBe(true);
    expect(ctx.lastCompanionMavlinkRelay).toBeNull();
  });

  it('persists prefs and tells the operator when the Jetson cannot switch uplinks', async () => {
    expect(readLinkPrefs(db)).toEqual({ cellular: true, home: true, radio: true });
    const saved = writeLinkPrefs(db, { cellular: false });
    expect(saved.cellular).toBe(false);
    expect(readLinkPrefs(db).cellular).toBe(false);
    expect(readLinkPrefs(db).radio).toBe(true);

    const off = await applyLinkPrefs({ db, companionService: null }, { cellular: false });
    expect(off.uplinkControl).toBe(false);
    expect(off.noticeHe).toBe(UPLINK_CONSOLE_ONLY_HE);
    expect(off.prefs.cellular).toBe(false);

    const armed = await applyLinkPrefs({
      db,
      companionService: {
        mode: 'off',
        getSseOverlay: () => ({ companion: { health: { capabilities: { uplinkControl: true } } } }),
      },
    }, { home: true });
    expect(armed.uplinkControl).toBe(true);
    expect(armed.noticeHe).toBeNull();

    const probed = await applyLinkPrefs({
      db,
      companionService: null,
      probeUplinkControl: async () => false,
    }, { home: false });
    expect(probed.uplinkControl).toBe(false);
    expect(probed.noticeHe).toBe(UPLINK_CONSOLE_ONLY_HE);

    const res = await fetch(`${base}/api/links/prefs`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.prefs.cellular).toBe(false);
    const posted = await fetch(`${base}/api/links/prefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cellular: true, radio: true }),
    });
    const postedBody = await posted.json();
    expect(posted.status).toBe(200);
    expect(postedBody.prefs.cellular).toBe(true);
    expect(postedBody.noticeHe).toBe(UPLINK_CONSOLE_ONLY_HE);
    expect(readLinkPrefs(db).cellular).toBe(true);
  });

  it('does not auto-reopen a disabled radio relay', async () => {
    writeLinkPrefs(db, { radio: false });
    const skipped = await ensureCompanionMavlinkRelay({
      db,
      companionService: { mode: 'real', baseUrl: 'http://127.0.0.1:9' },
      lastCompanionMavlinkRelay: null,
    });
    expect(skipped.skipped).toBe('disabled');
    expect(skipped.ok).toBe(false);
    writeLinkPrefs(db, { radio: true });
  });
});

describe('home disconnect keeps the radio relay and the token', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-home-own-${Date.now()}-${process.pid}.sqlite`);
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('httpOnly disconnect does not close the relay or wipe the token', async () => {
    const token = 'home-row-token-keep';
    writeStoredCompanionConnection(db, {
      connected: true,
      mode: 'real',
      baseUrl: 'http://127.0.0.1:9',
      token,
    });
    const closed = [];
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true, status: 'OK' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const companionService = createCompanionService(
      { COMPANION_MODE: 'real', JETSON_COMPANION_BASE_URL: 'http://127.0.0.1:9' },
      { fetchImpl, timeoutMs: 50, pollMs: 60_000 },
    );
    const ctx = {
      db,
      companionService,
      companionEnv: {},
      lastCompanionMavlinkRelay: { ok: true, id: 6, connected: true, host: '127.0.0.1', port: 5770 },
      closeCompanionMavlinkRelay: (opts) => {
        closed.push(opts?.lastRelay?.id ?? null);
        return { ok: true, closed: [opts?.lastRelay?.id] };
      },
    };
    const app = express();
    app.use(express.json());
    registerCompanionConnectionApi(app, ctx);
    const server = await listen(app);
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${url}/api/companion/connection/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ httpOnly: true }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.relay_kept).toBe(true);
      expect(closed).toEqual([]);
      expect(ctx.lastCompanionMavlinkRelay?.id).toBe(6);
      expect(getConfig(db, COMPANION_CONNECTION_KEY).token).toBe(token);
      expect(getConfig(db, COMPANION_CONNECTION_KEY).connected).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const direct = await disconnectCompanionSession(ctx, { httpOnly: true });
    expect(direct.mode === 'off' || direct.mode === 'mock' || direct.connected === false).toBe(true);
    expect(ctx.lastCompanionMavlinkRelay?.id).toBe(6);
  });
});

describe('cellular and home uplink buttons', () => {
  it('derives the row from enabled versus up', () => {
    expect(displayFromUplink({ enabled: false, up: false })).toMatchObject({
      tone: 'off',
      connected: false,
      sessionOpen: false,
      statusHe: 'מושבת',
    });
    expect(displayFromUplink({ enabled: true, up: true })).toMatchObject({
      tone: 'ok',
      connected: true,
      sessionOpen: true,
      statusHe: 'מחובר',
    });
    expect(displayFromUplink({ enabled: true, up: false })).toMatchObject({
      tone: 'wait',
      connected: false,
      sessionOpen: true,
      statusHe: 'לא עלה',
    });
    expect(uplinkRefusalHe({ reason_he: 'אי אפשר עכשיו' })).toBe('אי אפשר עכשיו');
    expect(uplinkRefusalHe({
      reason: 'last_uplink',
      message: 'אי אפשר לכבות את הקישור האחרון',
    })).toBe('אי אפשר לכבות את הקישור האחרון');
    expect(uplinkRefusalHe({ message: 'cannot disconnect the last active link' })).toBe(UPLINK_LAST_LINK_HE);

    const live = summarizeCommLinks({
      modemPresent: true,
      uplinkControl: true,
      uplinks: {
        wifi: { enabled: true, up: true, signal_dbm: -55 },
        cellular: { enabled: true, up: false },
      },
      companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר' },
    });
    const home = live.rows.find((r) => r.id === 'home');
    const cell = live.rows.find((r) => r.id === 'cellular');
    expect(home).toMatchObject({ tone: 'ok', statusHe: 'מחובר', actionHe: 'התנתק', uplinkControl: true });
    expect(home.quality.bars).toBe(4);
    expect(cell).toMatchObject({ tone: 'wait', statusHe: 'לא עלה', actionHe: 'התנתק', uplinkControl: true });

    const locked = summarizeCommLinks({
      modemPresent: true,
      uplinkControl: false,
      uplinks: { wifi: { enabled: true, up: true, signal_dbm: -60 } },
      companion: { jetson: 'reachable' },
    });
    const lockedHome = locked.rows.find((r) => r.id === 'home');
    expect(lockedHome.statusHe).toBe('מחובר');
    expect(lockedHome.actionHe).toBe('התחבר');
    expect(lockedHome.uplinkControl).toBe(false);
  });

  it('posts the companion uplink and shows a Hebrew 409 without pretending', async () => {
    const tmpPath = path.join(os.tmpdir(), `test-vlc-uplink-${Date.now()}-${process.pid}.sqlite`);
    const db = openDatabase(tmpPath);
    const calls = [];
    writeStoredCompanionConnection(db, {
      connected: true,
      mode: 'real',
      baseUrl: 'http://127.0.0.1:9',
      token: 'keep-me',
    });
    const ctx = {
      db,
      lastCompanionMavlinkRelay: { ok: true, id: 4, connected: true },
      networkUplinks: {
        wifi: { enabled: true, up: true },
        cellular: { enabled: true, up: true },
      },
      companionService: {
        mode: 'off',
        getSseOverlay: () => ({ companion: { health: { capabilities: { uplinkControl: true } } } }),
      },
      setNetworkUplink: async (which, body) => {
        calls.push({ which, enabled: body?.enabled });
        if (which === 'wifi' && body?.enabled === false) {
          const err = new Error('conflict');
          err.status = 409;
          err.body = { ok: false, reason: 'last_uplink', message: 'אי אפשר לכבות את הקישור האחרון' };
          throw err;
        }
        return {
          wifi: { enabled: true, up: true },
          cellular: { enabled: body?.enabled === true, up: true },
        };
      },
    };
    const app = express();
    app.use(express.json());
    registerDualLinkApi(app, ctx);
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const refused = await setCompanionUplink(ctx, { role: 'home', enabled: false });
      expect(refused.ok).toBe(false);
      expect(refused.status).toBe(409);
      expect(refused.messageHe).toBe('אי אפשר לכבות את הקישור האחרון');
      expect(calls).toEqual([{ which: 'wifi', enabled: false }]);
      expect(ctx.lastCompanionMavlinkRelay?.id).toBe(4);
      expect(getConfig(db, COMPANION_CONNECTION_KEY).token).toBe('keep-me');
      expect(readLinkPrefs(db).home).toBe(true);

      const unsupported = await setCompanionUplink({
        db,
        setNetworkUplink: async () => { throw new Error('should not post'); },
      }, { role: 'cellular', enabled: false });
      expect(unsupported.messageHe).toBe(UPLINK_UNSUPPORTED_HE);
      expect(unsupported.uplinkControl).toBe(false);

      calls.length = 0;
      const posted = await fetch(`${base}/api/links/uplink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'cellular', enabled: true }),
      });
      const postedBody = await posted.json();
      expect(posted.status).toBe(200);
      expect(postedBody.ok).toBe(true);
      expect(calls).toEqual([{ which: 'cellular', enabled: true }]);
      expect(postedBody.links.comm.rows.find((r) => r.id === 'cellular').statusHe).toBe('מחובר');

      const denied = await fetch(`${base}/api/links/uplink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'home', enabled: false }),
      });
      const deniedBody = await denied.json();
      expect(denied.status).toBe(409);
      expect(deniedBody.messageHe).toBe('אי אפשר לכבות את הקישור האחרון');
      expect(getConfig(db, COMPANION_CONNECTION_KEY).token).toBe('keep-me');
      expect(ctx.lastCompanionMavlinkRelay?.id).toBe(4);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });
});
