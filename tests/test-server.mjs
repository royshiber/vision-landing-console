import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A free TCP port from listen(0). The console then binds that port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Start server.js on a free port. Throws if /api/health does not answer in time.
 * env may be an object or (port) => object. PORT and HOST are always the free port.
 * unset removes keys after process.env is copied (for example VITEST).
 */
export async function startTestServer(opts = {}) {
  const port = await freePort();
  const host = '127.0.0.1';
  const extra = typeof opts.env === 'function' ? opts.env(port) : { ...(opts.env || {}) };
  const env = { ...process.env, ...extra, HOST: host, PORT: String(port) };
  for (const key of opts.unset || []) delete env[key];
  env.HOST = host;
  env.PORT = String(port);
  const stdio = opts.stdio ?? ['ignore', 'pipe', 'pipe'];
  const child = spawn(process.execPath, [...(opts.execArgv || []), 'server.js'], {
    cwd: opts.cwd || repoRoot,
    env,
    stdio,
  });
  const logs = [];
  const take = (buf) => {
    logs.push(String(buf));
    if (logs.length > 40) logs.shift();
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  child.on('error', (err) => take(String(err)));
  if (typeof opts.onChild === 'function') opts.onChild(child);
  const base = `http://${host}:${port}`;
  const timeout = opts.healthTimeoutMs ?? 20000;
  try {
    await waitForHealth(base, timeout, child, logs);
  } catch (err) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    throw err;
  }
  return { child, port, base };
}

async function waitForHealth(base, maxMs, child, logs) {
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < maxMs) {
    if (child.exitCode != null || child.signalCode) {
      throw new Error(
        `test server exited before /api/health at ${base} (code ${child.exitCode}, signal ${child.signalCode})\n${logs.join('').slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err?.message || String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `test server health check did not answer at ${base}/api/health within ${maxMs}ms (${last})\n${logs.join('').slice(-2000)}`,
  );
}
