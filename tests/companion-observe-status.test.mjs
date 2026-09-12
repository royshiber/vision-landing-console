import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCompanionVisionSignals,
  probeCameraVision,
  probeRunwayDetect,
  probeRunwayLock,
} from '../lib/vision-companion-probe.mjs';
import { buildVisionLandingReadiness } from '../lib/vision-landing-readiness.mjs';
import { collectVisionLandingReadinessInput } from '../lib/routes/vision-landing-readiness-api.mjs';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');
const agentSrc = fs.readFileSync(agentPath, 'utf8');
const reachable = { jetson: 'reachable', fc: 'heartbeat', hasData: true, fc_heartbeat: true };

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
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw last || new Error(`timeout waiting for ${url}`);
}

describe('companion_agent observe-only vision / landing status', () => {
  it('pins APP_VERSION at 1.02.305', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.305'");
    expect(pkg.version).toBe('1.02.305');
  });

  it('keeps 2.3.1 fan-out UART and reports explicit absent, never invented detect', () => {
    expect(agentSrc).toContain('uart_reader');
    expect(agentSrc).toContain('fanout_uart');
    expect(agentSrc).not.toMatch(/\.recv_match\s*\(/);
    expect(agentSrc).toMatch(/AGENT_VERSION.*"2\.3\.3"/);
    expect(agentSrc).toContain('/api/v1/status/vision');
    expect(agentSrc).toContain('/api/v1/status/optical-nav');
    expect(agentSrc).toContain('/api/v1/status/landing');
    expect(agentSrc).toContain('optical_nav_status_payload');
    expect(agentSrc).toContain('"ekf_injected": False');
    expect(agentSrc).toContain('"alt_ceiling_m": 300');
    expect(agentSrc).toMatch(/"camera_ok": False/);
    expect(agentSrc).toMatch(/"runway_detector": False/);
    expect(agentSrc).not.toMatch(/"camera_ok": True/);
    expect(agentSrc).not.toMatch(/"runway_detected": True/);
    expect(agentSrc).not.toMatch(/ARM|DISARM|MAV_CMD_NAV_LAND|COMMAND_LONG/);
  });

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let base = '';

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('python3', [agentPath], {
      env: {
        ...process.env,
        VLC_HTTP_PORT: String(port),
        VLC_HTTP_BIND: '127.0.0.1',
        VLC_SKIP_RELAY: '1',
        VLC_CONSOLE_URL: 'http://127.0.0.1:1',
        VLC_FC_DEVICE: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    try {
      await waitHttp(`${base}/api/health`);
    } catch (err) {
      child.kill('SIGTERM');
      throw new Error(`companion_agent did not start: ${err.message}\n${stderr}`);
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

  it('serves honest absent camera / runway payloads on health and v1 status paths', async () => {
    const [health, status, vision, landing, video, opticalNav] = await Promise.all([
      fetch(`${base}/api/health`).then((r) => r.json()),
      fetch(`${base}/api/v1/status`).then((r) => r.json()),
      fetch(`${base}/api/v1/status/vision`).then((r) => r.json()),
      fetch(`${base}/api/v1/status/landing`).then((r) => r.json()),
      fetch(`${base}/api/v1/status/video`).then((r) => r.json()),
      fetch(`${base}/api/v1/status/optical-nav`).then((r) => r.json()),
    ]);
    expect(health.agentVersion).toBe('2.3.3');
    expect(health.vision.camera_ok).toBe(false);
    expect(health.landing.runway_detector).toBe(false);
    expect(health.landing.runway_detected).toBeNull();
    expect(health.extras.camera_ok).toBe(false);
    expect(status.vision.camera_ok).toBe(false);
    expect(status.landing.runway_detector).toBe(false);
    expect(vision.camera_ok).toBe(false);
    expect(vision.running).toBe(false);
    expect(landing.runway_detector).toBe(false);
    expect(landing.source).toBe('none');
    expect(landing.detections).toEqual([]);
    expect(landing.target).toBeNull();
    expect(landing.lock_state).toBeUndefined();
    expect(video.raw_pipeline).toBe('none');
    expect(opticalNav.camera_ok).toBe(false);
    expect(opticalNav.running).toBe(false);
    expect(opticalNav.present).toBe(false);
    expect(opticalNav.position).toBeNull();
    expect(opticalNav.velocity).toBeNull();
    expect(opticalNav.ekf_injected).toBe(false);
    expect(opticalNav.alt_ceiling_m).toBe(300);
    expect(opticalNav.display_only).toBe(true);
    expect(status.optical_nav.camera_ok).toBe(false);
    expect(status.optical_nav.position).toBeNull();
    expect(health.optical_nav.camera_ok).toBe(false);
    expect(JSON.stringify({ health, status, vision, landing, opticalNav })).not.toMatch(/"camera_ok":\s*true/i);
    expect(JSON.stringify({ health, status, landing })).not.toMatch(/"runway_detected":\s*true/i);
    expect(JSON.stringify(landing)).not.toMatch(/locked/i);
  });

  it('probes live agent payloads as camera absent, runway absent, lock unknown', async () => {
    const client = createCompanionApiClient({
      baseUrl: base,
      timeoutMs: 2000,
    });
    const signals = await collectCompanionVisionSignals({ overlay: {}, client });
    expect(signals.vision.camera_ok).toBe(false);
    expect(signals.landing.runway_detector).toBe(false);
    expect(probeCameraVision({ companion: reachable, vision: signals.vision }).state).toBe('absent');
    expect(probeRunwayDetect({ companion: reachable, landing: signals.landing }).state).toBe('absent');
    expect(probeRunwayLock({ companion: reachable, landing: signals.landing }).state).toBe('unknown');

    const body = buildVisionLandingReadiness({
      companion: reachable,
      overlay: {
        vision: signals.vision,
        landing: signals.landing,
        video: signals.video,
        extras: signals.extras,
      },
    });
    const row = (id) => body.rows.find((r) => r.id === id);
    expect(row('camera_vision').state).toBe('absent');
    expect(row('runway_detect').state).toBe('absent');
    expect(row('runway_lock').state).toBe('unknown');
    expect(body.experimentSuccess).toBe(false);
    expect(body.sendFlightCommands).toBe(false);
  });

  it('readiness input from a live observe-status client stays absent, not unknown', async () => {
    const client = createCompanionApiClient({
      baseUrl: base,
      timeoutMs: 2000,
    });
    const input = await collectVisionLandingReadinessInput({
      companionService: {
        mode: 'real',
        client,
        getSseOverlay() {
          return {
            companion: {
              mode: 'real',
              reachable: true,
              jetson: 'reachable',
              fc: 'heartbeat',
              fc_heartbeat: true,
            },
          };
        },
      },
      companionClient: client,
    });
    input.companion = reachable;
    const body = buildVisionLandingReadiness(input);
    const row = (id) => body.rows.find((r) => r.id === id);
    expect(row('camera_vision').state).toBe('absent');
    expect(row('runway_detect').state).toBe('absent');
    expect(row('runway_lock').state).toBe('unknown');
    expect(body.experimentSuccess).toBe(false);
  });
});
