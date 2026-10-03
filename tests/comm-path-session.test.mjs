import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';
import { summarizeCommLinks } from '../lib/comm-links.mjs';
import { applyWorkLink, setConsolePathSession } from '../lib/dual-link-runtime.mjs';
import { HOME_LAN_ABSENT_HE } from '../lib/link-attribution.mjs';
import { openDatabase } from '../lib/db.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = 'http://192.168.1.122:8081';
const CELL = 'http://100.82.59.45:8081';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const homeLan = {
  eth0: [{ address: '192.168.1.40', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
};
const away = {
  bridge100: [{ address: '172.20.10.4', netmask: '255.255.255.240', family: 'IPv4', internal: false }],
};

function clientFor({ homeUp, cellUp, interfaces }) {
  const fetchImpl = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/status/modem')) return jsonResponse({ present: true, state: 'registered' });
    if (u.startsWith(HOME)) {
      if (!homeUp) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      return jsonResponse({ ok: true });
    }
    if (u.startsWith(CELL)) {
      if (!cellUp) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      return jsonResponse({ ok: true });
    }
    throw new Error('unexpected url');
  });
  return createCompanionApiClient({
    baseUrl: `${CELL}, ${HOME}`,
    fetchImpl,
    timeoutMs: 400,
    failoverTimeoutMs: 200,
    networkInterfaces: interfaces,
  });
}

describe('console path connect and disconnect', () => {
  it('disconnects cellular without touching Tailscale, and connects home on the home LAN', async () => {
    const runtime = fs.readFileSync(path.join(repoRoot, 'lib/dual-link-runtime.mjs'), 'utf8');
    const sessionFn = runtime.slice(runtime.indexOf('export async function setConsolePathSession'));
    const body = sessionFn.slice(0, sessionFn.indexOf('export function readWorkLink'));
    expect(body).not.toMatch(/tailscale set|netsh|nrpt|route add|spawn\(|execFile|execSync/i);
    expect(body).not.toMatch(/interface metric|default route/i);

    const client = clientFor({ homeUp: true, cellUp: true, interfaces: homeLan });
    const tmpPath = path.join(os.tmpdir(), `vlc-path-session-${Date.now()}.sqlite`);
    const db = openDatabase(tmpPath);
    const ctx = { db, companionClient: client };
    try {
      const pickedCell = await applyWorkLink(ctx, { mode: 'cellular' });
      expect(pickedCell.linkUp).toBe(true);
      expect(client.baseUrl).toBe(CELL);

      const cut = await setConsolePathSession(ctx, { role: 'cellular', connected: false });
      expect(cut.ok).toBe(true);
      expect(cut.connected).toBe(false);
      const afterCut = client.getPathSnapshot();
      expect(afterCut.activeUrl).toBe(HOME);
      expect(afterCut.activeId).toBe('home');
      const links = summarizeCommLinks({
        pathProbes: afterCut,
        pathSession: { cellular: false, home: true },
        preferredPath: 'auto',
        modemPresent: true,
        uplinkControl: false,
        companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר.' },
      });
      const cell = links.rows.find((row) => row.id === 'cellular');
      const home = links.rows.find((row) => row.id === 'home');
      expect(cell.statusHe).toBe('מנותק');
      expect(cell.actionHe).toBe('התחבר');
      expect(cell.connected).toBe(false);
      expect(home.statusHe).toBe('מחובר');
      expect(home.actionHe).toBe('התנתק');

      client.setPathSession({ cellular: false, home: false });
      const awayClient = clientFor({ homeUp: false, cellUp: true, interfaces: away });
      awayClient.setPathPreference('cellular');
      await awayClient.refreshCompanionPaths({ force: true });
      const refused = await setConsolePathSession(
        { db, companionClient: awayClient },
        { role: 'home', connected: true },
      );
      expect(refused.ok).toBe(false);
      expect(refused.messageHe).toBe(HOME_LAN_ABSENT_HE);
      expect(awayClient.baseUrl).toBe(CELL);

      const joined = await setConsolePathSession(ctx, { role: 'home', connected: true });
      expect(joined.ok).toBe(true);
      expect(client.baseUrl).toBe(HOME);
      const picked = client.getPathSnapshot();
      expect(picked.activeId).toBe('home');
      expect(picked.linkUp).toBe(true);

      const back = await applyWorkLink(ctx, { mode: 'cellular' });
      expect(back.ok).toBe(true);
      expect(back.path).toBe('cellular');
      expect(back.linkUp).toBe(true);
      expect(client.baseUrl).toBe(CELL);
    } finally {
      db.close();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });
});
