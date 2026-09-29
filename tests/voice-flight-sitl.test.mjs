/**
 * Hebrew transcript through the voice pipeline against ArduPlane SITL TCP 5760.
 * Skips unless RUN_SITL_E2E=1 and an arduplane binary exists.
 * Gemini and ElevenLabs are blanked so CI uses the mocks.
 * Sends stay on loopback. ARM is refused. No new flight commands.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.env.ARDUPLANE_SITL || '/tmp/ardupilot/build/sitl/bin/arduplane';
const ENABLED = process.env.RUN_SITL_E2E === '1' && fs.existsSync(BINARY);
const HOME = '32.0853,34.7818,15,90';
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

function tail(buf, max = 4000) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  return text.length > max ? text.slice(-max) : text;
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

describe.skipIf(!ENABLED)('voice flight against ArduPlane SITL', () => {
  it('changes mode from a Hebrew transcript and refuses a blocked command', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-voice-sitl-${process.pid}.sqlite`);
    const sitlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-voice-sitl-'));
    const logs = { out: Buffer.alloc(0) };
    const push = (chunk) => {
      logs.out = Buffer.concat([logs.out, chunk]).subarray(-16000);
    };
    const consoleProc = track(spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        GEMINI_API_KEY: '',
        ELEVENLABS_API_KEY: '',
      },
    }));
    consoleProc.stdout.on('data', push);
    consoleProc.stderr.on('data', push);
    const sitlLogs = { out: Buffer.alloc(0) };
    const sitl = track(spawn(BINARY, [
      '--model', 'plane',
      '--speedup', '1',
      '--home', HOME,
      '--serial0', 'tcp:5760',
      '-w',
    ], {
      cwd: sitlDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sitlDir },
    }));
    const sitlPush = (chunk) => {
      sitlLogs.out = Buffer.concat([sitlLogs.out, chunk]).subarray(-12000);
    };
    sitl.stdout.on('data', sitlPush);
    sitl.stderr.on('data', sitlPush);
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitUntil(async () => {
        try {
          const health = await api(base, 'GET', '/api/health');
          return health.status === 200 ? true : null;
        } catch {
          return null;
        }
      }, 20000, 'console health');
      await waitForPort(5760, '127.0.0.1', 30000);
      const connected = await api(base, 'POST', '/api/links/connect', {
        role: 'radio',
        type: 'tcp',
        host: '127.0.0.1',
        port: 5760,
        preset: 'simulator',
      });
      expect(connected.status, JSON.stringify(connected.json)).toBe(200);
      const id = connected.json.id;
      const live = await waitUntil(async () => {
        const { json } = await api(base, 'GET', `/api/connections/${id}/status`);
        const row = json?.connection?.liveStatus;
        if (!row?.simulator || row.armed !== false || !(Number(row.heartbeatCount) > 0)) return null;
        if (row.host !== '127.0.0.1' || row.port !== 5760) return null;
        return row;
      }, 45000, 'simulator heartbeat');
      expect(live.simulator).toBe(true);
      const go = await api(base, 'POST', '/api/assist/voice-go', { active: true });
      expect(go.json.ask_voice_go_active).toBe(true);
      const rtl = await api(base, 'POST', '/api/assist/voice-flight', { text: 'עבור למצב RTL' });
      expect(rtl.status).toBe(200);
      expect(rtl.json.sent).toBe(true);
      expect(rtl.json.kind).toBe('RTL');
      expect(rtl.json.customMode).toBe(11);
      expect(rtl.json.resolver).toBe('mock-gemini');
      expect(rtl.json.talkback.provider).toBe('mock');
      expect(rtl.json.talkback.text).toContain('אושר');
      const mode = await waitUntil(async () => {
        const { json } = await api(base, 'GET', `/api/connections/${id}/status`);
        const flightMode = json?.connection?.liveStatus?.flightMode;
        return flightMode === 11 ? flightMode : null;
      }, 15000, 'RTL mode');
      expect(mode).toBe(11);
      const arm = await api(base, 'POST', '/api/assist/voice-flight', { text: 'חמש את המטוס' });
      expect(arm.json.sent).toBe(false);
      expect(arm.json.blocked).toBe(true);
      expect(arm.json.kind).toBe('ARM');
      expect(arm.json.talkback.text).toContain('נדחה');
      const stray = await api(base, 'POST', '/api/assist/voice-flight', { text: 'תעיף את המטוס לחלל' });
      expect(stray.json.sent).toBe(false);
      expect(stray.json.decision).toBe('not_allowlisted');
      const after = await api(base, 'GET', `/api/connections/${id}/status`);
      expect(after.json.connection.liveStatus.flightMode).toBe(11);
      expect(after.json.connection.liveStatus.armed).toBe(false);
    } catch (err) {
      throw new Error(`${err.message}\n${tail(sitlLogs.out)}\n${tail(logs.out)}`);
    } finally {
      await api(base, 'POST', '/api/links/disconnect', { role: 'radio' }).catch(() => {});
      stopChild(sitl);
      stopChild(consoleProc);
    }
  }, 180000);
});
