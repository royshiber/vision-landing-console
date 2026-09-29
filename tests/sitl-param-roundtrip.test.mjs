/**
 * ArduPlane SITL param round-trip through the console.
 * Runs only when RUN_SITL_E2E=1 and an arduplane binary is available.
 * Writes stay on loopback or a local pty, and only after the link is a simulator.
 * No ARM, DISARM, LAND, or other flight commands.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BINARY = '/tmp/ardupilot/build/sitl/bin/arduplane';
const BINARY = process.env.ARDUPLANE_SITL || DEFAULT_BINARY;
const ENABLED = process.env.RUN_SITL_E2E === '1' && fs.existsSync(BINARY);
const HOME = '32.0853,34.7818,15,90';
const PREFERRED = ['SIM_WIND_SPD', 'SIM_WIND_DIR', 'SIM_BARO_DRIFT', 'SIM_ACC1_RND'];
const SKIP_PARAMS = new Set(['SIM_SPEEDUP']);

const children = [];

function track(child) {
  children.push(child);
  return child;
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}

afterAll(() => {
  for (const child of children) stopChild(child);
});

function tail(buf, max = 4000) {
  const text = buf.toString('utf8');
  return text.length > max ? text.slice(-max) : text;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, host, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${host}:${port} did not open`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last != null && last !== false) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)?.slice(0, 500)}`);
}

function startSitl(args, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const logs = { out: Buffer.alloc(0) };
  const child = track(spawn(BINARY, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: cwd },
  }));
  const push = (chunk) => {
    logs.out = Buffer.concat([logs.out, chunk]).subarray(-12000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.logs = logs;
  return child;
}

function startConsole(port, dbPath) {
  const logs = { out: Buffer.alloc(0) };
  const child = track(spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_PATH: dbPath,
      COMPANION_MODE: 'off',
      JETSON_COMPANION_BASE_URL: '',
    },
  }));
  const push = (chunk) => {
    logs.out = Buffer.concat([logs.out, chunk]).subarray(-16000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.logs = logs;
  return child;
}

async function api(base, method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function assertSimulatorOnly(live) {
  expect(live?.simulator).toBe(true);
  if (live.type === 'tcp') {
    expect(live.host).toBe('127.0.0.1');
    expect(live.port).toBe(5760);
  } else if (live.type === 'udp') {
    expect(['0.0.0.0', '127.0.0.1']).toContain(live.host);
  } else if (live.type === 'serial') {
    expect(String(live.serialPort || '')).toMatch(/sitl-pty|\/dev\/pts\//);
  } else {
    throw new Error(`refusing param write on ${live.type}`);
  }
}

function pickSimParam(params) {
  for (const name of PREFERRED) {
    if (Object.prototype.hasOwnProperty.call(params, name) && !SKIP_PARAMS.has(name)) return name;
  }
  const found = Object.keys(params).find((key) => /^SIM_[A-Z0-9_]+$/.test(key) && !SKIP_PARAMS.has(key));
  return found || null;
}

async function roundTripThreeTimes(base, id) {
  const ready = await waitUntil(async () => {
    const { json } = await api(base, 'GET', `/api/connections/${id}/status`);
    const live = json?.connection?.liveStatus;
    if (!live?.simulator || live.armed !== false || !(Number(live.heartbeatCount) > 0)) return null;
    return live;
  }, 45000, 'simulator heartbeat disarmed');
  assertSimulatorOnly(ready);

  await api(base, 'POST', `/api/connections/${id}/request-params`);
  const params = await waitUntil(async () => {
    const { json } = await api(base, 'GET', `/api/connections/${id}/params`);
    const bag = json?.params || {};
    return pickSimParam(bag) ? bag : null;
  }, 40000, 'SIM_ params');
  const param = pickSimParam(params);
  expect(param).toBeTruthy();
  const original = Number(params[param]);
  expect(Number.isFinite(original)).toBe(true);

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const next = Number((original + cycle).toFixed(3));
    const wrote = await api(base, 'POST', '/api/param-center/param-set', { param, value: next });
    expect(wrote.status, `${param} write ${cycle} ${JSON.stringify(wrote.json)}`).toBe(200);
    expect(wrote.json.via).toBe('mavlink');
    expect(wrote.json.verified).toBe(true);
    const seen = await waitUntil(async () => {
      const { json } = await api(base, 'GET', `/api/connections/${id}/params`);
      const value = Number(json?.params?.[param]);
      return Math.abs(value - next) < 0.02 ? value : null;
    }, 8000, `${param} read-back ${cycle}`);
    expect(Math.abs(seen - next)).toBeLessThan(0.02);

    const restored = await api(base, 'POST', '/api/param-center/param-set', { param, value: original });
    expect(restored.status, `${param} restore ${cycle}`).toBe(200);
    expect(restored.json.via).toBe('mavlink');
    const back = await waitUntil(async () => {
      const { json } = await api(base, 'GET', `/api/connections/${id}/params`);
      const value = Number(json?.params?.[param]);
      return Math.abs(value - original) < 0.02 ? value : null;
    }, 8000, `${param} restore read ${cycle}`);
    expect(Math.abs(back - original)).toBeLessThan(0.02);
  }
}

async function connectRadio(base, body) {
  const result = await api(base, 'POST', '/api/links/connect', body);
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  expect(result.json.ok).toBe(true);
  expect(result.json.id).toBeTruthy();
  return result.json.id;
}

describe.skipIf(!ENABLED)('ArduPlane SITL param round-trip', () => {
  let base = '';
  let consoleProc = null;

  afterAll(async () => {
    stopChild(consoleProc);
    if (base) {
      await api(base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
    }
  });

  it('connects over SITL TCP 5760, writes a SIM_ param, reads it back, and restores it three times', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-sitl-tcp-${process.pid}.sqlite`);
    const sitlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-sitl-tcp-'));
    consoleProc = startConsole(port, dbPath);
    base = `http://127.0.0.1:${port}`;
    await waitUntil(async () => {
      try {
        const health = await api(base, 'GET', '/api/health');
        return health.status === 200 ? health.json : null;
      } catch {
        return null;
      }
    }, 20000, 'console health');

    const sitl = startSitl([
      '--model', 'plane',
      '--speedup', '1',
      '--home', HOME,
      '--serial0', 'tcp:5760',
      '-w',
    ], sitlDir);
    try {
      await waitForPort(5760, '127.0.0.1', 30000);
    } catch (err) {
      throw new Error(`${err.message}\n${tail(sitl.logs.out)}`);
    }
    const id = await connectRadio(base, {
      role: 'radio',
      type: 'tcp',
      host: '127.0.0.1',
      port: 5760,
      preset: 'simulator',
    });
    try {
      await roundTripThreeTimes(base, id);
    } catch (err) {
      throw new Error(`${err.message}\n${tail(sitl.logs.out)}\n${tail(consoleProc.logs.out)}`);
    } finally {
      await api(base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
      stopChild(sitl);
    }
  }, 180000);

  it('repeats the SIM_ round-trip on a virtual serial pair when socat can provide one', async () => {
    expect(base, 'TCP case must start the console first').toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    let socatPath = '';
    try {
      socatPath = fs.realpathSync('/usr/bin/socat');
    } catch {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-sitl-pty-'));
    const linkA = path.join(dir, 'sitl-pty-a');
    const linkB = path.join(dir, 'sitl-pty-b');
    const socat = track(spawn(socatPath, [
      '-d', '-d',
      `pty,raw,echo=0,link=${linkA}`,
      `pty,raw,echo=0,link=${linkB}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }));
    await waitUntil(async () => (fs.existsSync(linkA) && fs.existsSync(linkB) ? true : null), 5000, 'socat links');
    const sitlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-sitl-serial-'));
    const sitlPort = fs.realpathSync(linkA);
    const consolePort = fs.realpathSync(linkB);
    const sitl = startSitl([
      '--model', 'plane',
      '--speedup', '1',
      '--home', HOME,
      '--serial0', `uart:${sitlPort}`,
      '-w',
    ], sitlDir);
    await new Promise((r) => setTimeout(r, 1500));
    if (sitl.exitCode != null) {
      throw new Error(`SITL serial exited ${sitl.exitCode}\n${tail(sitl.logs.out)}`);
    }
    let id;
    try {
      id = await connectRadio(base, {
        role: 'radio',
        type: 'serial',
        serialPort: consolePort,
        baudRate: 57600,
      });
      await roundTripThreeTimes(base, id);
    } catch (err) {
      const message = `${err.message}\n${tail(sitl.logs.out)}`;
      if (/serial0|No such device|ECONN|not connected|timed out/i.test(message) && sitl.exitCode != null) {
        throw new Error(message);
      }
      throw new Error(message);
    } finally {
      await api(base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
      stopChild(sitl);
      stopChild(socat);
    }
  }, 180000);
});
