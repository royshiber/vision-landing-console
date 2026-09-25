/**
 * Runtime for dual MAVLink links. Wraps the existing MavlinkConnection registry.
 * Radio = UDP / TCP / serial (existing quick-connect).
 * Cellular = MAVLink over the cell endpoint (not Companion-HTTP).
 */

import {
  activateConnection,
  deactivateConnection,
  getAllConnectionStatuses,
  getConnectionStatus,
  getMavlinkConnection,
  setCommandLinkId,
  getCommandLinkId,
  deactivateConnectionsByRole,
} from './mavlink-connection.mjs';
import {
  companionModemReport,
  probeHuaweiE3372,
  resolveCellularModem,
} from './cellular-modem.mjs';
import {
  annotatedStreamPresent,
  annotatedVideoAvailability,
  cellularConnectGate,
  cellularUpdateReadiness,
  commandLinkOpsPath,
  DEFAULT_CELLULAR_ENDPOINT,
  liveStatusToLinkState,
  normalizeLinkRole,
  summarizeDualLink,
} from './dual-link.mjs';
import { getConfig, setConfig, dataDir } from './db.mjs';
import { createTelemetryArchive } from './telemetry-archive.mjs';
import { logger } from './logger.mjs';
import { composeConnectPill } from './companion-link.mjs';
import {
  readStoredCompanionConnection,
  snapshotCompanionLinkFromCtx,
} from './companion-connection.mjs';
import {
  closeCompanionMavlinkRelay,
  companionMavlinkRelayTarget,
  isCompanionRelayStatus,
} from './companion-mavlink-relay.mjs';
import {
  extractCompanionSignal,
  readLinkPrefs,
  snapshotRcLink,
  summarizeCommLinks,
  uplinkControlFromCompanion,
  UPLINK_CONSOLE_ONLY_HE,
  writeLinkPrefs,
} from './comm-links.mjs';

const PREFERRED_KEY = 'dualLink.preferred';
const CELLULAR_ENDPOINT_KEY = 'dualLink.cellularEndpoint';

/** @type {ReturnType<typeof createTelemetryArchive> | null} */
let archive = null;

export function getTelemetryArchive(ctx = {}) {
  if (!archive) {
    archive = createTelemetryArchive({ db: ctx.db || null, rootDir: ctx.dataDir || dataDir });
  }
  return archive;
}

export function resetDualLinkRuntimeForTests() {
  archive = null;
  setCommandLinkId(null);
}

function readPreferred(db) {
  if (!db) return 'radio';
  try {
    return normalizeLinkRole(getConfig(db, PREFERRED_KEY, 'radio'), 'radio');
  } catch {
    return 'radio';
  }
}

function writePreferred(db, role) {
  if (!db) return;
  try { setConfig(db, PREFERRED_KEY, normalizeLinkRole(role, 'radio')); } catch { /* ignore */ }
}

export function readCellularEndpoint(db) {
  const fallback = { ...DEFAULT_CELLULAR_ENDPOINT };
  if (!db) return fallback;
  try {
    const saved = getConfig(db, CELLULAR_ENDPOINT_KEY, null);
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      type: saved.type === 'tcp' ? 'tcp' : 'udp',
      host: String(saved.host || fallback.host),
      port: Number(saved.port) > 0 ? Number(saved.port) : fallback.port,
    };
  } catch {
    return fallback;
  }
}

function writeCellularEndpoint(db, endpoint) {
  if (!db) return;
  try { setConfig(db, CELLULAR_ENDPOINT_KEY, endpoint); } catch { /* ignore */ }
}

function statusForRole(role) {
  const live = getAllConnectionStatuses();
  return live.find((s) => (s.linkRole || 'radio') === role) || null;
}

function resolveModemFromCtx(ctx = {}) {
  const local = probeHuaweiE3372({
    env: ctx.env || process.env,
    existsSync: ctx.existsSync,
  });
  const companion = ctx.companion || snapshotCompanionLinkFromCtx(ctx);
  return resolveCellularModem({
    local,
    companionModem: companionModemReport(companion),
  });
}

function companionReachableFrom(companion) {
  return companion?.jetson === 'reachable' || companion?.jetson === 'mock';
}

function applyCommandLink(preferred, { modemPresent = true } = {}) {
  const radio = statusForRole('radio');
  const cellular = statusForRole('cellular');
  const radioUp = radio?.connected;
  const cellUp = modemPresent === true && cellular?.connected;
  let id = null;
  if (radioUp && cellUp) {
    id = preferred === 'cellular' ? cellular.id : radio.id;
  } else if (radioUp) {
    id = radio.id;
  } else if (cellUp) {
    id = cellular.id;
  }
  setCommandLinkId(id);
  return id;
}

export function snapshotDualLink(ctx = {}) {
  const db = ctx.db || null;
  const companion = snapshotCompanionLinkFromCtx(ctx);
  const modem = resolveModemFromCtx({ ...ctx, companion });
  const radioLive = statusForRole('radio');
  const cellLive = statusForRole('cellular');
  const preferred = readPreferred(db);
  const radioState = liveStatusToLinkState(radioLive, { role: 'radio' });
  const cellularState = liveStatusToLinkState(cellLive, {
    role: 'cellular',
    modemPresent: modem.present,
  });
  const streamPresent = annotatedStreamPresent(companion);
  const summary = summarizeDualLink({
    radio: radioState,
    cellular: cellularState,
    preferred,
    modemPresent: modem.present,
    streamPresent,
  });
  const commandId = applyCommandLink(preferred, { modemPresent: modem.present });
  const endpoint = readCellularEndpoint(db);
  const rc = snapshotRcLink(getAllConnectionStatuses());
  const prefs = readLinkPrefs(db);
  const comm = summarizeCommLinks({
    radio: radioState,
    cellular: cellularState,
    preferred,
    modemPresent: modem.present,
    companion,
    rc,
    cellularSignal: extractCompanionSignal(companion),
    radioLive,
    cellularLive: cellLive,
    radioViaRelay: radioUsesCompanionRelay(ctx, radioLive),
    prefs,
    homeRttMs: companion?.httpRttMs ?? companion?.health?.rtt_ms ?? companion?.health?.http_rtt_ms ?? null,
  });
  const composed = composeConnectPill({
    dual: { ...summary, pillLabelHe: comm.pillLabelHe },
    companion,
  });
  const video = annotatedVideoAvailability({
    cellular: cellularState,
    modemPresent: modem.present,
    streamPresent,
  });
  const companionReachable = companionReachableFrom(companion);
  return {
    ...summary,
    companion,
    comm,
    rc,
    pillLabelHe: comm.pillLabelHe || composed.pillLabelHe,
    pillDot: comm.pillDot || composed.pillDot,
    prefs,
    uplinkControl: uplinkControlFromCompanion(companion),
    modem,
    endpoint,
    radioConnection: radioLive,
    cellularConnection: cellLive,
    commandLinkId: commandId ?? getCommandLinkId(),
    video,
    ops: commandLinkOpsPath({
      active: summary.active,
      commandLinkId: commandId ?? getCommandLinkId(),
      modemPresent: modem.present,
      companionReachable,
      video,
    }),
    update: cellularUpdateReadiness({ companionReachable }),
  };
}

function insertProfile(db, { name, type, host, port, serialPort, baudRate, linkRole }) {
  const ins = db.prepare(
    `INSERT INTO connections (name, type, host, port, serial_port, baud_rate, link_role)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    name,
    type,
    host ?? null,
    port != null ? Number(port) : null,
    serialPort ?? null,
    baudRate != null ? Number(baudRate) : 57600,
    linkRole === 'cellular' ? 'cellular' : 'radio',
  );
  return Number(ins.lastInsertRowid);
}

function radioUsesCompanionRelay(ctx, radioLive) {
  if (!radioLive) return false;
  const stored = readStoredCompanionConnection(ctx.db || null);
  const base = String(ctx.companionService?.baseUrl || stored.baseUrl || '').trim();
  const target = companionMavlinkRelayTarget(base, ctx.jetsonState?.relayPort);
  if (target && isCompanionRelayStatus(radioLive, target)) return true;
  const cached = ctx.lastCompanionMavlinkRelay;
  return !!(cached?.ok && cached.id != null && Number(radioLive.id) === Number(cached.id) && radioLive.type === 'tcp');
}

export async function connectRadioRelay(ctx = {}) {
  const prefs = readLinkPrefs(ctx.db);
  if (prefs.radio === false) {
    return { ok: false, state: 'disabled', message: 'הקישור מושבת' };
  }
  const { ensureCompanionMavlinkRelay } = await import('./routes/companion-connection-api.mjs');
  const relay = await ensureCompanionMavlinkRelay(ctx);
  if (!relay?.ok) {
    return {
      ok: false,
      state: relay?.skipped === 'disabled' ? 'disabled' : 'error',
      message: relay?.status_he || 'ממסר הטלמטריה לא נפתח',
      relay,
    };
  }
  applyCommandLink(readPreferred(ctx.db), { modemPresent: resolveModemFromCtx(ctx).present });
  return { ok: true, id: relay.id ?? null, role: 'radio', via: 'relay', relay };
}

export async function applyLinkPrefs(ctx = {}, patch = {}) {
  const previous = readLinkPrefs(ctx.db);
  const next = writeLinkPrefs(ctx.db, patch || {});
  const touchedUplink = patch.cellular === true || patch.cellular === false
    || patch.home === true || patch.home === false;
  let uplinkControl = uplinkControlFromCompanion(snapshotCompanionLinkFromCtx(ctx));
  if (!uplinkControl && typeof ctx.probeUplinkControl === 'function') {
    try { uplinkControl = (await ctx.probeUplinkControl()) === true; } catch { uplinkControl = false; }
  }
  let noticeHe = null;
  let jetsonApplied = false;
  if (touchedUplink && uplinkControl && typeof ctx.applyJetsonUplink === 'function') {
    try {
      jetsonApplied = (await ctx.applyJetsonUplink(next)) === true;
      if (!jetsonApplied) noticeHe = UPLINK_CONSOLE_ONLY_HE;
    } catch {
      noticeHe = UPLINK_CONSOLE_ONLY_HE;
    }
  } else if (touchedUplink && !uplinkControl) {
    noticeHe = UPLINK_CONSOLE_ONLY_HE;
  }
  if (patch.radio === false) disconnectLink(ctx, 'radio');
  if (patch.cellular === false) disconnectLink(ctx, 'cellular');
  return { ok: true, prefs: next, previous, uplinkControl, noticeHe, jetsonApplied };
}

export async function connectLink(ctx, { role, type, host, port, serialPort, baudRate, via, force } = {}) {
  const db = ctx.db;
  const linkRole = normalizeLinkRole(role, 'radio');
  if (linkRole === 'radio' && (via === 'relay' || via === 'companion')) {
    return connectRadioRelay(ctx);
  }
  const prefs = readLinkPrefs(db);
  if (prefs[linkRole] === false && force !== true) {
    return { ok: false, state: 'disabled', message: 'הקישור מושבת' };
  }
  const br = Number(baudRate) || 57600;

  if (linkRole === 'cellular') {
    const endpoint = {
      type: type === 'tcp' ? 'tcp' : 'udp',
      host: String(host || DEFAULT_CELLULAR_ENDPOINT.host).trim() || DEFAULT_CELLULAR_ENDPOINT.host,
      port: Number(port) > 0 ? Number(port) : DEFAULT_CELLULAR_ENDPOINT.port,
    };
    writeCellularEndpoint(db, endpoint);
    const modem = resolveModemFromCtx(ctx);
    const gate = cellularConnectGate({ modemPresent: modem.present, host: endpoint.host });
    if (!gate.allowed) {
      return {
        ok: false,
        state: 'modem_absent',
        message: gate.messageHe,
        modem,
      };
    }
    deactivateConnectionsByRole('cellular');
    if (db) db.prepare(`UPDATE connections SET active = 0 WHERE link_role = 'cellular'`).run();
    const name = `סלולר ${endpoint.host}:${endpoint.port}`;
    const id = insertProfile(db, {
      name,
      type: endpoint.type,
      host: endpoint.host,
      port: endpoint.port,
      serialPort: null,
      baudRate: br,
      linkRole: 'cellular',
    });
    try {
      await activateConnection({
        id,
        name,
        type: endpoint.type,
        host: endpoint.host,
        port: endpoint.port,
        baudRate: br,
        linkRole: 'cellular',
      });
    } catch (err) {
      try { db.prepare(`DELETE FROM connections WHERE id = ?`).run(id); } catch { /* ignore */ }
      logger.warn({ err: err?.message, id }, '[dual-link] cellular activate failed');
      return { ok: false, message: err?.message || 'הפעלת סלולר נכשלה', state: 'error' };
    }
    db.prepare(`UPDATE connections SET active = 1, last_connected = datetime('now') WHERE id = ?`).run(id);
    applyCommandLink(readPreferred(db), { modemPresent: modem.present });
    return { ok: true, id, role: 'cellular', status: getConnectionStatus(id), mode: gate.mode };
  }

  deactivateConnectionsByRole('radio');
  if (db) db.prepare(`UPDATE connections SET active = 0 WHERE COALESCE(link_role, 'radio') = 'radio'`).run();

  let name;
  let rowHost = host != null && host !== '' ? String(host).trim() : null;
  let rowPort = port != null && port !== '' ? Number(port) : null;
  const rowSerial = serialPort != null && String(serialPort).trim() ? String(serialPort).trim() : null;

  if (type === 'serial') {
    if (!rowSerial) return { ok: false, message: 'חסר יעד סיריאלי' };
    name = `Serial ${rowSerial}`;
  } else if (type === 'udp') {
    if (!Number.isFinite(rowPort)) rowPort = 14550;
    name = `UDP :${rowPort}`;
    rowHost = rowHost || '0.0.0.0';
  } else if (type === 'tcp') {
    if (!rowHost || !Number.isFinite(rowPort)) {
      return { ok: false, message: 'חסר יעד לחיבור' };
    }
    name = `TCP ${rowHost}:${rowPort}`;
  } else {
    return { ok: false, message: 'סוג חיבור לא נתמך' };
  }

  const id = insertProfile(db, {
    name,
    type,
    host: rowHost,
    port: rowPort,
    serialPort: rowSerial,
    baudRate: br,
    linkRole: 'radio',
  });
  try {
    await activateConnection({
      id,
      name,
      type,
      host: rowHost || '0.0.0.0',
      port: Number.isFinite(rowPort) ? rowPort : 14550,
      serialPort: rowSerial || undefined,
      baudRate: br,
      linkRole: 'radio',
    });
  } catch (err) {
    try { db.prepare(`DELETE FROM connections WHERE id = ?`).run(id); } catch { /* ignore */ }
    logger.warn({ err: err?.message, id }, '[dual-link] radio activate failed');
    return { ok: false, message: err?.message || 'הפעלת חיבור נכשלה', state: 'error' };
  }
  db.prepare(`UPDATE connections SET active = 1, last_connected = datetime('now') WHERE id = ?`).run(id);
  applyCommandLink(readPreferred(db), {
    modemPresent: resolveModemFromCtx(ctx).present,
  });
  return { ok: true, id, role: 'radio', status: getConnectionStatus(id) };
}

export function disconnectLink(ctx, role) {
  const linkRole = normalizeLinkRole(role, 'radio');
  if (linkRole === 'radio') {
    const close = ctx.closeCompanionMavlinkRelay || closeCompanionMavlinkRelay;
    try {
      const stored = readStoredCompanionConnection(ctx.db || null);
      close({
        db: ctx.db || null,
        baseUrl: stored.baseUrl || ctx.companionService?.baseUrl || '',
        jetsonState: ctx.jetsonState || null,
        lastRelay: ctx.lastCompanionMavlinkRelay || null,
      });
    } catch { /* ignore */ }
    ctx.lastCompanionMavlinkRelay = null;
  }
  const n = deactivateConnectionsByRole(linkRole);
  if (ctx.db) {
    ctx.db.prepare(
      `UPDATE connections SET active = 0 WHERE COALESCE(link_role, 'radio') = ?`,
    ).run(linkRole);
  }
  applyCommandLink(readPreferred(ctx.db), {
    modemPresent: resolveModemFromCtx(ctx).present,
  });
  return { ok: true, disconnected: n, role: linkRole };
}

export function setActiveLink(ctx, role) {
  const snap = snapshotDualLink(ctx);
  const linkRole = normalizeLinkRole(role, snap.active || 'radio');
  if (snap.bothConnected && linkRole !== 'radio' && linkRole !== 'cellular') {
    return { ok: false, message: 'בחרו רדיו או סלולר' };
  }
  writePreferred(ctx.db, linkRole);
  const id = applyCommandLink(linkRole, { modemPresent: snap.modemPresent });
  const conn = id != null ? getMavlinkConnection(id) : null;
  return {
    ok: true,
    active: linkRole,
    commandLinkId: id,
    connected: Boolean(conn?.connected),
    snapshot: snapshotDualLink(ctx),
  };
}
