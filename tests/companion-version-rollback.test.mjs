import { describe, expect, it, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');
const unitPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'tests', 'test_version_rollback.py');
const children = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function seed(root) {
  const live = path.join(root, 'vlc-companion');
  const backup = path.join(root, 'vlc-companion.backups', '20260926T100000Z');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(live, 'marker.txt'), 'LIVE');
  fs.writeFileSync(path.join(backup, 'marker.txt'), 'OLD');
  fs.writeFileSync(path.join(live, 'airvix-deploy.json'), JSON.stringify({
    version: '2.6.0', deployed_at: '2026-09-26T12:00:00Z', git_sha: 'aaa', known_good: false,
  }));
  fs.writeFileSync(path.join(backup, 'airvix-deploy.json'), JSON.stringify({
    version: '2.5.0', deployed_at: '2026-09-26T10:00:00Z', git_sha: 'bbb', known_good: true, id: '20260926T100000Z',
  }));
  return { live, backup };
}

function heartbeatLauncher(mode) {
  const baseMode = mode === 'armed' ? 0x80 : 0;
  const systemStatus = mode === 'in_flight' ? 4 : 3;
  return `
import threading, time, runpy, sys
sys.path.insert(0, ${JSON.stringify(path.dirname(agentPath))})
import companion_agent as agent

def frame():
    payload = bytes([0, 0, 0, 0, 1, 3, ${baseMode}, ${systemStatus}, 3])
    body = bytes([len(payload), 1, 1, 1, 0]) + payload
    crc = agent.mav_crc(body + bytes([50]))
    return bytes([0xFE]) + body + bytes([crc & 0xFF, (crc >> 8) & 0xFF])

blob = frame()

def pump():
    while True:
        agent.observe_uart_bytes(blob)
        time.sleep(0.4)

threading.Thread(target=pump, daemon=True).start()
time.sleep(0.05)
runpy.run_path(${JSON.stringify(agentPath)}, run_name="__main__")
`;
}

function spawnAgent(port, root, extra, flight) {
  const child = spawn('python3', flight ? ['-c', heartbeatLauncher(flight)] : [agentPath], {
    env: {
      ...process.env,
      VLC_HTTP_BIND: '127.0.0.1',
      VLC_HTTP_PORT: String(port),
      VLC_SKIP_RELAY: '1',
      VLC_CONSOLE_URL: 'http://127.0.0.1:1',
      VLC_FC_DEVICE: '/dev/null',
      VLC_CAMERA_DRY_RUN: '1',
      VLC_GIMBAL_POLL: '0',
      VLC_COMPANION_TOKEN: 'versions-test',
      VLC_COMPANION_DEST: path.join(root, 'vlc-companion'),
      VLC_VERSIONS_INLINE: '1',
      VLC_VERSIONS_HEALTH_TIMEOUT_S: '0.2',
      VLC_VERSIONS_REFUSE: '0',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function waitHttp(port) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 8000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { 'X-Companion-Token': 'versions-test' },
      });
      if (res.ok) return;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw last || new Error('timeout');
}

async function postRollback(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/versions/rollback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Companion-Token': 'versions-test',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

afterEach(async () => {
  while (children.length) await stopChild(children.pop());
});

describe('companion version rollback endpoint', () => {
  it('runs the rollback unit tests', () => {
    const result = spawnSync('python3', [unitPath], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('lists backups and refuses rollback while armed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ver-'));
    seed(root);
    const log = path.join(root, 'restart.log');
    const port = await freePort();
    spawnAgent(port, root, { VLC_VERSIONS_RESTART_LOG: log, VLC_VERSIONS_HEALTH: 'ok' }, 'armed');
    await waitHttp(port);
    const listed = await fetch(`http://127.0.0.1:${port}/api/v1/versions`, {
      headers: { 'X-Companion-Token': 'versions-test' },
    });
    const body = await listed.json();
    expect(body.version).toBe('2.6.0');
    expect(body.backups[0].id).toBe('20260926T100000Z');
    expect(body.backups[0].version).toBe('2.5.0');
    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/versions/rollback`, { method: 'POST' });
    expect(denied.status).toBe(401);
    const rolled = await postRollback(port, { confirm: true, backup_id: '20260926T100000Z' });
    expect(rolled.status).toBe(409);
    expect(rolled.json.reason).toBe('armed');
    expect(fs.readFileSync(path.join(root, 'vlc-companion', 'marker.txt'), 'utf8')).toBe('LIVE');
    expect(fs.existsSync(log)).toBe(false);
  });

  it('restores the previous tree when the service does not become healthy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ver-'));
    seed(root);
    const log = path.join(root, 'restart.log');
    const port = await freePort();
    spawnAgent(port, root, { VLC_VERSIONS_RESTART_LOG: log, VLC_VERSIONS_HEALTH: 'fail' }, 'disarmed');
    await waitHttp(port);
    const rolled = await postRollback(port, { confirm: true, backup_id: '20260926T100000Z' });
    expect(rolled.status).toBe(200);
    expect(rolled.json.reverted).toBe(true);
    expect(rolled.json.from).toBe('2.6.0');
    expect(rolled.json.to).toBe('2.5.0');
    expect(fs.readFileSync(path.join(root, 'vlc-companion', 'marker.txt'), 'utf8')).toBe('LIVE');
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['restart', 'restart']);
  });
});
