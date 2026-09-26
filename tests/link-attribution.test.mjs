import { describe, expect, it, vi } from 'vitest';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';
import { summarizeCommLinks } from '../lib/comm-links.mjs';
import { hebrewUiError } from '../lib/link-attribution.mjs';
import {
  HOME_LAN_ABSENT_HE,
  classifyCompanionUrl,
  hebrewTransportError,
  hostSharesSubnet,
  isLocalSerialRadio,
  lanProbeErrorHe,
  pickActiveCompanionProbe,
} from '../lib/link-attribution.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const lanRelay = {
  connected: true,
  type: 'tcp',
  host: '192.168.1.122',
  port: 5770,
  heartbeatCount: 12,
  lastHeartbeatAgeMs: 400,
  framesRx: 40,
};

describe('link attribution', () => {
  it('keeps a companion relay off the radio card and on the LAN path', () => {
    const snap = summarizeCommLinks({
      radioViaRelay: true,
      radioLive: lanRelay,
      modemPresent: false,
      companion: { jetson: 'unreachable', hint_he: 'מחשב משימה לא מגיב.' },
      modemReport: { present: true, state: 'registered' },
    });
    const radio = snap.rows.find((r) => r.id === 'radio');
    const home = snap.rows.find((r) => r.id === 'home');
    const cell = snap.rows.find((r) => r.id === 'cellular');
    expect(radio.connected).toBe(false);
    expect(radio.statusHe).toBe('לא מחובר');
    expect(radio.hintHe).not.toMatch(/ממסר/);
    expect(home.connected).toBe(true);
    expect(home.statusHe).toBe('מחובר');
    expect(home.hintHe).not.toMatch(/לא מגיב/);
    expect(cell.statusHe).not.toBe('אין מודם');
    expect(cell.hintHe).toBe('המודם במחשב המשימה פעיל');
    expect(cell.connected).toBe(false);
    expect(snap.pillLabelHe).toBe('מחובר · רשת בית');
    expect(home.quality.percent).toBeNull();
  });

  it('shows both paths, prefers LAN, and keeps measured latency only', () => {
    const snap = summarizeCommLinks({
      radioLive: lanRelay,
      radioViaRelay: true,
      modemPresent: true,
      modemReport: { present: true, rsrp: -88 },
      pathProbes: {
        paths: [
          { id: 'home', url: 'http://192.168.1.122:8081', transport: 'lan', ok: true, rttMs: 18, errorHe: null },
          { id: 'cellular', url: 'http://100.82.59.45:8081', transport: 'tailscale', ok: true, rttMs: 140, errorHe: null },
        ],
      },
      activeTransport: 'home',
      companion: { jetson: 'reachable', fc: 'heartbeat', fc_heartbeat: true },
    });
    const home = snap.rows.find((r) => r.id === 'home');
    const cell = snap.rows.find((r) => r.id === 'cellular');
    const radio = snap.rows.find((r) => r.id === 'radio');
    expect(home.connected).toBe(true);
    expect(cell.connected).toBe(true);
    expect(radio.connected).toBe(false);
    expect(home.quality.known).toBe(true);
    expect(home.quality.tooltipHe).toMatch(/18/);
    expect(cell.quality.known).toBe(true);
    expect(home.quality.percent).toBeNull();
    expect(cell.quality.percent).toBeNull();
    expect(snap.pillLabelHe).toBe('מחובר · רשת בית');
    expect(cell.hintHe).toMatch(/מודם|קליטה/);
  });

  it('fails the active chip over to Tailscale when LAN is down', () => {
    const snap = summarizeCommLinks({
      radioLive: {
        ...lanRelay,
        host: '100.82.59.45',
      },
      radioViaRelay: true,
      modemReport: { present: true },
      pathProbes: {
        activeId: 'cellular',
        paths: [
          { id: 'home', transport: 'lan', url: 'http://192.168.1.122:8081', ok: false, rttMs: null, errorHe: 'אין הגעה לכתובת' },
          { id: 'cellular', transport: 'tailscale', url: 'http://100.82.59.45:8081', ok: true, rttMs: 90, errorHe: null },
        ],
      },
      activeTransport: 'cellular',
      companion: { jetson: 'unreachable' },
    });
    const home = snap.rows.find((r) => r.id === 'home');
    const cell = snap.rows.find((r) => r.id === 'cellular');
    expect(home.connected).toBe(false);
    expect(home.statusHe).toBe('לא מגיב');
    expect(home.errorHe).toBe('אין הגעה לכתובת');
    expect(home.quality.known).toBe(false);
    expect(cell.connected).toBe(true);
    expect(cell.quality.tooltipHe).toMatch(/90/);
    expect(snap.pillLabelHe).toBe('מחובר · סלולר');
    expect(JSON.stringify(snap)).not.toMatch(/Failed to fetch/);
  });

  it('counts only a local serial radio as radio', () => {
    expect(isLocalSerialRadio({ type: 'serial', serialPort: 'COM4' })).toBe(true);
    expect(isLocalSerialRadio(lanRelay)).toBe(false);
    const serial = summarizeCommLinks({
      radioLive: {
        connected: true,
        type: 'serial',
        serialPort: 'COM4',
        heartbeatCount: 3,
        lastHeartbeatAgeMs: 200,
      },
      companion: { jetson: 'off' },
    });
    expect(serial.rows.find((r) => r.id === 'radio').connected).toBe(true);
    expect(serial.rows.find((r) => r.id === 'radio').statusHe).toBe('מחובר');
    expect(serial.pillLabelHe).toBe('מחובר · רדיו פעיל');
  });

  it('replaces a raw fetch error with Hebrew', () => {
    expect(hebrewUiError(new Error('Failed to fetch'))).toBe('אין קשר לשרת הקונסולה');
    expect(hebrewTransportError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('הכתובת לא הגיבה בזמן');
    expect(hebrewUiError(new Error('החיבור נכשל'))).toBe('החיבור נכשל');
    expect(hebrewUiError(new Error('Failed to fetch'))).not.toMatch(/Failed to fetch/);
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    expect(js).not.toMatch(/setRowMessage\([^)]*err\.message/);
    expect(js).toContain('אין קשר לשרת הקונסולה');
  });

  it('probes LAN and Tailscale independently and prefers the LAN that answers', async () => {
    expect(classifyCompanionUrl('http://192.168.1.122:8081')).toBe('lan');
    expect(classifyCompanionUrl('http://100.82.59.45:8081')).toBe('tailscale');
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/status/modem')) {
        return jsonResponse({ present: true, state: 'registered' });
      }
      if (u.startsWith('http://192.168.1.122:8081')) {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return jsonResponse({ ok: true }, 200);
      }
      return jsonResponse({ ok: false }, 401);
    });
    const client = createCompanionApiClient({
      baseUrl: 'http://100.82.59.45:8081, http://192.168.1.122:8081',
      fetchImpl,
      timeoutMs: 400,
      failoverTimeoutMs: 200,
    });
    const picked = await client.selectWorkingBaseUrl();
    const snap = client.getPathSnapshot();
    expect(picked).toBe('http://192.168.1.122:8081');
    expect(snap.activeId).toBe('home');
    expect(snap.paths).toHaveLength(2);
    expect(snap.paths.every((p) => p.ok === true)).toBe(true);
    expect(snap.paths.every((p) => Number.isFinite(p.rttMs) && p.rttMs >= 0)).toBe(true);
    expect(snap.modem).toMatchObject({ present: true, state: 'registered' });
    expect(pickActiveCompanionProbe(snap.paths).transport).toBe('lan');
    expect(calls.some((u) => u.startsWith('http://192.168.1.122:8081'))).toBe(true);
    expect(calls.some((u) => u.startsWith('http://100.82.59.45:8081'))).toBe(true);

    fetchImpl.mockImplementation(async (url) => {
      const u = String(url);
      if (u.startsWith('http://192.168.1.122:8081')) {
        throw new Error('Failed to fetch');
      }
      if (u.includes('/status/modem')) return jsonResponse({ present: true });
      return jsonResponse({ ok: true }, 200);
    });
    const next = await client.refreshCompanionPaths({ force: true });
    expect(next.activeUrl).toBe('http://100.82.59.45:8081');
    expect(next.activeId).toBe('cellular');
    const lan = next.paths.find((p) => p.transport === 'lan');
    expect(lan.ok).toBe(false);
    expect(lan.rttMs).toBeNull();
    expect(lan.errorHe).toBe('אין הגעה לכתובת');
    expect(lan.errorHe).not.toMatch(/Failed to fetch/);
  });

  const hotspot = {
    bridge100: [{ address: '172.20.10.4', netmask: '255.255.255.240', family: 'IPv4', internal: false }],
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  };
  const homeLan = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };

  it('reads host subnets from interface netmasks', () => {
    expect(hostSharesSubnet('192.168.1.122', hotspot)).toBe(false);
    expect(hostSharesSubnet('192.168.1.122', homeLan)).toBe(true);
    expect(hostSharesSubnet('172.20.10.2', hotspot)).toBe(true);
    expect(hostSharesSubnet('192.168.1.122', {
      eth0: [{ address: '192.168.1.50', cidr: '192.168.1.50/24', family: 'IPv4', internal: false }],
    })).toBe(true);
  });

  it('says the computer is off the home LAN when that URL times out off-subnet', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(lanProbeErrorHe('http://192.168.1.122:8081', abort, hotspot)).toBe(HOME_LAN_ABSENT_HE);
    expect(lanProbeErrorHe('http://192.168.1.122:8081', abort, homeLan)).toBe('הכתובת לא הגיבה בזמן');
    expect(lanProbeErrorHe('http://100.82.59.45:8081', abort, hotspot)).toBe('הכתובת לא הגיבה בזמן');
    expect(lanProbeErrorHe('http://192.168.1.122:8081', new Error('Failed to fetch'), hotspot)).toBe('אין הגעה לכתובת');

    const fetchImpl = vi.fn(async () => { throw abort; });
    const client = createCompanionApiClient({
      baseUrl: 'http://192.168.1.122:8081',
      fetchImpl,
      failoverTimeoutMs: 200,
      networkInterfaces: hotspot,
    });
    const snap = await client.refreshCompanionPaths({ force: true });
    const lan = snap.paths.find((p) => p.transport === 'lan');
    expect(lan.ok).toBe(false);
    expect(lan.errorHe).toBe(HOME_LAN_ABSENT_HE);
    const links = summarizeCommLinks({
      pathProbes: snap,
      companion: { jetson: 'unreachable' },
    });
    const home = links.rows.find((r) => r.id === 'home');
    expect(home.statusHe).toBe(HOME_LAN_ABSENT_HE);
    expect(home.errorHe).toBe('');
    expect(`${home.statusHe} ${home.errorHe}`).not.toMatch(/לא מגיב|הכתובת לא הגיבה בזמן/);

    const onSubnet = createCompanionApiClient({
      baseUrl: 'http://192.168.1.122:8081',
      fetchImpl,
      failoverTimeoutMs: 200,
      networkInterfaces: homeLan,
    });
    const stillThere = await onSubnet.refreshCompanionPaths({ force: true });
    const same = stillThere.paths.find((p) => p.transport === 'lan');
    expect(same.errorHe).toBe('הכתובת לא הגיבה בזמן');
    const sameLinks = summarizeCommLinks({
      pathProbes: stillThere,
      companion: { jetson: 'unreachable' },
    });
    const sameHome = sameLinks.rows.find((r) => r.id === 'home');
    expect(sameHome.statusHe).toBe('לא מגיב');
    expect(sameHome.errorHe).toBe('הכתובת לא הגיבה בזמן');
  });
});
