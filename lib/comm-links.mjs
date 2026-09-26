/**
 * Locked four-link communications model for the top-left widget + Mission strip.
 *
 * 1. סלולר — Jetson cellular MAVLink; full payload including video.
 * 2. רדיו טלמטריה — radio MAVLink; everything except video.
 * 3. רשת בית — Tailscale / Wi-Fi Companion path; full like cellular for home tests.
 * 4. RC — transmitter sticks → FC only; status/quality, never a data-plane connect.
 *
 * Quality bars stay visible. A percentage is shown only when a finite trusted
 * metric exists (modem CSQ / companion RSSI / RC_CHANNELS rssi 0–254).
 * Never invent bandwidth or Starlink-style utilization.
 */

import { summarizeDualLink, normalizeLinkState } from './dual-link.mjs';
import { getConfig, setConfig } from './db.mjs';
import { RELAY_FC_HEARTBEAT_FRESH_MS, relayFcHeartbeatFresh } from './companion-mavlink-relay.mjs';

export const COMM_LINK_IDS = Object.freeze(['cellular', 'radio', 'home', 'rc']);

export const RC_FRESH_MS = 3000;

/** Same 3s window as the relay. Older than this is not a live link. */
export const HEARTBEAT_LIVE_MS = RELAY_FC_HEARTBEAT_FRESH_MS;

export const NO_DATA_HE = 'אין נתונים';
export const DISABLED_HE = 'מושבת';
export const RELAY_HINT_HE = 'דרך מחשב משימה · ממסר';
export const CELLULAR_UPLINK_HINT_HE = 'ערוץ סלולרי במחשב המשימה';
export const UPLINK_CONSOLE_ONLY_HE =
  'ההגדרה נשמרה בקונסולה. מחשב המשימה עדיין לא תומך בכיבוי קישור מרחוק.';
export const UPLINK_UNSUPPORTED_HE = 'גרסת ה-Jetson לא תומכת בשליטה בערוץ';
export const UPLINK_LAST_LINK_HE = 'אי אפשר לנתק את הערוץ הפעיל האחרון';
export const UPLINK_REJECTED_HE = 'הפעולה נדחתה';

export const LINK_PREFS_KEY = 'commLinks.enabled';

export const COMM_LINK_META = Object.freeze({
  cellular: Object.freeze({
    id: 'cellular',
    nameHe: 'סלולר',
    hintHe: 'דרך מחשב משימה · מלא כולל וידאו',
    action: 'connect',
    dataPlane: true,
    commandPick: 'cellular',
  }),
  radio: Object.freeze({
    id: 'radio',
    nameHe: 'רדיו טלמטריה',
    hintHe: 'הכל חוץ מווידאו · גיבוי כשאין סלולר',
    action: 'connect',
    dataPlane: true,
    commandPick: 'radio',
  }),
  home: Object.freeze({
    id: 'home',
    nameHe: 'רשת בית',
    hintHe: 'רשת לבית · בדיקות מול מחשב משימה',
    action: 'connect',
    dataPlane: true,
    commandPick: null,
  }),
  rc: Object.freeze({
    id: 'rc',
    nameHe: 'RC',
    hintHe: 'שלט לבקר בלבד · בלי וידאו ובלי פרמטרים',
    action: 'status',
    dataPlane: false,
    commandPick: null,
  }),
});

export const EMPTY_QUALITY = Object.freeze({
  bars: 0,
  known: false,
  percent: null,
  sourceHe: null,
});

export function hebrewConnectAction(connected) {
  return connected ? 'התנתק' : 'התחבר';
}

export function commActionLabel(row) {
  if (!row || row.action === 'status' || row.id === 'rc') return 'סטטוס';
  return hebrewConnectAction(row.connected === true);
}

export function qualityFromTrustedPercent(percent, sourceHe = null) {
  if (percent == null || percent === '') return { ...EMPTY_QUALITY };
  const n = typeof percent === 'number' ? percent : Number(percent);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { ...EMPTY_QUALITY };
  }
  const p = Math.round(n);
  const bars = p <= 0 ? 0 : p <= 25 ? 1 : p <= 50 ? 2 : p <= 75 ? 3 : 4;
  return {
    bars,
    known: true,
    percent: p,
    sourceHe: sourceHe ? String(sourceHe) : null,
  };
}

/** MAVLink RSSI: 0–254 usable, 255 invalid/unknown. */
export function qualityFromMavlinkRssi(rssi, sourceHe = 'עוצמת אות') {
  if (rssi == null || rssi === 255) return { ...EMPTY_QUALITY };
  const n = Number(rssi);
  if (!Number.isFinite(n) || n < 0 || n > 254) return { ...EMPTY_QUALITY };
  return qualityFromTrustedPercent((n / 254) * 100, sourceHe);
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * RSRP dBm → bars.
 * ≥ -80 → 4, ≥ -90 → 3, ≥ -100 → 2, ≥ -110 → 1, else 0.
 */
export function barsFromRsrpDbm(dbm) {
  const n = finiteNumber(dbm);
  if (n == null) return null;
  if (n >= -80) return 4;
  if (n >= -90) return 3;
  if (n >= -100) return 2;
  if (n >= -110) return 1;
  return 0;
}

/**
 * RSSI dBm (negative), not MAVLink 0–254.
 * ≥ -65 → 4, ≥ -75 → 3, ≥ -85 → 2, ≥ -95 → 1, else 0.
 */
export function barsFromRssiDbm(dbm) {
  const n = finiteNumber(dbm);
  if (n == null) return null;
  if (n >= -65) return 4;
  if (n >= -75) return 3;
  if (n >= -85) return 2;
  if (n >= -95) return 1;
  return 0;
}

/** RSRQ dB. ≥ -10 → 4, ≥ -15 → 3, ≥ -20 → 2, ≥ -25 → 1, else 0. */
export function barsFromRsrqDb(db) {
  const n = finiteNumber(db);
  if (n == null) return null;
  if (n >= -10) return 4;
  if (n >= -15) return 3;
  if (n >= -20) return 2;
  if (n >= -25) return 1;
  return 0;
}

/** Modem icon bars, 0..signal_max (default 5), scaled onto the four UI bars. 5/5 → 4. */
export function barsFromSignalIcon(icon, max) {
  const n = finiteNumber(icon);
  if (n == null || n < 0) return null;
  const capRaw = finiteNumber(max);
  const cap = capRaw != null && capRaw > 0 ? capRaw : 5;
  const clamped = Math.min(n, cap);
  return Math.max(0, Math.min(4, Math.round((clamped / cap) * 4)));
}

export const MODEM_BARS_ONLY_HE = 'המודם לא מדווח ערכי דציבל, רק פסים';

const NETWORK_LABELS = Object.freeze({
  1: 'GSM',
  2: 'GPRS',
  3: 'EDGE',
  4: 'WCDMA',
  5: 'HSDPA',
  6: 'HSUPA',
  7: 'HSPA',
  8: 'TD-SCDMA',
  9: 'HSPA+',
  19: 'LTE',
  41: 'WCDMA',
  42: 'HSDPA',
  43: 'HSUPA',
  44: 'HSPA',
  45: 'HSPA+',
  46: 'DC-HSPA+',
  61: 'TD-SCDMA',
  62: 'TD-HSDPA',
  63: 'TD-HSUPA',
  64: 'TD-HSPA',
  65: 'TD-HSPA+',
  101: 'LTE',
  1011: 'LTE+',
});

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function networkLabelFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const direct = cleanText(raw.network_label ?? raw.networkLabel);
  if (direct) return direct;
  const code = raw.network_type ?? raw.networkType;
  if (code == null || code === '') return null;
  return NETWORK_LABELS[String(code).trim()] || null;
}

export function operatorNameFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const op = raw.operator;
  if (typeof op === 'string') return cleanText(op);
  if (op && typeof op === 'object') {
    return cleanText(op.short ?? op.short_name) || cleanText(op.full ?? op.full_name);
  }
  return cleanText(raw.operator_short) || cleanText(raw.operator_full);
}

function withRadioFacts(quality, raw) {
  const networkLabel = networkLabelFrom(raw);
  const operator = operatorNameFrom(raw);
  if (!networkLabel && !operator) return quality;
  return {
    ...quality,
    ...(networkLabel ? { networkLabel } : {}),
    ...(operator ? { operator } : {}),
  };
}

/** SINR dB. ≥ 20 → 4, ≥ 13 → 3, ≥ 0 → 2, ≥ -3 → 1, else 0. */
export function barsFromSinrDb(db) {
  const n = finiteNumber(db);
  if (n == null) return null;
  if (n >= 20) return 4;
  if (n >= 13) return 3;
  if (n >= 0) return 2;
  if (n >= -3) return 1;
  return 0;
}

function knownBars(bars, sourceHe, tooltipHe) {
  return {
    bars,
    known: true,
    percent: null,
    sourceHe,
    tooltipHe: tooltipHe || sourceHe,
  };
}

/** Heartbeat age → bars. Under 1s = 4, 2s = 3, 3s = 2, else 0. No invented percent. */
export function qualityFromHeartbeatAge(ageMs, { rateHz = null, sourceHe = 'לפי זמן דופק' } = {}) {
  const age = finiteNumber(ageMs);
  if (age == null || age < 0) return { ...EMPTY_QUALITY };
  let bars = 0;
  if (age < 1000) bars = 4;
  else if (age < 2000) bars = 3;
  else if (age <= HEARTBEAT_LIVE_MS) bars = 2;
  const rate = finiteNumber(rateHz);
  const rateHe = rate != null ? ` · ${rate} פעימות בשנייה` : '';
  return knownBars(bars, sourceHe, `${sourceHe} · ${Math.round(age)} מילישניות${rateHe}`);
}

/** Companion HTTP round-trip. ≤80ms = 4, ≤150 = 3, ≤300 = 2, ≤800 = 1, else 0. */
export function qualityFromHttpRtt(rttMs, sourceHe = 'לפי זמן תגובה') {
  const rtt = finiteNumber(rttMs);
  if (rtt == null || rtt < 0) return { ...EMPTY_QUALITY };
  let bars = 0;
  if (rtt <= 80) bars = 4;
  else if (rtt <= 150) bars = 3;
  else if (rtt <= 300) bars = 2;
  else if (rtt <= 800) bars = 1;
  return knownBars(bars, sourceHe, `${sourceHe} · ${Math.round(rtt)} מילישניות`);
}

/** Danger only for the disconnect action. Connect and status stay neutral. */
export function rowActionStyle(actionHe) {
  return actionHe === 'התנתק' ? 'danger' : 'neutral';
}

export function readLinkPrefs(db) {
  const fallback = { cellular: true, home: true, radio: true };
  if (!db) return { ...fallback };
  try {
    const raw = getConfig(db, LINK_PREFS_KEY, null);
    if (!raw || typeof raw !== 'object') return { ...fallback };
    return {
      cellular: raw.cellular !== false,
      home: raw.home !== false,
      radio: raw.radio !== false,
    };
  } catch {
    return { ...fallback };
  }
}

export function writeLinkPrefs(db, patch = {}) {
  const prev = readLinkPrefs(db);
  const next = {
    cellular: patch.cellular === true || patch.cellular === false ? patch.cellular : prev.cellular,
    home: patch.home === true || patch.home === false ? patch.home : prev.home,
    radio: patch.radio === true || patch.radio === false ? patch.radio : prev.radio,
  };
  if (db) {
    try { setConfig(db, LINK_PREFS_KEY, next); } catch { /* ignore */ }
  }
  return next;
}

/** 409 from POST /api/v1/network/uplinks. Prefer a Hebrew reason from the companion. */
export function uplinkRefusalHe(body) {
  const src = body && typeof body === 'object' ? body : {};
  const he = src.reason_he || src.message_he || src.messageHe || src.status_he || src.message;
  if (typeof he === 'string' && /[\u0590-\u05FF]/.test(he)) return he.trim();
  const blob = `${src.code || ''} ${src.error || ''} ${src.reason || ''} ${src.message || ''}`.toLowerCase();
  if (/last|active|session|only_link|sole/.test(blob)) return UPLINK_LAST_LINK_HE;
  return UPLINK_REJECTED_HE;
}

/** Jetson uplink row: enabled is the switch, up is the live iface. */
export function displayFromUplink(link) {
  if (!link || typeof link !== 'object') return null;
  if (link.enabled === false) {
    return {
      state: 'disabled',
      tone: 'off',
      connected: false,
      sessionOpen: false,
      statusHe: DISABLED_HE,
    };
  }
  if (link.up === true) {
    return {
      state: 'connected',
      tone: 'ok',
      connected: true,
      sessionOpen: true,
      statusHe: 'מחובר',
    };
  }
  if (link.enabled === true) {
    return {
      state: 'degraded',
      tone: 'wait',
      connected: false,
      sessionOpen: true,
      statusHe: 'לא עלה',
    };
  }
  return null;
}

export function uplinkControlFromCompanion(companion) {
  const health = companion?.health && typeof companion.health === 'object' ? companion.health : {};
  const overlay = companion?.overlay && typeof companion.overlay === 'object' ? companion.overlay : {};
  const overlayHealth = overlay.health && typeof overlay.health === 'object' ? overlay.health : {};
  const caps = health.capabilities || overlayHealth.capabilities || overlay.capabilities || companion?.capabilities;
  return !!(caps && caps.uplinkControl === true);
}

/**
 * Companion / modem signal if a finite trusted field is present.
 * Accepts RSRP/RSSI/RSRQ/SINR dBm, CSQ 0–31, MAVLink-style RSSI 0–254,
 * or an explicit 0–100 percent. dBm never becomes a fake percent.
 */
export function qualityFromCompanionSignal(raw, sourceHe = 'עוצמת אות מודם') {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!obj) return { ...EMPTY_QUALITY };
  const pctKeys = [
    'signal_quality_pct',
    'signalQualityPct',
    'signal_pct',
    'csq_pct',
    'quality_pct',
  ];
  for (const key of pctKeys) {
    if (obj[key] == null || obj[key] === '') continue;
    const q = qualityFromTrustedPercent(obj[key], sourceHe);
    if (q.known) return withRadioFacts(q, obj);
  }
  const rsrp = finiteNumber(obj.rsrp ?? obj.RSRP ?? obj.rsrp_dbm);
  const rssiDbm = finiteNumber(obj.rssi_dbm ?? obj.rssiDbm);
  const rsrq = finiteNumber(obj.rsrq ?? obj.RSRQ);
  const sinr = finiteNumber(obj.sinr ?? obj.SINR ?? obj.sinr_db);
  const extras = [];
  if (rsrq != null) extras.push(`איכות ${rsrq}`);
  if (sinr != null) extras.push(`יחס רעש ${sinr}`);
  const extra = extras.length ? ` · ${extras.join(' · ')}` : '';
  if (rsrp != null) {
    return withRadioFacts(knownBars(
      barsFromRsrpDbm(rsrp),
      'עוצמת קליטה',
      `עוצמת קליטה ${rsrp} דציבל${extra}`,
    ), obj);
  }
  if (rssiDbm != null) {
    return withRadioFacts(knownBars(
      barsFromRssiDbm(rssiDbm),
      'עוצמת קליטה',
      `עוצמת קליטה ${rssiDbm} דציבל${extra}`,
    ), obj);
  }
  if (obj.rssi != null && obj.rssi !== '') {
    const rssiN = finiteNumber(obj.rssi);
    if (rssiN != null && rssiN < 0) {
      return withRadioFacts(
        knownBars(barsFromRssiDbm(rssiN), 'עוצמת קליטה', `עוצמת קליטה ${rssiN} דציבל${extra}`),
        obj,
      );
    }
    const rssiQ = qualityFromMavlinkRssi(obj.rssi, sourceHe);
    if (rssiQ.known) return withRadioFacts(rssiQ, obj);
  }
  if (obj.csq != null && obj.csq !== '') {
    const csq = Number(obj.csq);
    if (Number.isFinite(csq) && csq >= 0 && csq <= 31) {
      return withRadioFacts(qualityFromTrustedPercent((csq / 31) * 100, sourceHe), obj);
    }
  }
  if (rsrq != null) {
    return withRadioFacts(knownBars(barsFromRsrqDb(rsrq), 'איכות קליטה', `איכות קליטה ${rsrq}`), obj);
  }
  if (sinr != null) {
    return withRadioFacts(knownBars(barsFromSinrDb(sinr), 'יחס רעש', `יחס רעש ${sinr}`), obj);
  }
  const iconBars = barsFromSignalIcon(
    obj.signal_icon ?? obj.signalIcon,
    obj.signal_max ?? obj.signalMax,
  );
  if (iconBars != null) {
    const iconN = finiteNumber(obj.signal_icon ?? obj.signalIcon);
    const maxRaw = finiteNumber(obj.signal_max ?? obj.signalMax);
    const cap = maxRaw != null && maxRaw > 0 ? maxRaw : 5;
    const shown = Math.min(iconN, cap);
    return withRadioFacts(knownBars(
      iconBars,
      'פסי מודם',
      `${MODEM_BARS_ONLY_HE} (${shown} מתוך ${cap})`,
    ), obj);
  }
  return withRadioFacts({ ...EMPTY_QUALITY }, obj);
}

export function extractCompanionSignal(companion) {
  if (!companion || typeof companion !== 'object') return null;
  const health = companion.health && typeof companion.health === 'object' ? companion.health : {};
  const overlay = companion.overlay && typeof companion.overlay === 'object' ? companion.overlay : companion;
  const system = overlay.system && typeof overlay.system === 'object' ? overlay.system : {};
  const candidates = [
    health.modem,
    health.cellular,
    health.signal,
    overlay.modem,
    overlay.cellular,
    overlay.signal,
    system.modem,
    companion.modem,
    companion.signal,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c;
  }
  return null;
}

function decodedRcChannels(status) {
  if (!status || typeof status !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(status, 'rcChannels')) return status.rcChannels;
  return status.lastRcChannels || null;
}

export function snapshotRcLink(statuses = [], now = Date.now()) {
  const list = Array.isArray(statuses) ? statuses : [];
  const fresh = list.find((s) => {
    if (!s) return false;
    if (Object.prototype.hasOwnProperty.call(s, 'rcChannels') && !s.rcChannels) return false;
    if (s.hasRcChannels === true) {
      return s.rcAgeMs == null || Number(s.rcAgeMs) < RC_FRESH_MS;
    }
    const channels = decodedRcChannels(s);
    if (!channels) return false;
    const age = s.rcAgeMs != null
      ? Number(s.rcAgeMs)
      : (s.lastRcAt ? now - Number(s.lastRcAt) : null);
    return Number.isFinite(age) && age >= 0 && age < RC_FRESH_MS;
  });
  if (!fresh) {
    return {
      state: 'off',
      rssi: null,
      chancount: null,
      quality: { ...EMPTY_QUALITY },
    };
  }
  const channels = decodedRcChannels(fresh);
  const rssi = channels?.rssi ?? fresh.rcRssi ?? null;
  return {
    state: 'live',
    rssi,
    chancount: channels?.chancount ?? fresh.rcChancount ?? null,
    quality: qualityFromMavlinkRssi(rssi, 'עוצמת אות שלט'),
  };
}

function disabledDisplay() {
  return {
    state: 'disabled',
    tone: 'off',
    connected: false,
    sessionOpen: false,
    statusHe: DISABLED_HE,
  };
}

/**
 * Live only when the console socket is up and the autopilot heartbeat is
 * inside the relay window. Frames alone, a listener, or a closed socket
 * are not connected — even if a cached age still looks fresh.
 */
export function deriveMavlinkDisplay(live, { disabled = false } = {}) {
  if (disabled) return disabledDisplay();
  if (!live || typeof live !== 'object') {
    return { state: 'off', tone: 'off', connected: false, sessionOpen: false, statusHe: 'מנותק' };
  }
  if (relayFcHeartbeatFresh(live)) {
    return { state: 'connected', tone: 'ok', connected: true, sessionOpen: true, statusHe: 'מחובר' };
  }
  const age = finiteNumber(live.lastHeartbeatAgeMs);
  const hb = Number(live.heartbeatCount) || 0;
  if (live.connected === true && hb > 0 && age != null && age > HEARTBEAT_LIVE_MS) {
    return { state: 'degraded', tone: 'wait', connected: false, sessionOpen: true, statusHe: 'דופק ישן' };
  }
  if (live.connected === true || live.listening === true) {
    return { state: 'listening', tone: 'wait', connected: false, sessionOpen: true, statusHe: 'ממתין' };
  }
  if (live.lastError) {
    return { state: 'error', tone: 'bad', connected: false, sessionOpen: false, statusHe: 'שגיאה' };
  }
  return { state: 'off', tone: 'off', connected: false, sessionOpen: false, statusHe: 'מנותק' };
}

/** String states from older callers. `listening` is not connected. */
export function deriveStateStringDisplay(state, { disabled = false } = {}) {
  if (disabled) return disabledDisplay();
  const s = normalizeLinkState(state);
  if (s === 'connected') {
    return { state: 'connected', tone: 'ok', connected: true, sessionOpen: true, statusHe: 'מחובר' };
  }
  if (s === 'listening' || s === 'connecting') {
    return {
      state: s === 'connecting' ? 'connecting' : 'listening',
      tone: 'wait',
      connected: false,
      sessionOpen: true,
      statusHe: s === 'connecting' ? 'מתחבר' : 'ממתין',
    };
  }
  if (s === 'error') {
    return { state: 'error', tone: 'bad', connected: false, sessionOpen: false, statusHe: 'שגיאה' };
  }
  if (s === 'modem_absent') {
    return { state: 'absent', tone: 'off', connected: false, sessionOpen: false, statusHe: 'אין מודם' };
  }
  return { state: 'off', tone: 'off', connected: false, sessionOpen: false, statusHe: 'מנותק' };
}

export function homeHealthAgeMs(companion, now = Date.now()) {
  if (!companion || typeof companion !== 'object') return null;
  const health = companion.health && typeof companion.health === 'object' ? companion.health : {};
  const explicit = finiteNumber(
    companion.healthAgeMs ?? companion.health_age_ms ?? health.age_ms ?? health.health_age_ms,
  );
  if (explicit != null && explicit >= 0) return explicit;
  const stamp = health.fetched_at || health.fetchedAt || companion.healthAt || companion.fetched_at;
  if (stamp) {
    const t = typeof stamp === 'number' ? stamp : Date.parse(String(stamp));
    if (Number.isFinite(t)) return Math.max(0, now - t);
  }
  return null;
}

function relayReportsFcDown(companion) {
  const relay = companion?.mavlinkRelay;
  if (!relay || typeof relay !== 'object') return false;
  if (relay.skipped === 'live_radio' || relay.skipped === 'mock') return false;
  return relay.heartbeat !== true;
}

/** Fresh companion health plus a live relay heartbeat is connected. Reachable without FC is degraded. */
export function deriveHomeDisplay(companion, { disabled = false, now = Date.now() } = {}) {
  if (disabled) return disabledDisplay();
  const jetson = companion?.jetson;
  if (jetson === 'unreachable') {
    return { state: 'error', tone: 'bad', connected: false, sessionOpen: true, statusHe: 'לא מגיב' };
  }
  if (jetson !== 'reachable' && jetson !== 'mock') {
    return { state: 'off', tone: 'off', connected: false, sessionOpen: false, statusHe: 'מנותק' };
  }
  const age = homeHealthAgeMs(companion, now);
  const fresh = age == null || age <= HEARTBEAT_LIVE_MS;
  const relayDown = relayReportsFcDown(companion);
  const fcLive = !relayDown && (companion?.fc === 'heartbeat' || companion?.fc_heartbeat === true);
  if (!fresh) {
    return { state: 'degraded', tone: 'wait', connected: false, sessionOpen: true, statusHe: 'תגובה ישנה' };
  }
  if (relayDown && companion?.mavlinkRelay?.error === 'heartbeat_stale') {
    return { state: 'degraded', tone: 'wait', connected: false, sessionOpen: true, statusHe: 'דופק ישן' };
  }
  if (!fcLive) {
    return { state: 'degraded', tone: 'wait', connected: false, sessionOpen: true, statusHe: 'אין נתוני בקר' };
  }
  return { state: 'connected', tone: 'ok', connected: true, sessionOpen: true, statusHe: 'מחובר' };
}

function pillFromDisplays({ radio, cellular, home, active }) {
  if (radio?.connected && cellular?.connected) {
    return active === 'cellular' ? 'שני קישורים · סלולר פעיל' : 'שני קישורים · רדיו פעיל';
  }
  if (cellular?.connected) return 'מחובר · סלולר פעיל';
  if (radio?.connected) return 'מחובר · רדיו פעיל';
  if (home?.connected) return 'מחובר · רשת בית';
  if (radio?.tone === 'wait' || cellular?.tone === 'wait' || home?.tone === 'wait') return 'ממתין';
  if (home?.state === 'error') return 'מחשב משימה לא מגיב';
  if (radio?.state === 'error' || cellular?.state === 'error') return 'שגיאה';
  return 'מנותק';
}

function pillDotFromDisplays({ radio, cellular, home }) {
  if (radio?.connected || cellular?.connected || home?.connected) return 'on';
  if (radio?.tone === 'wait' || cellular?.tone === 'wait' || home?.tone === 'wait') return 'warn';
  if (radio?.state === 'error' || cellular?.state === 'error' || home?.state === 'error') return 'err';
  return 'off';
}

function enabledPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return { cellular: true, home: true, radio: true };
  return {
    cellular: prefs.cellular !== false,
    home: prefs.home !== false,
    radio: prefs.radio !== false,
  };
}

function uplinkSignalQuality(link) {
  if (!link || typeof link !== 'object') return { ...EMPTY_QUALITY };
  const nested = link.signal && typeof link.signal === 'object' ? link.signal : {};
  const rssiDbm = finiteNumber(link.signal_dbm ?? link.rssi_dbm ?? nested.rssi_dbm);
  const rawRssi = link.rssi ?? nested.rssi;
  return qualityFromCompanionSignal({
    rsrp: link.rsrp ?? link.rsrp_dbm ?? nested.rsrp ?? nested.rsrp_dbm,
    rssi_dbm: rssiDbm,
    rssi: rssiDbm == null ? rawRssi : undefined,
    rsrq: link.rsrq ?? nested.rsrq,
    sinr: link.sinr ?? nested.sinr,
    signal_icon: link.signal_icon ?? nested.signal_icon,
    signal_max: link.signal_max ?? nested.signal_max,
    network_label: link.network_label ?? nested.network_label,
    network_type: link.network_type ?? nested.network_type,
    operator: link.operator ?? nested.operator,
  }, 'עוצמת קליטה');
}

function homeQuality(companion, homeRttMs) {
  const health = companion?.health && typeof companion.health === 'object' ? companion.health : {};
  const rtt = finiteNumber(
    homeRttMs ?? companion?.httpRttMs ?? health.http_rtt_ms ?? health.rtt_ms ?? health.latency_ms,
  );
  const fromRtt = qualityFromHttpRtt(rtt);
  if (fromRtt.known) return fromRtt;
  const age = finiteNumber(health.last_heartbeat_age_ms ?? companion?.fcHeartbeatAgeMs);
  const fromAge = qualityFromHeartbeatAge(age, { sourceHe: 'לפי זמן דופק' });
  if (fromAge.known) return fromAge;
  return { ...EMPTY_QUALITY };
}

function buildRow(id, extra) {
  const meta = COMM_LINK_META[id];
  const quality = extra.quality?.known ? extra.quality : { ...EMPTY_QUALITY };
  const connected = extra.connected === true;
  const action = meta.action;
  const actionOn = extra.actionOn === true;
  const actionHe = action === 'status' ? 'סטטוס' : hebrewConnectAction(actionOn);
  return {
    id,
    nameHe: meta.nameHe,
    hintHe: extra.hintHe || meta.hintHe,
    action,
    dataPlane: meta.dataPlane,
    commandPick: meta.commandPick,
    state: extra.state,
    tone: extra.tone || 'off',
    connected,
    sessionOpen: extra.sessionOpen === true,
    enabled: extra.enabled !== false,
    statusHe: extra.statusHe || (connected ? 'מחובר' : NO_DATA_HE),
    active: extra.active === true,
    quality,
    actionHe,
    actionStyle: action === 'status' ? 'neutral' : rowActionStyle(actionHe),
    uplinkControl: extra.uplinkControl === true,
  };
}

export function summarizeCommLinks({
  radio = 'disconnected',
  cellular = 'disconnected',
  preferred = 'radio',
  modemPresent = false,
  companion = null,
  rc = null,
  cellularSignal = null,
  radioSignal = null,
  radioLive = null,
  cellularLive = null,
  radioViaRelay = false,
  prefs = null,
  homeRttMs = null,
  uplinks = null,
  uplinkControl = false,
} = {}) {
  const dual = summarizeDualLink({ radio, cellular, preferred, modemPresent });
  const enabled = enabledPrefs(prefs);
  const cellAbsent = dual.cellular === 'modem_absent' || modemPresent === false;
  const rcSnap = rc && typeof rc === 'object' && rc.quality
    ? rc
    : snapshotRcLink([]);
  const cellSignal = qualityFromCompanionSignal(cellularSignal, 'עוצמת קליטה');
  const radioSig = qualityFromCompanionSignal(radioSignal, 'עוצמת קליטה');

  const radioDisplay = enabled.radio === false
    ? disabledDisplay()
    : (radioLive
      ? deriveMavlinkDisplay(radioLive)
      : deriveStateStringDisplay(dual.radio));

  let cellDisplay;
  if (enabled.cellular === false) cellDisplay = disabledDisplay();
  else if (cellAbsent) {
    cellDisplay = { state: 'absent', tone: 'off', connected: false, sessionOpen: false, statusHe: 'אין מודם' };
  } else if (cellularLive) cellDisplay = deriveMavlinkDisplay(cellularLive);
  else cellDisplay = deriveStateStringDisplay(dual.cellular === 'modem_absent' ? 'disconnected' : dual.cellular);

  if (enabled.cellular !== false && !cellAbsent && !cellDisplay.connected && cellSignal.known) {
    cellDisplay = {
      ...cellDisplay,
      state: cellDisplay.sessionOpen ? 'listening' : 'degraded',
      tone: 'wait',
      connected: false,
      statusHe: 'אות בלבד',
    };
  }

  const control = uplinkControl === true;
  const cellLink = uplinks?.cellular && typeof uplinks.cellular === 'object' ? uplinks.cellular : null;
  const wifiLink = uplinks?.wifi && typeof uplinks.wifi === 'object'
    ? uplinks.wifi
    : (uplinks?.home && typeof uplinks.home === 'object' ? uplinks.home : null);
  if (cellLink) {
    const fromCell = displayFromUplink(cellLink);
    if (fromCell) cellDisplay = fromCell;
  }
  let homeDisplay = deriveHomeDisplay(companion, { disabled: enabled.home === false });
  if (wifiLink) {
    const fromWifi = displayFromUplink(wifiLink);
    if (fromWifi) homeDisplay = fromWifi;
  }
  const cellUplinkQuality = uplinkSignalQuality(cellLink);
  const wifiQuality = uplinkSignalQuality(wifiLink);
  const cellBars = cellUplinkQuality.known
    ? cellUplinkQuality
    : (cellSignal.known ? cellSignal : null);
  const cellCaption = {
    networkLabel: cellUplinkQuality.networkLabel || cellSignal.networkLabel || null,
    operator: cellUplinkQuality.operator || cellSignal.operator || null,
  };
  const radioQuality = radioSig.known
    ? radioSig
    : qualityFromHeartbeatAge(radioLive?.lastHeartbeatAgeMs, {
      rateHz: radioLive?.heartbeatRateHz,
      sourceHe: 'לפי זמן דופק',
    });
  const cellLiveQuality = cellDisplay.connected
    ? qualityFromHeartbeatAge(cellularLive?.lastHeartbeatAgeMs, {
      rateHz: cellularLive?.heartbeatRateHz,
      sourceHe: 'לפי זמן דופק',
    })
    : { ...EMPTY_QUALITY };

  const radioHint = enabled.radio === false
    ? DISABLED_HE
    : (radioViaRelay
      ? RELAY_HINT_HE
      : (radioDisplay.connected && dual.active === 'radio'
        ? 'הכל חוץ מווידאו · פעיל לפקודות'
        : COMM_LINK_META.radio.hintHe));

  const displays = { radio: radioDisplay, cellular: cellDisplay, home: homeDisplay };
  const rows = [
    buildRow('cellular', {
      ...cellDisplay,
      enabled: cellLink ? cellLink.enabled !== false : enabled.cellular,
      uplinkControl: control,
      actionOn: control && cellDisplay.sessionOpen === true,
      hintHe: cellLink
        ? CELLULAR_UPLINK_HINT_HE
        : (cellAbsent
          ? 'מודם לא מחובר'
          : (enabled.cellular === false ? DISABLED_HE : CELLULAR_UPLINK_HINT_HE)),
      quality: {
        ...(cellBars || cellLiveQuality),
        ...(cellCaption.networkLabel ? { networkLabel: cellCaption.networkLabel } : {}),
        ...(cellCaption.operator ? { operator: cellCaption.operator } : {}),
      },
      active: dual.active === 'cellular' && cellDisplay.connected === true,
    }),
    buildRow('radio', {
      ...radioDisplay,
      enabled: enabled.radio,
      actionOn: enabled.radio !== false && radioDisplay.sessionOpen === true,
      hintHe: radioHint,
      quality: radioQuality,
      active: dual.active === 'radio' && radioDisplay.connected === true,
    }),
    buildRow('home', {
      ...homeDisplay,
      enabled: wifiLink ? wifiLink.enabled !== false : enabled.home,
      uplinkControl: control,
      actionOn: control && homeDisplay.sessionOpen === true,
      hintHe: wifiLink && wifiLink.enabled === false
        ? DISABLED_HE
        : (enabled.home === false && !wifiLink
          ? DISABLED_HE
          : (companion?.hint_he || COMM_LINK_META.home.hintHe)),
      quality: wifiQuality.known ? wifiQuality : homeQuality(companion, homeRttMs),
      active: false,
    }),
    buildRow('rc', {
      state: rcSnap.state || 'off',
      tone: rcSnap.state === 'live' ? 'ok' : 'off',
      connected: false,
      sessionOpen: false,
      actionOn: false,
      enabled: true,
      statusHe: rcSnap.state === 'live' ? 'חי' : NO_DATA_HE,
      hintHe: rcSnap.state === 'live' ? COMM_LINK_META.rc.hintHe : 'אין ערוצי שלט',
      quality: rcSnap.quality || { ...EMPTY_QUALITY },
      active: false,
    }),
  ];

  return {
    rows,
    rc: rcSnap,
    prefs: enabled,
    canSelectActive: dual.canSelectActive,
    active: dual.active,
    pillLabelHe: pillFromDisplays({ ...displays, active: dual.active }),
    pillDot: pillDotFromDisplays(displays),
    modemPresent: dual.modemPresent,
  };
}
