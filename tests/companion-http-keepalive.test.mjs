import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function spawnAgent(port, extra) {
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
      VLC_COMPANION_TOKEN: 'keep-alive-test',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitHttp(url) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 8000) {
    try {
      const res = await fetch(url, { headers: { 'X-Companion-Token': 'keep-alive-test' } });
      if (res.ok) return;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw last || new Error(`timeout ${url}`);
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

const clientScript = `
import http.client, json, sys, time
host, port, token, idle = sys.argv[1], int(sys.argv[2]), sys.argv[3], float(sys.argv[4])
steps = []

def one(conn, method, path, body=None, headers=None, chunked=False):
    hdrs = {"X-Companion-Token": token}
    if headers:
        hdrs.update(headers)
    fd_before = conn.sock.fileno() if conn.sock else None
    conn.request(method, path, body=body, headers=hdrs, encode_chunked=chunked)
    resp = conn.getresponse()
    data = resp.read()
    fd_after = conn.sock.fileno() if conn.sock else None
    steps.append({
        "method": method,
        "path": path,
        "status": resp.status,
        "version": resp.version,
        "length": resp.getheader("Content-Length"),
        "connection": resp.getheader("Connection"),
        "n": len(data),
        "fd": fd_after,
        "same": fd_before is not None and fd_before == fd_after,
        "ok_flag": None,
    })
    if data and method != "HEAD":
        try:
            steps[-1]["ok_flag"] = json.loads(data).get("ok")
        except Exception:
            steps[-1]["ok_flag"] = None
    return steps[-1]

conn = http.client.HTTPConnection(host, port, timeout=5)
conn.connect()
origin = conn.sock.fileno()
health = one(conn, "GET", "/api/v1/health")
one(conn, "GET", "/api/v1/health")
one(conn, "GET", "/api/v1/no-such")
one(conn, "GET", "/api/v1/health")
one(conn, "GET", "/api/v1/cameras/cam1/frame")
one(conn, "GET", "/api/v1/health")
one(conn, "POST", "/api/v1/gimbal/center", body=b'{"yaw":1}', headers={"X-Companion-Token": "", "Content-Type": "application/json"})
one(conn, "GET", "/api/v1/health")
one(conn, "POST", "/api/v1/gimbal/center", body=b'{}', headers={"Content-Type": "application/json"})
one(conn, "GET", "/api/v1/health")
one(conn, "OPTIONS", "/api/v1/health")
one(conn, "GET", "/api/v1/health")
one(conn, "HEAD", "/api/v1/health")
one(conn, "GET", "/api/v1/health")
one(conn, "PUT", "/api/v1/health")
one(conn, "GET", "/api/v1/health")
one(conn, "POST", "/api/v1/transport-test", body=b"{}", headers={"Content-Type": "application/json"}, chunked=True)
one(conn, "GET", "/api/v1/health")
alive_fd = conn.sock.fileno() if conn.sock else None
conn.close()

idle_conn = http.client.HTTPConnection(host, port, timeout=3)
idle_conn.connect()
one(idle_conn, "GET", "/api/v1/health")
idle_fd = idle_conn.sock.fileno()
time.sleep(idle + 0.8)
idle_error = None
idle_reused = False
try:
    idle_conn.request("GET", "/api/v1/health", headers={"X-Companion-Token": token})
    resp = idle_conn.getresponse()
    resp.read()
    idle_reused = idle_conn.sock is not None and idle_conn.sock.fileno() == idle_fd
except Exception as exc:
    idle_error = type(exc).__name__
    idle_reused = False
fresh = http.client.HTTPConnection(host, port, timeout=3)
fresh.connect()
fresh.request("GET", "/api/v1/health", headers={"X-Companion-Token": token})
fresh_resp = fresh.getresponse()
fresh_body = fresh_resp.read()
print(json.dumps({
    "origin": origin,
    "alive_fd": alive_fd,
    "health_n": health["n"],
    "health_len": health["length"],
    "steps": steps,
    "idle_reused": idle_reused,
    "idle_error": idle_error,
    "fresh_status": fresh_resp.status,
    "fresh_n": len(fresh_body),
}))
`;

describe('companion HTTP/1.1 keep-alive', () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    child = spawnAgent(port, { VLC_HTTP_IDLE_S: '0.6' });
    await waitHttp(`http://127.0.0.1:${port}/api/v1/health`);
  }, 15000);

  afterAll(async () => {
    await stopChild(child);
  });

  it('reuses one HTTPConnection across success and error responses', () => {
    const r = spawnSync('python3', ['-', '127.0.0.1', String(port), 'keep-alive-test', '0.6'], {
      input: clientScript,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const report = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(report.alive_fd).toBe(report.origin);
    expect(report.health_len).toBe(String(report.health_n));
    const byPath = (method, path) => report.steps.filter((s) => s.method === method && s.path === path);
    for (const step of report.steps) {
      expect(step.version, `${step.method} ${step.path}`).toBe(11);
      expect(step.same, `${step.method} ${step.path}`).toBe(true);
      expect(String(step.connection || '').toLowerCase()).not.toBe('close');
      if (step.method === 'HEAD') {
        expect(step.n).toBe(0);
        expect(step.length).toBe(String(report.health_n));
      } else if (step.method === 'OPTIONS') {
        expect(step.status).toBe(204);
        expect(step.length).toBe('0');
        expect(step.n).toBe(0);
      } else {
        expect(step.length).toBe(String(step.n));
      }
    }
    expect(byPath('GET', '/api/v1/health').every((s) => s.status === 200)).toBe(true);
    expect(byPath('GET', '/api/v1/no-such')[0].status).toBe(404);
    expect(byPath('GET', '/api/v1/cameras/cam1/frame')[0].status).toBe(404);
    expect(byPath('POST', '/api/v1/gimbal/center')[0].status).toBe(401);
    expect(byPath('POST', '/api/v1/gimbal/center')[1].status).toBe(403);
    expect(byPath('PUT', '/api/v1/health')[0].status).toBe(501);
    expect(byPath('POST', '/api/v1/transport-test')[0].status).toBe(200);
    expect(report.idle_reused).toBe(false);
    expect(report.fresh_status).toBe(200);
    expect(report.fresh_n).toBeGreaterThan(20);
  });
});
