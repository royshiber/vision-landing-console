import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';
import { closeCompanionHttpPools, jetsonFetch } from '../lib/jetson-socks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');
const TOKEN = 'keep-alive-test';
const RTT_MS = 120;

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

function spawnAgent(port) {
  return spawn('python3', [agentPath], {
    env: {
      ...process.env,
      VLC_HTTP_BIND: '127.0.0.1',
      VLC_HTTP_PORT: String(port),
      VLC_SKIP_RELAY: '1',
      VLC_CONSOLE_URL: 'http://127.0.0.1:1',
      VLC_FC_DEVICE: '/dev/null',
      VLC_CAMERA_DRY_RUN: '1',
      VLC_GIMBAL_POLL: '0',
      VLC_GIMBAL_CONTROL_ENABLED: '0',
      VLC_COMPANION_TOKEN: TOKEN,
      VLC_HTTP_IDLE_S: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitHttp(url) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 8000) {
    try {
      const res = await fetch(url, { headers: { 'X-Companion-Token': TOKEN } });
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw last || new Error(`timeout ${url}`);
}

function stopChild(child) {
  if (!child || child.killed) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 1500);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Lab handshake is ~0 ms. Charge one extra RTT on the first bytes of each
 * new TCP connection so a fresh socket costs ~2 RTT and a reused socket ~1.
 */
function startDelayProxy(targetPort, rttMs) {
  const half = rttMs / 2;
  const state = { connections: 0 };
  const server = net.createServer((client) => {
    state.connections += 1;
    client.setNoDelay(true);
    const upstream = net.connect(targetPort, '127.0.0.1');
    upstream.setNoDelay(true);
    const link = (from, to, chargeFirst) => {
      let first = chargeFirst;
      let queue = Promise.resolve();
      from.on('data', (chunk) => {
        const extra = first ? rttMs : 0;
        first = false;
        const copy = Buffer.from(chunk);
        const wait = half + extra;
        queue = queue.then(() => new Promise((resolve) => {
          setTimeout(() => {
            if (!to.destroyed) to.write(copy);
            resolve();
          }, wait);
        }));
      });
      from.on('error', () => to.destroy());
      from.on('end', () => {
        queue = queue.then(() => new Promise((resolve) => {
          setTimeout(() => {
            if (!to.destroyed && !to.writableEnded) to.end();
            resolve();
          }, half);
        }));
      });
    };
    link(client, upstream, true);
    link(upstream, client, false);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return {
    server,
    get connections() {
      return state.connections;
    },
  };
}

function startSocks5(targetPort) {
  const state = { tunnels: 0 };
  const server = net.createServer((socket) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (stage === 'pipe') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        buf = buf.subarray(2 + nmethods);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage !== 'request' || buf.length < 4) return;
      const atyp = buf[3];
      let offset = 4;
      if (atyp === 1) {
        if (buf.length < 10) return;
        offset = 8;
      } else if (atyp === 3) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        offset = 5 + len;
      } else {
        socket.destroy();
        return;
      }
      buf = buf.subarray(offset + 2);
      stage = 'pipe';
      state.tunnels += 1;
      socket.pause();
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (buf.length) upstream.write(buf);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    socket.on('error', () => {});
  });
  return {
    server,
    get tunnels() {
      return state.tunnels;
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('companion keep-alive pool', () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let companionPort = 0;

  beforeAll(async () => {
    companionPort = await freePort();
    child = spawnAgent(companionPort);
    await waitHttp(`http://127.0.0.1:${companionPort}/api/v1/health`);
  }, 15000);

  afterAll(async () => {
    closeCompanionHttpPools();
    await stopChild(child);
  });

  it('reuses one TCP connection and costs about one RTT after warmup', async () => {
    const proxy = startDelayProxy(companionPort, RTT_MS);
    const proxyPort = await listen(proxy.server);
    const base = `http://127.0.0.1:${proxyPort}`;
    const headers = { 'X-Companion-Token': TOKEN, Accept: 'application/json' };
    const samples = [];
    let liteBytes = 0;
    try {
      for (let i = 0; i < 6; i += 1) {
        const started = Date.now();
        const res = await jetsonFetch(`${base}/api/v1/status-lite`, { headers });
        const buf = Buffer.from(await res.arrayBuffer());
        samples.push(Date.now() - started);
        expect(res.status, buf.toString()).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(buf.length));
        expect((res.headers.get('connection') || '').toLowerCase()).toBe('keep-alive');
        const body = JSON.parse(buf.toString());
        expect(body.lite).toBe(true);
        expect(body.ok).toBe(true);
        liteBytes = buf.length;
      }
      expect(proxy.connections, `samples ${samples.join(',')}`).toBe(1);

      const client = createCompanionApiClient({
        baseUrl: base,
        timeoutMs: 4000,
        env: { VLC_COMPANION_TOKEN: TOKEN },
      });
      const viaClient = await client.getStatusLite();
      expect(viaClient.lite).toBe(true);
      expect(viaClient.api_version).toBe('1');
      expect(proxy.connections).toBe(1);

      const missing = await jetsonFetch(`${base}/api/v1/no-such-route`, { headers });
      const missingBuf = Buffer.from(await missing.arrayBuffer());
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-length')).toBe(String(missingBuf.length));
      expect(proxy.connections).toBe(1);

      const healthRes = await jetsonFetch(`${base}/api/health`, { headers });
      const healthBuf = Buffer.from(await healthRes.arrayBuffer());
      const health = JSON.parse(healthBuf.toString());
      expect(healthRes.headers.get('content-length')).toBe(String(healthBuf.length));
      expect(health.ok).toBe(true);
      expect(health.agentVersion).toBeTruthy();
      expect(health).toHaveProperty('cpuLoadPct');
      expect(health.fc).toBeTruthy();
      expect(health.vision).toBeTruthy();
      expect(health.lite).toBeUndefined();
      expect(healthBuf.length).toBeGreaterThan(8000);
      expect(liteBytes).toBeLessThan(4000);
      expect(liteBytes).toBeLessThan(healthBuf.length / 3);
      expect(proxy.connections).toBe(1);

      const rest = samples.slice(1);
      const typical = median(rest);
      expect(typical, `warmup ${samples[0]} rest ${rest.join(',')}`).toBeGreaterThan(RTT_MS * 0.55);
      expect(typical, `warmup ${samples[0]} rest ${rest.join(',')}`).toBeLessThan(RTT_MS * 1.65);
      expect(samples[0], `warmup ${samples[0]} typical ${typical}`).toBeGreaterThan(typical + RTT_MS * 0.35);

      const coldAgent = new http.Agent({ keepAlive: false });
      const cold = await new Promise((resolve, reject) => {
        const started = Date.now();
        const req = http.get(`${base}/api/v1/status-lite`, {
          agent: coldAgent,
          headers,
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(Date.now() - started));
        });
        req.on('error', reject);
      });
      coldAgent.destroy();
      expect(cold, `cold ${cold} typical ${typical}`).toBeGreaterThan(RTT_MS * 1.7);
      expect(typical).toBeLessThan(cold * 0.75);
      expect(proxy.connections).toBe(2);
    } finally {
      proxy.server.close();
      closeCompanionHttpPools();
    }
  }, 20000);

  it('reuses one SOCKS tunnel for sequential companion requests', async () => {
    const socks = startSocks5(companionPort);
    const socksPort = await listen(socks.server);
    const headers = { 'X-Companion-Token': TOKEN, Accept: 'application/json' };
    const url = `http://100.70.0.8:${companionPort}/api/v1/status-lite`;
    const env = { JETSON_COMPANION_SOCKS_PROXY: `socks5://127.0.0.1:${socksPort}` };
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await jetsonFetch(url, { headers }, { env });
        const buf = Buffer.from(await res.arrayBuffer());
        expect(res.status, buf.toString()).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(buf.length));
        expect(JSON.parse(buf.toString()).lite).toBe(true);
      }
      expect(socks.tunnels).toBe(1);
    } finally {
      socks.server.close();
      closeCompanionHttpPools();
    }
  }, 15000);

  it('keeps MJPEG streaming unbounded and closes that socket', async () => {
    const ac = new AbortController();
    const res = await jetsonFetch(
      `http://127.0.0.1:${companionPort}/api/v1/cam0/stream.mjpg`,
      { headers: { 'X-Companion-Token': TOKEN }, signal: ac.signal },
    );
    const ctype = String(res.headers.get('content-type') || '');
    try {
      if (ctype.includes('multipart')) {
        expect(res.headers.get('content-length')).toBeNull();
        expect((res.headers.get('connection') || '').toLowerCase()).toBe('close');
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        expect(res.headers.get('content-length')).toBe(String(buf.length));
      }
    } finally {
      ac.abort();
    }
  }, 10000);
});
