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

export const COMM_LINK_IDS = Object.freeze(['cellular', 'radio', 'home', 'rc']);

export const RC_FRESH_MS = 3000;

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

/**
 * Companion / modem signal if a finite trusted field is present.
 * Accepts CSQ 0–31, MAVLink-style RSSI 0–254, or an explicit 0–100 percent.
 * Does not convert dBm or invent capacity.
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
    if (q.known) return q;
  }
  if (obj.rssi != null && obj.rssi !== '') {
    const rssiQ = qualityFromMavlinkRssi(obj.rssi, sourceHe);
    if (rssiQ.known) return rssiQ;
  }
  if (obj.csq != null && obj.csq !== '') {
    const csq = Number(obj.csq);
    if (Number.isFinite(csq) && csq >= 0 && csq <= 31) {
      return qualityFromTrustedPercent((csq / 31) * 100, sourceHe);
    }
  }
  return { ...EMPTY_QUALITY };
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

export function snapshotRcLink(statuses = [], now = Date.now()) {
  const list = Array.isArray(statuses) ? statuses : [];
  const fresh = list.find((s) => {
    if (!s) return false;
    if (s.hasRcChannels === true) {
      return s.rcAgeMs == null || s.rcAgeMs < RC_FRESH_MS;
    }
    const age = s.lastRcAt ? now - Number(s.lastRcAt) : s.rcAgeMs;
    return s.lastRcChannels && Number.isFinite(age) && age < RC_FRESH_MS;
  });
  if (!fresh) {
    return {
      state: 'off',
      rssi: null,
      chancount: null,
      quality: { ...EMPTY_QUALITY },
    };
  }
  const rssi = fresh.rcRssi ?? fresh.lastRcChannels?.rssi ?? null;
  return {
    state: 'live',
    rssi,
    chancount: fresh.rcChancount ?? fresh.lastRcChannels?.chancount ?? null,
    quality: qualityFromMavlinkRssi(rssi, 'עוצמת אות שלט'),
  };
}

function linkUp(state) {
  const s = normalizeLinkState(state);
  return s === 'connected' || s === 'listening';
}

function homeState(companion) {
  const jetson = companion?.jetson;
  if (jetson === 'unreachable') return 'error';
  if (jetson === 'reachable' || jetson === 'mock') {
    return companion?.hasData === false ? 'empty' : 'connected';
  }
  return 'disconnected';
}

function fourPill({ dual, companion }) {
  if (dual?.pillLabelHe && (linkUp(dual.radio) || linkUp(dual.cellular))) {
    return dual.pillLabelHe;
  }
  if (companion?.hasData === false && (companion?.jetson === 'reachable' || companion?.jetson === 'mock')) {
    return 'מחובר · אין נתונים';
  }
  if (companion?.jetson === 'reachable' || companion?.jetson === 'mock') {
    return 'מחובר · רשת בית';
  }
  if (dual?.radio === 'listening' || dual?.cellular === 'listening') return dual.pillLabelHe || 'מאזין';
  if (dual?.radio === 'connecting' || dual?.cellular === 'connecting') return 'מתחבר';
  if (companion?.jetson === 'unreachable') return 'מחשב משימה לא מגיב';
  return dual?.pillLabelHe || 'מנותק';
}

function buildRow(id, extra) {
  const meta = COMM_LINK_META[id];
  const quality = extra.quality?.known ? extra.quality : { ...EMPTY_QUALITY };
  const connected = extra.connected === true;
  const action = meta.action;
  return {
    id,
    nameHe: meta.nameHe,
    hintHe: extra.hintHe || meta.hintHe,
    action,
    dataPlane: meta.dataPlane,
    commandPick: meta.commandPick,
    state: extra.state,
    connected,
    active: extra.active === true,
    quality,
    actionHe: action === 'status' ? 'סטטוס' : hebrewConnectAction(connected),
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
} = {}) {
  const dual = summarizeDualLink({ radio, cellular, preferred, modemPresent });
  const cellAbsent = dual.cellular === 'modem_absent' || modemPresent === false;
  const rcSnap = rc && typeof rc === 'object' && rc.quality
    ? rc
    : snapshotRcLink([]);
  const homeUp = companion?.jetson === 'reachable' || companion?.jetson === 'mock';

  const rows = [
    buildRow('cellular', {
      state: dual.cellular,
      connected: linkUp(dual.cellular),
      hintHe: cellAbsent ? 'מודם לא מחובר' : COMM_LINK_META.cellular.hintHe,
      quality: qualityFromCompanionSignal(cellularSignal, 'עוצמת אות מודם'),
      active: dual.active === 'cellular',
    }),
    buildRow('radio', {
      state: dual.radio,
      connected: linkUp(dual.radio),
      hintHe: dual.active === 'radio' && dual.radio === 'connected'
        ? 'הכל חוץ מווידאו · פעיל לפקודות'
        : COMM_LINK_META.radio.hintHe,
      quality: qualityFromCompanionSignal(radioSignal, 'עוצמת אות רדיו'),
      active: dual.active === 'radio',
    }),
    buildRow('home', {
      state: homeState(companion),
      connected: homeUp,
      hintHe: companion?.hint_he || COMM_LINK_META.home.hintHe,
      quality: { ...EMPTY_QUALITY },
      active: false,
    }),
    buildRow('rc', {
      state: rcSnap.state || 'off',
      connected: false,
      hintHe: rcSnap.state === 'live' ? COMM_LINK_META.rc.hintHe : 'אין ערוצי שלט',
      quality: rcSnap.quality || { ...EMPTY_QUALITY },
      active: false,
    }),
  ];

  return {
    rows,
    rc: rcSnap,
    canSelectActive: dual.canSelectActive,
    active: dual.active,
    pillLabelHe: fourPill({ dual, companion }),
    modemPresent: dual.modemPresent,
  };
}
