import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionMock } from '../lib/companion-mock.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('uplink control', () => {
  it('decodes mocked nmcli policy without calling NetworkManager', () => {
    const script = path.join(repoRoot, 'tests', 'companion_uplink_control_check.py');
    const result = spawnSync('python3', [script], { encoding: 'utf8' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/ok/);
  });

  it('mock refuses to disable a link that is not up', async () => {
    const mock = createCompanionMock();
    await expect(mock.setNetworkUplink('wifi', { enabled: false })).rejects.toMatchObject({
      status: 409,
      body: { reason: 'last_uplink' },
    });
    const snap = await mock.getNetworkUplinks();
    expect(snap.wifi.enabled).toBe(true);
    expect(snap.wifi.up).toBe(false);
    const enabled = await mock.setNetworkUplink('cellular', { enabled: true });
    expect(enabled.cellular.enabled).toBe(true);
    expect(enabled.cellular.up).toBe(false);
  });
});

describe('companion uplink HTTP', () => {
  let child;
  let base;
  let stateFile;
  let nmLog;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-http-'));
    stateFile = path.join(dir, 'uplinks.json');
    nmLog = path.join(dir, 'nm.log');
    const fake = path.join(dir, 'uplink-nm.sh');
    fs.writeFileSync(fake, '#!/bin/sh\necho "$1" >> "$NM_LOG"\nexit 0\n');
    fs.chmodSync(fake, 0o755);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('python3', [agentPath], {
      env: {
        ...process.env,
        VLC_HTTP_PORT: String(port),
        VLC_HTTP_BIND: '127.0.0.1',
        VLC_SKIP_RELAY: '1',
        VLC_UPLINK_BOOT: '0',
        VLC_UPLINK_NM: fake,
        VLC_UPLINK_REACH: '0',
        VLC_UPLINKS_STATE: stateFile,
        VLC_COMPANION_TOKEN: 'test-token',
        NM_LOG: nmLog,
        AIRVIX_E3372_STATUS_FILE: path.join(dir, 'missing.status'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const deadline = Date.now() + 8000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/health`, { headers: { 'X-Companion-Token': 'test-token' } });
        if (res.status === 200) {
          up = true;
          break;
        }
      } catch {
        // retry until the socket is open
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!up) {
      child.kill('SIGTERM');
      throw new Error(`companion did not start\n${stderr}`);
    }
  }, 15000);

  afterAll(async () => {
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  });

  it('requires the companion token and will not drop the only link', async () => {
    const denied = await fetch(`${base}/api/v1/network/uplinks/wifi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(denied.status).toBe(401);

    const bad = await fetch(`${base}/api/v1/network/uplinks/wifi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(bad.status).toBe(400);

    const blocked = await fetch(`${base}/api/v1/network/uplinks/cellular`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Companion-Token': 'test-token',
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.reason).toBe('last_uplink');
    expect(blockedBody.message).toBe('אי אפשר לכבות את הקישור האחרון');

    const turnedOn = await fetch(`${base}/api/v1/network/uplinks/wifi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Companion-Token': 'test-token',
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(turnedOn.status).toBe(200);
    const snap = await turnedOn.json();
    expect(snap.wifi.enabled).toBe(true);
    expect(snap.wifi.up).toBe(false);
    expect(snap.read_only).toBe(false);
    const log = fs.readFileSync(nmLog, 'utf8');
    expect(log).toContain('wifi-up');
    expect(log).not.toContain('cell-down');
    expect(log).not.toContain('wifi-down');
    const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(stored.wifi.enabled).toBe(true);
    expect(stored.cellular.enabled).toBe(true);
  });
});
