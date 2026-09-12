/**
 * Open the Jetson MAVLink TCP relay when Companion HTTP is connected.
 * Companion /api/health UART heartbeat is not a GCS stream — Mission HUD
 * needs this TCP session (companion_agent.py VLC_RELAY_PORT, default 5770).
 * No flight commands. No Companion apply/restart. Does not invent gauges.
 */
import { logger } from './logger.mjs';
import {
  activateConnection,
  deactivateConnection,
  getAllConnectionStatuses,
  getConnectionStatus,
} from './mavlink-connection.mjs';
import {
  DEFAULT_RELAY_PORT,
  companionMavlinkRelayTarget,
} from './jetson-companion-proxy.mjs';

export { DEFAULT_RELAY_PORT, companionMavlinkRelayTarget } from './jetson-companion-proxy.mjs';

export const COMPANION_RELAY_CONNECT_TIMEOUT_MS = 4000;

export const COMPANION_RELAY_HE = Object.freeze({
  opened: 'ממסר הטלמטריה פתוח.',
  failed: 'ממסר הטלמטריה לא נפתח.',
  failedWhileHeartbeat: 'דופק חי בבקר. ממסר הטלמטריה לא נפתח.',
  skippedLive: 'קישור טלמטריה כבר פתוח.',
  skippedMock: 'חיבור מדומה למחשב משימה.',
  noTarget: 'אין יעד לממסר טלמטריה.',
});

function trim(value) {
  return String(value || '').trim();
}

function radioStatuses(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && s.linkRole !== 'cellular');
}

export function isCompanionRelayStatus(status, target) {
  if (!status || !target) return false;
  if (String(status.type || '').toLowerCase() !== 'tcp') return false;
  return trim(status.host) === trim(target.host) && Number(status.port) === Number(target.port);
}

export function publicRelaySnapshot(relay) {
  if (!relay || typeof relay !== 'object') return null;
  return {
    ok: relay.ok === true,
    skipped: relay.skipped || null,
    host: relay.host || null,
    port: relay.port ?? null,
    id: relay.id ?? null,
    connected: relay.connected === true,
    heartbeat: relay.heartbeat === true,
    status_he: relay.status_he || null,
    error: relay.error || null,
  };
}

/**
 * Overlay Hebrew when UART heartbeat is up but the GCS TCP relay is down.
 * Does not change fc / דופק חי honesty.
 */
export function applyMavlinkRelayHint(status, relay) {
  if (!status) return status;
  const snap = publicRelaySnapshot(relay);
  if (!snap) return status;
  const next = { ...status, mavlinkRelay: snap };
  if (snap.ok || snap.skipped === 'live_radio' || snap.skipped === 'mock') return next;
  const heartbeatUp = status.fc === 'heartbeat' || status.fc_heartbeat === true;
  if (heartbeatUp) next.hint_he = COMPANION_RELAY_HE.failedWhileHeartbeat;
  else if (status.connected || status.jetson === 'reachable' || status.jetson === 'mock') {
    next.hint_he = snap.status_he || COMPANION_RELAY_HE.failed;
  }
  return next;
}

function seedJetsonRelayState(jetsonState, target, baseUrl) {
  if (!jetsonState || !target) return;
  if (!trim(jetsonState.peerIp)) jetsonState.peerIp = target.host;
  if (!Number(jetsonState.relayPort)) jetsonState.relayPort = target.port;
  if (baseUrl && !trim(jetsonState.companionHttpUrl)) {
    jetsonState.companionHttpUrl = String(baseUrl).replace(/\/+$/, '');
  }
}

function insertRelayRow(db, target) {
  if (!db) return Date.now();
  const ins = db.prepare(
    `INSERT INTO connections (name, type, host, port, serial_port, baud_rate, link_role) VALUES (?,?,?,?,?,?,?)`,
  ).run(target.label, 'tcp', target.host, target.port, null, 57600, 'radio');
  return Number(ins.lastInsertRowid);
}

function markRowActive(db, id, active) {
  if (!db || !id) return;
  try {
    if (active) {
      db.prepare(`UPDATE connections SET active = 1, last_connected = datetime('now') WHERE id = ?`).run(id);
    } else {
      db.prepare(`UPDATE connections SET active = 0 WHERE id = ?`).run(id);
    }
  } catch {
    /* ignore */
  }
}

function deleteRow(db, id) {
  if (!db || !id) return;
  try { db.prepare(`DELETE FROM connections WHERE id = ?`).run(id); } catch { /* ignore */ }
}

function listRelayRows(db, target) {
  if (!db || !target) return [];
  try {
    return db.prepare(
      `SELECT id, type, host, port, link_role FROM connections WHERE type = 'tcp' AND host = ? AND port = ?`,
    ).all(target.host, target.port);
  } catch {
    return [];
  }
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(message);
          err.code = 'relay_timeout';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database|null} [opts.db]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.relayPort]
 * @param {object} [opts.jetsonState]
 * @param {boolean} [opts.mock]
 * @returns {Promise<object>}
 */
export async function openCompanionMavlinkRelay(opts = {}) {
  const {
    db = null,
    baseUrl = '',
    relayPort = DEFAULT_RELAY_PORT,
    jetsonState = null,
    mock = false,
    activate = activateConnection,
    deactivate = deactivateConnection,
    listStatuses = getAllConnectionStatuses,
    statusOf = getConnectionStatus,
    timeoutMs = COMPANION_RELAY_CONNECT_TIMEOUT_MS,
  } = opts;

  if (mock) {
    return { ok: false, skipped: 'mock', status_he: COMPANION_RELAY_HE.skippedMock, error: 'mock' };
  }

  const target = companionMavlinkRelayTarget(baseUrl, jetsonState?.relayPort || relayPort);
  if (!target) {
    return { ok: false, error: 'no_target', status_he: COMPANION_RELAY_HE.noTarget };
  }

  seedJetsonRelayState(jetsonState, target, baseUrl);

  const live = radioStatuses(listStatuses());
  const existingRelay = live.find((s) => isCompanionRelayStatus(s, target));
  if (existingRelay) {
    const hb = Number(existingRelay.heartbeatCount) > 0;
    return {
      ok: true,
      skipped: 'already_open',
      id: existingRelay.id,
      host: target.host,
      port: target.port,
      connected: existingRelay.connected === true || existingRelay.listening === true,
      heartbeat: hb,
      status_he: COMPANION_RELAY_HE.opened,
    };
  }
  const otherLive = live.find((s) => s.connected === true || s.listening === true);
  if (otherLive) {
    return {
      ok: false,
      skipped: 'live_radio',
      host: target.host,
      port: target.port,
      status_he: COMPANION_RELAY_HE.skippedLive,
      error: 'live_radio',
    };
  }

  const id = insertRelayRow(db, target);
  try {
    await withTimeout(
      activate({
        id,
        name: target.label,
        type: 'tcp',
        host: target.host,
        port: target.port,
        baudRate: 57600,
        linkRole: 'radio',
      }),
      timeoutMs,
      COMPANION_RELAY_HE.failed,
    );
  } catch (err) {
    try { deactivate(id); } catch { /* ignore */ }
    deleteRow(db, id);
    logger.warn({ err: err?.message, host: target.host, port: target.port }, 'companion MAVLink relay activate failed');
    return {
      ok: false,
      error: err?.code === 'relay_timeout' ? 'timeout' : 'activate_failed',
      host: target.host,
      port: target.port,
      status_he: COMPANION_RELAY_HE.failed,
    };
  }

  markRowActive(db, id, true);
  const status = statusOf(id) || {};
  return {
    ok: true,
    id,
    host: target.host,
    port: target.port,
    connected: status.connected === true || status.listening === true,
    heartbeat: Number(status.heartbeatCount) > 0,
    status: status,
    status_he: COMPANION_RELAY_HE.opened,
  };
}

/**
 * Close only the Companion-owned TCP relay. Leave USB / SITL / cellular alone.
 */
export function closeCompanionMavlinkRelay(opts = {}) {
  const {
    db = null,
    baseUrl = '',
    relayPort = DEFAULT_RELAY_PORT,
    jetsonState = null,
    lastRelay = null,
    deactivate = deactivateConnection,
    listStatuses = getAllConnectionStatuses,
  } = opts;

  const target = companionMavlinkRelayTarget(
    baseUrl || lastRelay?.host && `http://${lastRelay.host}`,
    lastRelay?.port || jetsonState?.relayPort || relayPort,
  );
  const closed = [];
  const live = radioStatuses(listStatuses());
  for (const s of live) {
    const matchId = lastRelay?.id != null && Number(s.id) === Number(lastRelay.id);
    const matchTarget = target && isCompanionRelayStatus(s, target);
    if (!matchId && !matchTarget) continue;
    try { deactivate(s.id); } catch { /* ignore */ }
    markRowActive(db, s.id, false);
    closed.push(s.id);
  }
  if (target) {
    for (const row of listRelayRows(db, target)) {
      if (!closed.includes(row.id)) {
        try { deactivate(row.id); } catch { /* ignore */ }
        markRowActive(db, row.id, false);
        closed.push(row.id);
      }
    }
  }
  if (lastRelay?.id != null && !closed.includes(Number(lastRelay.id))) {
    try { deactivate(lastRelay.id); } catch { /* ignore */ }
    markRowActive(db, lastRelay.id, false);
    closed.push(Number(lastRelay.id));
  }
  return { ok: true, closed };
}
