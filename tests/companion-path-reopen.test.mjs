import { describe, expect, it, vi } from 'vitest';
import { createCompanionApiClient, CompanionApiError } from '../lib/companion-api-client.mjs';
import { hebrewCompanionError } from '../lib/companion-connection.mjs';
import {
  HOME_RECONNECT_HE,
  attributeLinkCards,
  resolveCompanionPathChoice,
} from '../lib/link-attribution.mjs';

const HOME = 'http://192.168.1.122:8081';
const CELL = 'http://100.82.59.45:8081';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const hotspot = {
  bridge100: [{ address: '172.20.10.4', netmask: '255.255.255.240', family: 'IPv4', internal: false }],
};

function clientFor({ homeUp = true, cellUp = false } = {}) {
  const fetchImpl = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/status/modem')) return jsonResponse({ present: false, state: 'modem_absent' });
    if (u.startsWith(HOME)) {
      if (!homeUp) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      return jsonResponse({ ok: true });
    }
    if (u.startsWith(CELL)) {
      if (!cellUp) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      return jsonResponse({ ok: true });
    }
    if (u.includes('/api/v1/health') || u.endsWith('/health')) return jsonResponse({ ok: true });
    throw new Error(`unexpected url ${u}`);
  });
  return createCompanionApiClient({
    baseUrl: `${CELL}, ${HOME}`,
    fetchImpl,
    timeoutMs: 400,
    failoverTimeoutMs: 200,
    networkInterfaces: hotspot,
  });
}

describe('closed companion path is not left unused', () => {
  it('reopens the only healthy closed home path and does not report a missing URL', async () => {
    const client = clientFor({ homeUp: true, cellUp: false });
    client.setPathPreference('auto');
    client.setPathSession({ home: false, cellular: true });
    const snap = await client.refreshCompanionPaths({ force: true });
    expect(snap.reopened).toBe('home');
    expect(snap.linkUp).toBe(true);
    expect(snap.activeUrl).toBe(HOME);
    expect(client.baseUrl).toBe(HOME);
    expect(snap.reasonHe).toBe('');
    const health = await client.getHealth();
    expect(health.ok).toBe(true);
    const choice = resolveCompanionPathChoice(snap.paths, 'auto', { home: false, cellular: true });
    expect(choice.reopened).toBe('home');
    expect(choice.active?.url).toBe(HOME);
  });

  it('asks to reconnect home when a healthy home path stays closed and is not the only path', async () => {
    const client = clientFor({ homeUp: true, cellUp: true });
    client.setPathPreference('auto');
    client.setPathSession({ home: false, cellular: false });
    const snap = await client.refreshCompanionPaths({ force: true });
    expect(snap.reopened).toBeNull();
    expect(snap.activeUrl).toBeNull();
    expect(snap.reasonHe).toBe(HOME_RECONNECT_HE);
    await expect(client.getHealth()).rejects.toMatchObject({
      kind: 'connection',
      message: HOME_RECONNECT_HE,
    });
    try {
      await client.getHealth();
    } catch (err) {
      expect(err).toBeInstanceOf(CompanionApiError);
      expect(err.kind).not.toBe('config');
      expect(String(err.message)).not.toContain('JETSON_COMPANION_BASE_URL');
      expect(hebrewCompanionError(err)).toBe(HOME_RECONNECT_HE);
    }
  });

  it('keeps a pinned cellular choice from falling over onto home', async () => {
    const client = clientFor({ homeUp: true, cellUp: false });
    client.setPathPreference('cellular');
    client.setPathSession({ home: true, cellular: true });
    const snap = await client.refreshCompanionPaths({ force: true });
    expect(snap.reopened).toBeNull();
    expect(snap.activeId).toBe('cellular');
    expect(snap.linkUp).toBe(false);
    expect(snap.activeUrl).toBe(CELL);
    expect(client.baseUrl).toBe(CELL);
  });

  it('labels the sole healthy closed card as up, and a closed home beside another path as reconnect', () => {
    const probes = [
      { id: 'home', transport: 'lan', url: HOME, ok: true, rttMs: 29, status: 200 },
      { id: 'cellular', transport: 'tailscale', url: CELL, ok: false, errorHe: 'אין הגעה לכתובת' },
    ];
    const sole = attributeLinkCards({
      pathProbes: probes,
      pathSession: { home: false, cellular: true },
      preferredPath: 'auto',
    });
    expect(sole.homeDisplay.statusHe).not.toBe('מנותק');
    expect(sole.homeDisplay.connected).toBe(true);
    expect(sole.activeId).toBe('home');

    const both = attributeLinkCards({
      pathProbes: [
        probes[0],
        { id: 'cellular', transport: 'tailscale', url: CELL, ok: true, rttMs: 40, status: 200 },
      ],
      pathSession: { home: false, cellular: false },
      preferredPath: 'auto',
    });
    expect(both.homeDisplay.statusHe).toBe('מנותק');
    expect(both.homeErrorHe).toBe(HOME_RECONNECT_HE);
    expect(both.activeId).toBeNull();
  });

  it('still reports a config error when no companion URL is configured', async () => {
    const client = createCompanionApiClient({
      baseUrl: '',
      fetchImpl: vi.fn(),
      timeoutMs: 200,
    });
    await expect(client.getHealth()).rejects.toMatchObject({
      kind: 'config',
      message: 'JETSON_COMPANION_BASE_URL is not set',
    });
  });
});
