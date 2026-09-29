/**
 * Live ArduPlane SITL follow-target.
 * Runs only when RUN_SITL_E2E=1 and an arduplane binary is present.
 * The harness arms and takeoffs on localhost SITL. GUIDED and RTL come only
 * from the follow-target flow. Nothing here is a console flight-command route.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArmDisarmPayload } from '../lib/arm-disarm.mjs';
import {
  MAV_PARAM_TYPE,
  buildMavlink2Frame,
  buildParamSetPayload,
  buildSetModePayload,
  parseGlobalPositionInt,
  parseHeartbeat,
  parseMavlinkStream,
} from '../lib/mavlink-connection.mjs';
import { bearingDeg, destinationPoint, distanceM } from '../lib/follow-target.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.env.ARDUPLANE_SITL || '/tmp/ardupilot/build/sitl/bin/arduplane';
const ENABLED = process.env.RUN_SITL_E2E === '1' && fs.existsSync(BINARY);
const HOME = '32.0853,34.7818,15,90';
const SPEEDUP = '10';
const ORBIT_M = 150;
const MIN_AGL_M = 60;

const children = [];
const timings = [];

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(buf, max = 4000) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
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
    await delay(250);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)?.slice(0, 700)}`);
}

function mark(name, started) {
  const ms = Date.now() - started;
  timings.push({ name, ms });
  console.log(`TIMING ${name} ${ms}`);
  return ms;
}

function startSitl(port, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const logs = { out: Buffer.alloc(0) };
  const child = track(spawn(BINARY, [
    '--model', 'plane',
    '--speedup', SPEEDUP,
    '--home', HOME,
    '--serial0', `tcp:${port}`,
    '-w',
  ], {
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
      FOLLOW_TARGET_SITL: '1',
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

function startBridge(upstreamPort) {
  const bridge = {
    mode: null,
    armed: null,
    gpi: null,
    home: null,
    guided: [],
    setModes: [],
    texts: [],
    target: null,
    seq: 1,
    inBuf: Buffer.alloc(0),
    outBuf: Buffer.alloc(0),
    client: null,
    aglSamples: [],
    floorOn: false,
    lowestAgl: null,
  };
  let upstream = null;
  const server = net.createServer((sock) => {
    bridge.client = sock;
    sock.on('data', (chunk) => {
      bridge.outBuf = Buffer.concat([bridge.outBuf, chunk]);
      const parsed = parseMavlinkStream(bridge.outBuf);
      bridge.outBuf = bridge.outBuf.subarray(parsed.consumed);
      for (const frame of parsed.frames) noteOutbound(bridge, frame);
      if (upstream && !upstream.destroyed) upstream.write(chunk);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (bridge.client === sock) bridge.client = null;
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      upstream = net.connect({ port: upstreamPort, host: '127.0.0.1' }, () => {
        bridge.port = server.address().port;
        bridge.inject = (buf) => {
          if (upstream && !upstream.destroyed) upstream.write(buf);
        };
        bridge.close = () => {
          server.close();
          upstream.destroy();
          bridge.client?.destroy();
        };
        resolve(bridge);
      });
      upstream.on('data', (chunk) => {
        bridge.inBuf = Buffer.concat([bridge.inBuf, chunk]);
        const parsed = parseMavlinkStream(bridge.inBuf);
        bridge.inBuf = bridge.inBuf.subarray(parsed.consumed);
        for (const frame of parsed.frames) noteInbound(bridge, frame);
        if (bridge.client && !bridge.client.destroyed) bridge.client.write(chunk);
      });
      upstream.on('error', (err) => {
        if (!bridge.port) reject(err);
      });
    });
  });
}

function noteInbound(bridge, frame) {
  if (frame.msgId === 0 && frame.compId === 1 && frame.sysId !== 255) {
    const hb = parseHeartbeat(frame.payload);
    if (hb && hb.autopilot !== 8) {
      bridge.mode = hb.customMode;
      bridge.armed = (hb.baseMode & 0x80) !== 0;
    }
  } else if (frame.msgId === 33 && frame.compId === 1) {
    const gpi = parseGlobalPositionInt(frame.payload);
    if (!gpi || gpi.relativeAltM == null) return;
    bridge.gpi = gpi;
    const sample = {
      t: Date.now(),
      alt: gpi.relativeAltM,
      lat: gpi.lat,
      lon: gpi.lon,
      hdg: gpi.hdgDeg,
      mode: bridge.mode,
    };
    bridge.aglSamples.push(sample);
    if (bridge.floorOn && sample.mode !== 11) {
      if (bridge.lowestAgl == null || sample.alt < bridge.lowestAgl) bridge.lowestAgl = sample.alt;
    }
    } else if (frame.msgId === 65 && frame.compId === 1 && frame.payload.length >= 20) {
      bridge.rc = {
        ch5: frame.payload.readUInt16LE(4 + 8),
        ch6: frame.payload.readUInt16LE(4 + 10),
        ch7: frame.payload.readUInt16LE(4 + 12),
        ch8: frame.payload.readUInt16LE(4 + 14),
      };
    } else if (frame.msgId === 242 && frame.payload.length >= 8) {
    const lat = frame.payload.readInt32LE(0) / 1e7;
    const lon = frame.payload.readInt32LE(4) / 1e7;
    if (lat !== 0 || lon !== 0) bridge.home = { lat, lon };
  } else if (frame.msgId === 253) {
    const text = frame.payload.subarray(1).toString('utf8').replace(/\0/g, '').trim();
    if (text) bridge.texts.push(text);
    if (bridge.texts.length > 40) bridge.texts.shift();
  }
}

function noteOutbound(bridge, frame) {
  const now = Date.now();
  if (frame.msgId === 11 && frame.payload.length >= 4) {
    bridge.setModes.push({ t: now, mode: frame.payload.readUInt32LE(0) });
    return;
  }
  if (frame.msgId === 75 && frame.payload.length >= 30) {
    const command = frame.payload.readUInt16LE(28);
    if (command !== 192) return;
    bridge.guided.push({
      t: now,
      lat: frame.payload.readInt32LE(16) / 1e7,
      lon: frame.payload.readInt32LE(20) / 1e7,
      alt: frame.payload.readFloatLE(24),
      target: bridge.target ? { lat: bridge.target.lat, lon: bridge.target.lon } : null,
    });
  }
}

function heartbeatFrame(bridge) {
  const payload = Buffer.alloc(9);
  payload[4] = 6;
  payload[5] = 8;
  payload[7] = 4;
  payload[8] = 3;
  return buildMavlink2Frame(0, payload, bridge.seq++);
}

function setParam(bridge, name, value, type) {
  bridge.inject(buildMavlink2Frame(23, buildParamSetPayload(name, value, type, 1, 1), bridge.seq++));
}

function rcOverrideFrame(bridge, chan8) {
  const payload = Buffer.alloc(38);
  payload.writeUInt16LE(chan8, 14);
  payload[16] = 1;
  payload[17] = 1;
  return buildMavlink2Frame(70, payload, bridge.seq++);
}

async function armAndClimb(bridge) {
  const hb = setInterval(() => bridge.inject(heartbeatFrame(bridge)), 1000);
  await delay(1500);
  setParam(bridge, 'ARMING_SKIPCHK', -1, MAV_PARAM_TYPE.INT32);
  setParam(bridge, 'TKOFF_ALT', 100, MAV_PARAM_TYPE.INT16);
  setParam(bridge, 'WP_LOITER_RAD', 30, MAV_PARAM_TYPE.INT16);
  for (const name of ['INS_ACCOFFS_X', 'INS_ACCOFFS_Y', 'INS_ACCOFFS_Z', 'INS_ACC2OFFS_X', 'INS_ACC2OFFS_Y', 'INS_ACC2OFFS_Z']) {
    setParam(bridge, name, 0.001, MAV_PARAM_TYPE.REAL32);
  }
  await delay(600);
  bridge.inject(buildMavlink2Frame(11, buildSetModePayload(1, 13), bridge.seq++));
  await delay(300);
  bridge.inject(buildMavlink2Frame(76, buildArmDisarmPayload(1, 1, true), bridge.seq++));
  try {
    await waitUntil(
      () => (bridge.armed === true && bridge.gpi && bridge.gpi.relativeAltM >= 70 ? bridge.gpi : null),
      45000,
      'SITL climb',
    );
  } finally {
    clearInterval(hb);
  }
}

function targetNearAircraft(bridge) {
  const gpi = bridge.gpi;
  if (!gpi) return null;
  let lat = gpi.lat;
  let lon = gpi.lon;
  if (bridge.home) {
    const homeM = distanceM(bridge.home.lat, bridge.home.lon, lat, lon);
    if (homeM > 1500) {
      const pulled = destinationPoint(
        bridge.home.lat,
        bridge.home.lon,
        bearingDeg(bridge.home.lat, bridge.home.lon, lat, lon),
        800,
      );
      lat = pulled.lat;
      lon = pulled.lon;
    }
  }
  return { lat, lon };
}

function headingTravel(samples) {
  let travel = 0;
  let prev = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.hdg)) continue;
    if (prev != null) {
      let delta = sample.hdg - prev;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      travel += Math.abs(delta);
    }
    prev = sample.hdg;
  }
  return travel;
}

function orbitSamples(bridge, since) {
  const target = bridge.target;
  if (!target) return [];
  return bridge.aglSamples.filter((sample) => {
    if (sample.t < since || sample.mode !== 15) return false;
    const radius = distanceM(sample.lat, sample.lon, target.lat, target.lon);
    return radius >= 100 && radius <= 210;
  });
}

async function bootStack() {
  const started = Date.now();
  const stack = { sitl: null, bridge: null, consoleProc: null, base: '', started };
  const sitlPort = await freePort();
  const consolePort = await freePort();
  const dbPath = path.join(os.tmpdir(), `airvix-follow-sitl-${process.pid}-${consolePort}.sqlite`);
  const sitlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-follow-sitl-'));
  stack.sitl = startSitl(sitlPort, sitlDir);
  try {
    await waitForPort(sitlPort, '127.0.0.1', 30000);
    stack.bridge = await startBridge(sitlPort);
    stack.consoleProc = startConsole(consolePort, dbPath);
    stack.base = `http://127.0.0.1:${consolePort}`;
    await waitUntil(async () => {
      try {
        const health = await api(stack.base, 'GET', '/api/health');
        return health.status === 200 ? true : null;
      } catch {
        return null;
      }
    }, 20000, 'console health');
    const id = await api(stack.base, 'POST', '/api/links/connect', {
      role: 'radio',
      type: 'tcp',
      host: '127.0.0.1',
      port: stack.bridge.port,
    });
    if (id.status !== 200) throw new Error(`connect ${id.status} ${JSON.stringify(id.json)}`);
    stack.linkId = id.json.id;
    await waitUntil(async () => {
      const { json } = await api(stack.base, 'GET', `/api/connections/${stack.linkId}/status`);
      const live = json?.connection?.liveStatus;
      return Number(live?.heartbeatCount) > 0 ? live : null;
    }, 20000, 'heartbeat');
    await api(stack.base, 'POST', `/api/connections/${stack.linkId}/request-params`);
    mark('boot', started);
    return stack;
  } catch (err) {
    err.stackRun = stack;
    throw err;
  }
}

async function waitSimulator(stack) {
  await waitUntil(async () => {
    const { json } = await api(stack.base, 'GET', `/api/connections/${stack.linkId}/status`);
    const live = json?.connection?.liveStatus;
    return live?.simulator === true ? live : null;
  }, 40000, 'simulator identity');
}

async function stopStack(stack) {
  if (!stack) return;
  await api(stack.base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
  stack.bridge?.close?.();
  stopChild(stack.sitl);
  stopChild(stack.consoleProc);
}

describe.skipIf(!ENABLED)('live ArduPlane SITL follow-target', () => {
  it('orbits near 150 m, stays at or above 60 m AGL, then RTL about 60 s after target loss', async () => {
    const started = Date.now();
    let stack = null;
    try {
      stack = await bootStack();
      const { bridge, base } = stack;
      const climbStarted = Date.now();
      await armAndClimb(bridge);
      await waitSimulator(stack);
      mark('climb', climbStarted);
      bridge.floorOn = true;
      const initial = targetNearAircraft(bridge);
      expect(initial, 'aircraft position from GLOBAL_POSITION_INT').toBeTruthy();
      bridge.target = initial;
      const trackStarted = Date.now();
      let posted = null;
      await waitUntil(async () => {
        posted = await api(base, 'POST', '/api/follow-target/target', {
          lat: bridge.target.lat,
          lon: bridge.target.lon,
          altM: 90,
          source: 'map',
        });
        return posted.status === 200 && posted.json.state === 'tracking' ? posted.json : null;
      }, 20000, 'follow engage');
      await waitUntil(() => (bridge.mode === 15 && bridge.guided.length > 0 ? true : null), 20000, 'GUIDED mode');
      const guidedAlt = bridge.guided.map((row) => row.alt);
      expect(Math.min(...guidedAlt)).toBeGreaterThanOrEqual(MIN_AGL_M);
      mark('guided', trackStarted);

      let lastHold = 0;
      const orbit = await waitUntil(async () => {
        if (Date.now() - lastHold >= 1000) {
          lastHold = Date.now();
          await api(base, 'POST', '/api/follow-target/target', {
            lat: bridge.target.lat,
            lon: bridge.target.lon,
            altM: 90,
            source: 'map',
          });
        }
        const samples = orbitSamples(bridge, trackStarted);
        return headingTravel(samples) >= 80 && samples.length >= 5 ? samples : null;
      }, 50000, 'orbit');
      const moved = destinationPoint(bridge.target.lat, bridge.target.lon, 45, 120);
      bridge.target = moved;
      const moveStarted = Date.now();
      await api(base, 'POST', '/api/follow-target/target', {
        lat: moved.lat,
        lon: moved.lon,
        altM: 90,
        source: 'map',
      });
      let lastMovePost = 0;
      await waitUntil(async () => {
        if (Date.now() - lastMovePost >= 1000) {
          lastMovePost = Date.now();
          await api(base, 'POST', '/api/follow-target/target', {
            lat: bridge.target.lat,
            lon: bridge.target.lon,
            altM: 90,
            source: 'map',
          });
        }
        const samples = orbitSamples(bridge, moveStarted);
        return samples.length >= 3 ? samples : null;
      }, 30000, 'follow moving target');
      const lossStarted = Date.now();
      await waitUntil(() => (bridge.mode === 11 ? true : null), 80000, 'RTL mode');
      const lossMs = Date.now() - lossStarted;
      mark('rtl-after-loss', lossStarted);
      mark('orbit-case', started);
      const commandRadius = bridge.guided
        .filter((row) => row.target)
        .map((row) => distanceM(row.lat, row.lon, row.target.lat, row.target.lon));
      expect(commandRadius.some((radius) => Math.abs(radius - ORBIT_M) <= 15)).toBe(true);
      expect(headingTravel(orbit)).toBeGreaterThanOrEqual(80);
      expect(bridge.lowestAgl).toBeGreaterThanOrEqual(MIN_AGL_M);
      expect(lossMs).toBeGreaterThanOrEqual(55000);
      expect(lossMs).toBeLessThanOrEqual(75000);
      const rtlModes = bridge.setModes.filter((row) => row.mode === 11);
      expect(rtlModes.length).toBeGreaterThan(0);
      const status = await api(base, 'GET', '/api/follow-target/status');
      expect(status.json.state).toBe('rtl');
      console.log(`TIMING summary ${JSON.stringify(timings)}`);
    } catch (err) {
      const run = stack || err.stackRun;
      if (!stack && err.stackRun) stack = err.stackRun;
      const detail = run
        ? `\nmode=${run.bridge?.mode} alt=${run.bridge?.gpi?.relativeAltM} guided=${run.bridge?.guided?.length} lowest=${run.bridge?.lowestAgl}\n${(run.bridge?.texts || []).slice(-8).join(' | ')}\n${tail(run.sitl?.logs?.out)}\n${tail(run.consoleProc?.logs?.out)}`
        : '';
      throw new Error(`${err.message}${detail}`);
    } finally {
      await stopStack(stack || null);
    }
  }, 240000);

  it('cancels follow on an RC override mode change and sends no further GUIDED commands', async () => {
    const started = Date.now();
    let stack = null;
    try {
      stack = await bootStack();
      const { bridge, base } = stack;
      await armAndClimb(bridge);
      await waitSimulator(stack);
      const initial = targetNearAircraft(bridge);
      expect(initial).toBeTruthy();
      bridge.target = initial;
      await waitUntil(async () => {
        const posted = await api(base, 'POST', '/api/follow-target/target', {
          lat: bridge.target.lat,
          lon: bridge.target.lon,
          altM: 90,
          source: 'map',
        });
        return posted.status === 200 ? posted.json : null;
      }, 20000, 'follow engage');
      await waitUntil(
        () => (bridge.mode === 15 && bridge.guided.length > 0 ? true : null),
        20000,
        'GUIDED command',
      );
      const before = bridge.guided.length;
      const override = setInterval(() => bridge.inject(rcOverrideFrame(bridge, 1100)), 200);
      let cancelledAt = 0;
      try {
        await waitUntil(async () => {
          const status = await api(base, 'GET', '/api/follow-target/status');
          if (status.json.state !== 'cancelled' || bridge.mode === 15) return null;
          cancelledAt = Date.now();
          return status.json;
        }, 15000, 'RC cancel');
      } finally {
        clearInterval(override);
      }
      await delay(3000);
      const lateGuided = bridge.guided.filter((row) => row.t > cancelledAt + 1000);
      const lateMode = bridge.setModes.filter((row) => row.t > cancelledAt + 1000 && row.mode === 15);
      mark('rc-cancel', started);
      expect(before).toBeGreaterThan(0);
      expect(lateGuided).toEqual([]);
      expect(lateMode).toEqual([]);
      expect(bridge.mode).not.toBe(15);
      const status = await api(base, 'GET', '/api/follow-target/status');
      expect(status.json.state).toBe('cancelled');
      expect(status.json.messageHe).toMatch(/שלט RC/);
      console.log(`TIMING summary ${JSON.stringify(timings)}`);
    } catch (err) {
      const run = stack || err.stackRun;
      if (!stack && err.stackRun) stack = err.stackRun;
      const detail = run
        ? `\nmode=${run.bridge?.mode} rc=${JSON.stringify(run.bridge?.rc)} guided=${run.bridge?.guided?.length} modes=${JSON.stringify(run.bridge?.setModes?.slice(-6) || [])}\n${(run.bridge?.texts || []).slice(-8).join(' | ')}\n${tail(run.sitl?.logs?.out)}\n${tail(run.consoleProc?.logs?.out)}`
        : '';
      throw new Error(`${err.message}${detail}`);
    } finally {
      await stopStack(stack);
    }
  }, 180000);
});
