import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');

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

describe('companion version and relay heartbeat', () => {
  let child;
  let agentBase;
  let proxy;
  let proxyBase;

  beforeAll(async () => {
    const port = await freePort();
    agentBase = `http://127.0.0.1:${port}`;
    child = spawn('python3', [agentPath], {
      cwd: path.dirname(agentPath),
      env: {
        ...process.env,
        PYTHONPATH: path.dirname(agentPath),
        VLC_HTTP_BIND: '127.0.0.1',
        VLC_HTTP_PORT: String(port),
        VLC_SKIP_RELAY: '1',
        VLC_COMPANION_TOKEN: '',
        VLC_CAMERA_DRY_RUN: '1',
        VLC_GIMBAL_POLL: '0',
        VLC_AGENT_VERSION: '2.6.3',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${agentBase}/api/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(ready).toBe(true);
    const app = express();
    const client = createCompanionApiClient({
      baseUrl: agentBase,
      env: { COMPANION_MODE: 'real', JETSON_COMPANION_BASE_URL: agentBase },
      timeoutMs: 2000,
    });
    registerCompanionProxyApi(app, { companionClient: client });
    proxy = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    proxyBase = `http://127.0.0.1:${proxy.address().port}`;
  }, 20000);

  afterAll(async () => {
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    if (child && !child.killed) child.kill('SIGTERM');
  });

  it('GET /api/v1/version returns the agent version', async () => {
    const res = await fetch(`${agentBase}/api/v1/version`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.agentVersion).toBe('2.6.3');
    expect(body.api_version).toBe('1');
  });

  it('relay heartbeat is JSON 200, not 502', async () => {
    const direct = await fetch(`${agentBase}/api/v1/relay/heartbeat`);
    const directBody = await direct.json();
    expect(direct.status).not.toBe(502);
    expect(direct.status).toBe(200);
    expect(directBody.heartbeat_ok).toBe(false);
    expect(directBody.ok).toBe(true);
    const proxied = await fetch(`${proxyBase}/api/jetson/v1/status/mavlink`);
    const proxiedBody = await proxied.json();
    expect(proxied.status).not.toBe(502);
    expect(proxied.status).toBe(200);
    expect(proxiedBody.ok).toBe(true);
    expect(proxiedBody.data.heartbeat_ok).toBe(false);
    expect(proxiedBody.data.fc_serial_name).toBe('SERIAL4');
  });
});
