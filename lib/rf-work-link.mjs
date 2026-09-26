/**
 * Which single link the console works on.
 * auto uses a companion HTTP URL when one answers, otherwise the RF serial radio.
 * RF is telemetry plus the existing command allowlist. No new commands.
 */

import { classifyCompanionUrl, transportCardId } from './link-attribution.mjs';

export const WORK_LINKS = Object.freeze(['auto', 'home', 'cellular', 'rf']);
export const RF_BAUD_DEFAULT = 57600;
export const RF_REDUCED_REASON_HE = 'במצב RF אין וידאו ואין גישה למחשב המשימה';

const PATH_LABEL_HE = Object.freeze({
  auto: 'אוטומטי',
  home: 'רשת בית',
  cellular: 'סלולר',
  rf: 'RF',
  none: 'אין נתיב',
});

export function parseWorkLink(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  return WORK_LINKS.includes(mode) ? mode : 'auto';
}

export function parseRfBaud(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1200 || n > 921600) return RF_BAUD_DEFAULT;
  return Math.round(n);
}

export function pathLabelHe(path) {
  return PATH_LABEL_HE[path] || PATH_LABEL_HE.none;
}

export function activePathLabelHe(path) {
  return `נתיב פעיל: ${pathLabelHe(path)}`;
}

/**
 * @param {{ id?: string, url?: string, ok?: boolean }[]} httpResults
 */
export function chooseWorkPath({ mode, httpResults, serialPort } = {}) {
  const selected = parseWorkLink(mode);
  const port = String(serialPort || '').trim();
  const rfReady = port.length > 0;
  if (selected === 'home' || selected === 'cellular') {
    return { mode: selected, path: selected, reduced: false, fallback: false, reasonHe: '' };
  }
  if (selected === 'rf') {
    return {
      mode: 'rf',
      path: 'rf',
      reduced: true,
      fallback: false,
      reasonHe: RF_REDUCED_REASON_HE,
      rfReady,
    };
  }
  const live = (Array.isArray(httpResults) ? httpResults : []).filter((row) => row && row.ok === true);
  const home = live.find((row) => row.id === 'home');
  const cellular = live.find((row) => row.id === 'cellular');
  const other = live.find((row) => row.id !== 'home' && row.id !== 'cellular');
  const winner = home || cellular || other;
  if (winner) {
    const path = winner.id === 'cellular' ? 'cellular' : 'home';
    return { mode: 'auto', path, reduced: false, fallback: false, reasonHe: '' };
  }
  if (rfReady) {
    return {
      mode: 'auto',
      path: 'rf',
      reduced: true,
      fallback: true,
      reasonHe: RF_REDUCED_REASON_HE,
      rfReady: true,
    };
  }
  return { mode: 'auto', path: 'none', reduced: false, fallback: false, reasonHe: '' };
}

export function planWorkLink({ mode, httpResults, serialPort } = {}) {
  const decision = chooseWorkPath({ mode, httpResults, serialPort });
  return {
    ...decision,
    connectSerial: decision.path === 'rf' && String(serialPort || '').trim().length > 0,
    disconnectSerial: decision.path !== 'rf',
  };
}

export async function probeHttpUrls(urls, fetchImpl) {
  const list = Array.isArray(urls) ? urls : [];
  const out = [];
  for (const url of list) {
    const raw = String(url || '').trim();
    if (!raw) continue;
    const id = transportCardId(classifyCompanionUrl(raw)) || 'other';
    let ok = false;
    try {
      const base = raw.endsWith('/') ? raw : `${raw}/`;
      const res = await fetchImpl(new URL('api/health', base).toString());
      ok = res?.ok === true;
    } catch {
      ok = false;
    }
    out.push({ url: raw, id, ok });
  }
  return out;
}
