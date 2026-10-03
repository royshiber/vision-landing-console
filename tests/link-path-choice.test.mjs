import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';
import { summarizeCommLinks } from '../lib/comm-links.mjs';
import { applyWorkLink } from '../lib/dual-link-runtime.mjs';
import { HOME_LAN_ABSENT_HE } from '../lib/link-attribution.mjs';
import { openDatabase } from '../lib/db.mjs';

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

describe('communications path choice', () => {
  it('selecting each link changes the active path, and a down link stays selectable', async () => {
    let homeUp = true;
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/status/modem')) return jsonResponse({ present: true, state: 'registered' });
      if (u.startsWith(HOME)) {
        if (!homeUp) {
          throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        }
        return jsonResponse({ ok: true });
      }
      if (u.startsWith(CELL)) return jsonResponse({ ok: true });
      throw new Error('unexpected url');
    });
    const client = createCompanionApiClient({
      baseUrl: `${CELL}, ${HOME}`,
      fetchImpl,
      timeoutMs: 400,
      failoverTimeoutMs: 200,
      networkInterfaces: hotspot,
    });

    await client.selectWorkingBaseUrl();
    expect(client.baseUrl).toBe(HOME);

    client.setPathPreference('cellular');
    const cellular = await client.refreshCompanionPaths({ force: true });
    expect(cellular.activeUrl).toBe(CELL);
    expect(cellular.activeId).toBe('cellular');
    expect(cellular.linkUp).toBe(true);
    expect(client.baseUrl).toBe(CELL);

    client.setPathPreference('home');
    const home = await client.refreshCompanionPaths({ force: true });
    expect(home.activeUrl).toBe(HOME);
    expect(home.activeId).toBe('home');
    expect(home.linkUp).toBe(true);
    expect(client.baseUrl).toBe(HOME);

    homeUp = false;
    calls.length = 0;
    const down = await client.refreshCompanionPaths({ force: true });
    expect(down.preference).toBe('home');
    expect(down.activeUrl).toBe(HOME);
    expect(down.activeId).toBe('home');
    expect(down.linkUp).toBe(false);
    expect(down.reasonHe).toBe(HOME_LAN_ABSENT_HE);
    expect(client.baseUrl).toBe(HOME);
    expect(calls.some((u) => u.startsWith(CELL))).toBe(true);
    await expect(client.getHealth()).rejects.toThrow();
    expect(client.baseUrl).toBe(HOME);

    const links = summarizeCommLinks({
      preferredPath: 'home',
      pathProbes: down,
      modemPresent: true,
      uplinkControl: false,
      companion: { jetson: 'reachable', hint_he: 'מחשב משימה מחובר.' },
    });
    const homeRow = links.rows.find((row) => row.id === 'home');
    const cellRow = links.rows.find((row) => row.id === 'cellular');
    expect(homeRow.chosen).toBe(true);
    expect(homeRow.selectable).toBe(true);
    expect(homeRow.connected).toBe(false);
    expect(homeRow.active).toBe(false);
    expect(homeRow.statusHe).toBe(HOME_LAN_ABSENT_HE);
    expect(cellRow.selectable).toBe(true);
    expect(cellRow.chosen).toBe(false);
    expect(cellRow.active).toBe(false);

    client.setPathPreference('cellular');
    const back = await client.refreshCompanionPaths({ force: true });
    expect(back.activeUrl).toBe(CELL);
    expect(back.linkUp).toBe(true);
    expect(client.baseUrl).toBe(CELL);

    const tmpPath = path.join(os.tmpdir(), `vlc-path-choice-${Date.now()}.sqlite`);
    const db = openDatabase(tmpPath);
    try {
      const pickedHome = await applyWorkLink({ db, companionClient: client }, { mode: 'home' });
      expect(pickedHome.ok).toBe(true);
      expect(pickedHome.mode).toBe('home');
      expect(pickedHome.path).toBe('home');
      expect(pickedHome.linkUp).toBe(false);
      expect(pickedHome.reasonHe).toBe(HOME_LAN_ABSENT_HE);
      expect(pickedHome.activeUrl).toBe(HOME);
      expect(client.baseUrl).toBe(HOME);

      const pickedCell = await applyWorkLink({ db, companionClient: client }, { mode: 'cellular' });
      expect(pickedCell.ok).toBe(true);
      expect(pickedCell.mode).toBe('cellular');
      expect(pickedCell.path).toBe('cellular');
      expect(pickedCell.linkUp).toBe(true);
      expect(pickedCell.activeUrl).toBe(CELL);
      expect(client.baseUrl).toBe(CELL);
    } finally {
      db.close();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });
});
