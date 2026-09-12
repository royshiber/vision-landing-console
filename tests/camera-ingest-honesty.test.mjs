import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMERA_INSTALL_NO_FRAME_HE,
  buildCameraInstallChecklist,
  normalizeCameraInstallOperator,
} from '../lib/camera-install-checklist.mjs';
import { buildVisionLandingReadiness } from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');
const ingestPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'camera_ingest.py');
const installPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'install.sh');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const agentSrc = fs.readFileSync(agentPath, 'utf8');

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

async function waitHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw last || new Error(`timeout waiting for ${url}`);
}

function spawnAgent(env) {
  return spawn('python3', [agentPath], {
    env: {
      ...process.env,
      VLC_HTTP_BIND: '127.0.0.1',
      VLC_SKIP_RELAY: '1',
      VLC_CONSOLE_URL: 'http://127.0.0.1:1',
      VLC_FC_DEVICE: '/dev/null',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function pythonJson(args, extraEnv = {}) {
  const r = spawnSync('python3', args, {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
  });
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return JSON.parse(r.stdout);
}

describe('dual-camera ingest honesty', () => {
  it('pins APP_VERSION at 1.02.311', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.311'");
    expect(pkg.version).toBe('1.02.311');
  });

  it('keeps 2.3.1 UART fan-out and never hardcodes a live camera', () => {
    expect(agentSrc).toContain('uart_reader');
    expect(agentSrc).toContain('fanout_uart');
    expect(agentSrc).not.toMatch(/\.recv_match\s*\(/);
    expect(agentSrc).toMatch(/AGENT_VERSION.*"2\.3\.4"/);
    expect(agentSrc).toContain('/api/v1/status/cameras');
    expect(agentSrc).toContain('/api/v1/cameras/');
    expect(agentSrc).not.toMatch(/"camera_ok": True/);
    expect(agentSrc).not.toMatch(/ARM|DISARM|MAV_CMD_NAV_LAND|COMMAND_LONG/);
    expect(fs.existsSync(ingestPath)).toBe(true);
    expect(fs.existsSync(installPath)).toBe(true);
  });

  it('absent dry-run stays not ok and invents no frames', () => {
    const snap = pythonJson([ingestPath, '--dry-run', '--json']);
    expect(snap.camera_ok).toBe(false);
    expect(snap.dry_run).toBe(true);
    expect(snap.real).toBe(false);
    expect(snap.source).toBe('absent');
    expect(snap.fps).toBeNull();
    expect(snap.last_frame_age_ms).toBeNull();
    expect(snap.cameras.cam1.camera_ok).toBe(false);
    expect(snap.cameras.cam2.camera_ok).toBe(false);
    expect(snap.cameras.cam1.role).toBe('forward');
    expect(snap.cameras.cam2.role).toBe('down');
    expect(snap.cameras.cam1.has_frame).toBe(false);
  });

  it('synthetic dry-run reports fps or age and never claims real', () => {
    const snap = pythonJson([ingestPath, '--dry-run-synthetic', '--seconds', '0.35', '--json']);
    expect(snap.dry_run).toBe(true);
    expect(snap.real).toBe(false);
    expect(snap.source).toBe('synthetic');
    expect(snap.camera_ok).toBe(true);
    expect(snap.fps != null || snap.last_frame_age_ms != null).toBe(true);
    expect(snap.cameras.cam1.source).toBe('synthetic');
    expect(snap.cameras.cam1.real).toBe(false);
    expect(snap.cameras.cam1.has_frame).toBe(true);
  });

  it('operator confirm alone still does not invent camera_ok', () => {
    const confirmed = buildCameraInstallChecklist({
      operator: normalizeCameraInstallOperator({
        confirms: {
          role_select: true,
          physical_connect: true,
          jetson_wiring: true,
          companion_pipeline: true,
          live_frame: true,
        },
      }),
    });
    expect(confirmed.summary.operatorConfirmedCount).toBe(5);
    expect(confirmed.summary.cameraOk).toBeNull();
    expect(confirmed.liveFrame.stateHe).toBe(CAMERA_INSTALL_NO_FRAME_HE);
    const row = buildVisionLandingReadiness({
      cameraInstallOperator: confirmed.operator,
    }).rows.find((r) => r.id === 'camera_install');
    expect(row.cameraOk).not.toBe(true);
    expect(row.state).not.toBe('ok');
  });

  it('uses per-camera fps or age for live-frame verify without inventing real', () => {
    const live = buildCameraInstallChecklist({
      companion: { jetson: 'reachable' },
      vision: { camera_ok: true, dry_run: true, source: 'synthetic' },
      opticalNav: {
        camera_ok: false,
        cameras: {
          cam1: { camera_ok: true, fps: 12, last_frame_age_ms: 80, source: 'synthetic', dry_run: true, real: false },
          cam2: { camera_ok: true, fps: 11, last_frame_age_ms: 90, source: 'synthetic', dry_run: true, real: false },
        },
      },
    });
    expect(live.liveFrame.state).toBe('ok');
    expect(live.perCamera.cam1).toBe(true);
    expect(live.perCamera.detail.cam1.dry_run).toBe(true);
    expect(live.perCamera.detail.cam1.real).toBe(false);
    expect(live.invented.frames).toBe(false);
  });

  it('keeps Mission preview separate from cellular annotated vision', () => {
    expect(html).toContain('id="liveCameraPanel"');
    expect(html).toContain('id="liveCameraToggle"');
    expect(html).toContain('id="annotatedVisionPanel"');
    expect(js).toContain('function applyLiveCameraPreview');
    expect(js).toContain('אין פריים');
    expect(js).toContain('תרגיל יבש');
    expect(js).toContain('/api/jetson/v1/cameras/');
    expect(css).toMatch(/\.mission-live-camera\b/);
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });
});

describe('companion_agent camera ingest HTTP', () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let absentChild = null;
  let absentBase = '';
  /** @type {import('node:child_process').ChildProcess | null} */
  let synChild = null;
  let synBase = '';

  beforeAll(async () => {
    const absentPort = await freePort();
    absentBase = `http://127.0.0.1:${absentPort}`;
    absentChild = spawnAgent({
      VLC_HTTP_PORT: String(absentPort),
      VLC_CAMERA_DRY_RUN: '1',
    });
    await waitHttp(`${absentBase}/api/health`);

    const synPort = await freePort();
    synBase = `http://127.0.0.1:${synPort}`;
    synChild = spawnAgent({
      VLC_HTTP_PORT: String(synPort),
      VLC_CAMERA_DRY_RUN: 'synthetic',
    });
    await waitHttp(`${synBase}/api/health`);
  }, 20000);

  afterAll(async () => {
    await stopChild(absentChild);
    await stopChild(synChild);
  });

  it('absent dry-run agent reports camera_ok false and no JPEG', async () => {
    const vision = await fetch(`${absentBase}/api/v1/status/vision`).then((r) => r.json());
    const cameras = await fetch(`${absentBase}/api/v1/status/cameras`).then((r) => r.json());
    const frame = await fetch(`${absentBase}/api/v1/cameras/cam1/frame`);
    expect(vision.agentVersion || true).toBeTruthy();
    expect(vision.camera_ok).toBe(false);
    expect(vision.dry_run).toBe(true);
    expect(vision.real).toBe(false);
    expect(cameras.camera_ok).toBe(false);
    expect(cameras.cameras.cam1.present).toBe(false);
    expect(frame.status).toBe(404);
    const body = await frame.json();
    expect(body.reason).toBe('no_frame');
  });

  it('synthetic dry-run agent reports fps/age and a JPEG without claiming real', async () => {
    await new Promise((r) => setTimeout(r, 350));
    const vision = await fetch(`${synBase}/api/v1/status/vision`).then((r) => r.json());
    const optical = await fetch(`${synBase}/api/v1/status/optical-nav`).then((r) => r.json());
    const frame = await fetch(`${synBase}/api/v1/cameras/cam1/frame`);
    expect(vision.dry_run).toBe(true);
    expect(vision.real).toBe(false);
    expect(vision.source).toBe('synthetic');
    expect(vision.camera_ok).toBe(true);
    expect(vision.fps != null || vision.last_frame_age_ms != null).toBe(true);
    expect(optical.camera_ok).toBe(false);
    expect(optical.position).toBeNull();
    expect(optical.cameras.cam1.camera_ok).toBe(true);
    expect(optical.cameras.cam1.real).toBe(false);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toMatch(/image\/jpeg/);
    const bytes = Buffer.from(await frame.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(20);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });
});
