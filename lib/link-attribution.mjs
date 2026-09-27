/**
 * Which popover card owns a companion path.
 * Home is an RFC1918 address reached directly.
 * Cellular is a Tailscale 100.64.0.0/10 address (direct or via the SOCKS proxy).
 * Radio is only a local serial/USB telemetry radio. The MAVLink relay is not a radio.
 * Latency is recorded only from a measured probe. Missing data stays empty.
 */

import os from 'node:os';

export const HOME_LAN_ABSENT_HE = 'המחשב לא מחובר לרשת הבית';
const LAN_TIMEOUT_HE = 'הכתובת לא הגיבה בזמן';

const RELAY_PORT = 5770;
const RELAY_FRESH_MS = 3000;

export function classifyCompanionHost(host) {
  let name = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (name.startsWith('::ffff:')) name = name.slice('::ffff:'.length);
  if (
    name.startsWith('192.168.')
    || name.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(name)
  ) return 'lan';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name)) return 'tailscale';
  return 'other';
}

export function companionUrlHost(url) {
  const raw = String(url || '').split(',')[0].trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

export function classifyCompanionUrl(url) {
  const host = companionUrlHost(url);
  if (!host) return 'other';
  return classifyCompanionHost(host);
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return null;
    n = (n * 256 + value) >>> 0;
  }
  return n;
}

function maskFromInterface(addr) {
  const fromNetmask = ipv4ToInt(addr?.netmask);
  if (fromNetmask != null) return fromNetmask;
  const bits = Number(String(addr?.cidr || '').split('/')[1]);
  if (!Number.isInteger(bits) || bits < 1 || bits > 32) return null;
  if (bits === 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

/**
 * True when any non-loopback IPv4 interface shares its own netmask with the target.
 * `interfaces` is the shape returned by os.networkInterfaces().
 */
export function hostSharesSubnet(targetHost, interfaces) {
  let name = String(targetHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (name.startsWith('::ffff:')) name = name.slice('::ffff:'.length);
  const target = ipv4ToInt(name);
  if (target == null || !interfaces || typeof interfaces !== 'object') return false;
  for (const addrs of Object.values(interfaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!addr || addr.internal) continue;
      const family = addr.family;
      if (family !== 'IPv4' && family !== 4) continue;
      const local = ipv4ToInt(addr.address);
      const mask = maskFromInterface(addr);
      if (local == null || mask == null || mask === 0) continue;
      if ((local >>> 24) === 127) continue;
      if ((local & mask) === (target & mask)) return true;
    }
  }
  return false;
}

/**
 * LAN probe timeout while this computer is not on that URL's subnet.
 * Other failures, and a timeout while an interface is on the subnet, stay generic.
 */
export function lanProbeErrorHe(url, err, interfaces) {
  const base = hebrewTransportError(err);
  if (base !== LAN_TIMEOUT_HE) return base;
  if (classifyCompanionUrl(url) !== 'lan') return base;
  const host = companionUrlHost(url);
  if (ipv4ToInt(String(host).replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')) == null) return base;
  let ifaces = interfaces;
  if (ifaces === undefined) {
    try { ifaces = os.networkInterfaces(); } catch { return base; }
  }
  if (ifaces == null) return base;
  if (hostSharesSubnet(host, ifaces)) return base;
  return HOME_LAN_ABSENT_HE;
}

export function transportCardId(transport) {
  if (transport === 'lan') return 'home';
  if (transport === 'tailscale') return 'cellular';
  return null;
}

export function isLocalSerialRadio(live) {
  if (!live || typeof live !== 'object') return false;
  const type = String(live.type || '').toLowerCase();
  if (type !== 'serial') return false;
  const port = live.serialPort || live.serial_port || live.path || '';
  return String(port).trim().length > 0;
}

export function isCompanionRelayLive(live, { viaRelay = false } = {}) {
  if (viaRelay === true) return true;
  if (!live || typeof live !== 'object') return false;
  if (live.via === 'relay' || live.relay === true) return true;
  if (String(live.type || '').toLowerCase() !== 'tcp') return false;
  if (Number(live.port) !== RELAY_PORT) return false;
  const kind = classifyCompanionHost(live.host);
  return kind === 'lan' || kind === 'tailscale';
}

export function relayHeartbeatFresh(live, maxMs = RELAY_FRESH_MS) {
  if (!live || live.connected !== true) return false;
  if (Number(live.heartbeatCount) <= 0) return false;
  const age = Number(live.lastHeartbeatAgeMs);
  return Number.isFinite(age) && age >= 0 && age <= maxMs;
}

/** Operator-facing reason. Never returns a raw English fetch error. */
export function hebrewTransportError(err) {
  const raw = String(err?.message || err || '').trim();
  const name = String(err?.name || '');
  if (/[\u0590-\u05FF]/.test(raw) && !/failed to fetch|networkerror|typeerror/i.test(raw)) {
    return raw;
  }
  if (/abort|timeout|timed out/i.test(`${name} ${raw}`)) return 'הכתובת לא הגיבה בזמן';
  return 'אין הגעה לכתובת';
}

export function hebrewUiError(err) {
  const raw = String(err?.message || err || '').trim();
  if (!raw) return 'הפעולה נכשלה';
  if (/[\u0590-\u05FF]/.test(raw) && !/failed to fetch|networkerror|typeerror/i.test(raw)) {
    return raw;
  }
  if (/abort|timeout|timed out/i.test(raw)) return 'הפעולה ארכה יותר מדי';
  if (/failed to fetch|networkerror|load failed|network request failed|typeerror/i.test(raw)) {
    return 'אין קשר לשרת הקונסולה';
  }
  return 'הפעולה נכשלה';
}

export function probesByCard(probes) {
  const list = Array.isArray(probes)
    ? probes
    : (probes && Array.isArray(probes.paths) ? probes.paths : []);
  return {
    home: list.find((p) => p && (p.id === 'home' || p.transport === 'lan')) || null,
    cellular: list.find((p) => p && (p.id === 'cellular' || p.transport === 'tailscale')) || null,
  };
}

/** LAN wins when it answered. Otherwise the first Tailscale path that answered. */
export function pickActiveCompanionProbe(probes) {
  const list = (Array.isArray(probes) ? probes : (probes?.paths || [])).filter((p) => p && p.ok && p.url);
  return list.find((p) => p.transport === 'lan')
    || list.find((p) => p.transport === 'tailscale')
    || list[0]
    || null;
}

/**
 * Modem line from a companion modem or uplink object.
 * Unknown stays null — never a made-up "no modem".
 */
export function modemSubstatusHe(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  const state = String(report.state || report.reason || '').toLowerCase();
  const absent = report.present === false || state === 'modem_absent' || state === 'absent';
  const present = !absent && (
    report.present === true
    || report.up === true
    || state === 'registered'
    || state === 'connected'
    || state === 'up'
    || state === 'ready'
  );
  if (present) {
    const he = report.reasonHe || report.status_he || report.statusHe;
    if (typeof he === 'string' && /[\u0590-\u05FF]/.test(he)) return he.trim();
    return 'המודם במחשב המשימה פעיל';
  }
  if (absent) return 'מודם לא מחובר';
  return null;
}

const RADIO_DOWN = Object.freeze({
  state: 'off',
  tone: 'off',
  connected: false,
  sessionOpen: false,
  statusHe: 'לא מחובר',
});

const PATH_UP = Object.freeze({
  state: 'connected',
  tone: 'ok',
  connected: true,
  sessionOpen: true,
  statusHe: 'מחובר',
});

const PATH_DOWN = Object.freeze({
  state: 'error',
  tone: 'bad',
  connected: false,
  sessionOpen: false,
  statusHe: 'לא מגיב',
});

function finiteRtt(probe) {
  if (!probe || probe.ok !== true) return null;
  const n = Number(probe.rttMs);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Move the relay off the radio card and onto the path that carries it.
 * Home and cellular stay independent: both may be up.
 */
export function attributeLinkCards({
  radioDisplay = null,
  cellDisplay = null,
  homeDisplay = null,
  radioLive = null,
  radioViaRelay = false,
  pathProbes = null,
  modemReport = null,
  activeId = null,
  homeEnabled = true,
  cellEnabled = true,
} = {}) {
  const relaySocket = isCompanionRelayLive(radioLive, { viaRelay: radioViaRelay === true });
  const relayKind = classifyCompanionHost(radioLive?.host);
  const relayFresh = relaySocket && relayHeartbeatFresh(radioLive);
  const cards = pathProbes ? probesByCard(pathProbes) : { home: null, cellular: null };
  const homeProbe = cards.home;
  const cellProbe = cards.cellular;
  const evidence = relaySocket || !!homeProbe || !!cellProbe || (modemReport && typeof modemReport === 'object');
  if (!evidence) {
    return {
      relaySocket: false,
      evidence: false,
      radioDisplay,
      cellDisplay,
      homeDisplay,
      activeId: null,
      homeErrorHe: null,
      cellErrorHe: null,
      cellHintHe: null,
      homeRttMs: null,
      cellRttMs: null,
    };
  }

  let radio = radioDisplay;
  let cell = cellDisplay;
  let home = homeDisplay;
  let homeErrorHe = null;
  let cellErrorHe = null;
  const modemHe = modemSubstatusHe(modemReport);

  if (relaySocket && !isLocalSerialRadio(radioLive)) {
    radio = { ...RADIO_DOWN };
  }

  if (homeEnabled !== false && (homeProbe || (relayFresh && relayKind === 'lan'))) {
    if (homeProbe?.ok || (relayFresh && relayKind === 'lan')) {
      home = { ...PATH_UP };
    } else if (homeProbe && homeProbe.ok !== true) {
      if (homeProbe.errorHe === HOME_LAN_ABSENT_HE) {
        home = { ...PATH_DOWN, statusHe: HOME_LAN_ABSENT_HE };
        homeErrorHe = '';
      } else {
        home = { ...PATH_DOWN };
        homeErrorHe = homeProbe.errorHe || 'אין הגעה לכתובת';
      }
    }
  }

  if (cellEnabled !== false && (cellProbe || (relayFresh && relayKind === 'tailscale'))) {
    if (cellProbe?.ok || (relayFresh && relayKind === 'tailscale')) {
      cell = { ...PATH_UP };
    } else if (cellProbe && cellProbe.ok !== true) {
      cell = { ...PATH_DOWN };
      cellErrorHe = cellProbe.errorHe || 'אין הגעה לכתובת';
    }
  }

  if (evidence && cell?.statusHe === 'אין מודם' && modemHe && modemHe !== 'מודם לא מחובר') {
    if (cell?.connected !== true) {
      cell = { state: 'off', tone: 'off', connected: false, sessionOpen: false, statusHe: 'מנותק' };
    }
  }

  const lanUp = homeProbe?.ok === true || (relayFresh && relayKind === 'lan');
  const cellUp = cellProbe?.ok === true || (relayFresh && relayKind === 'tailscale');
  let resolved = null;
  if (lanUp && home?.connected) resolved = 'home';
  else if (cellUp && cell?.connected) resolved = 'cellular';
  else if (activeId === 'home' && home?.connected) resolved = 'home';
  else if (activeId === 'cellular' && cell?.connected) resolved = 'cellular';

  return {
    relaySocket,
    evidence,
    radioDisplay: radio,
    cellDisplay: cell,
    homeDisplay: home,
    activeId: resolved,
    homeErrorHe,
    cellErrorHe,
    cellHintHe: modemHe,
    homeRttMs: finiteRtt(homeProbe),
    cellRttMs: finiteRtt(cellProbe),
  };
}
