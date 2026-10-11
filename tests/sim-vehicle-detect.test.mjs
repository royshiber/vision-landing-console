import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { hebrewPillLabel } from '../lib/dual-link.mjs';
import { connectLink, disconnectLink } from '../lib/dual-link-runtime.mjs';
import { buildMavlink1Frame, deactivateConnection, MavlinkConnection } from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';
import {
  applySimulatorPreset,
  detectSimulatorVehicle,
  parseAutopilotVersion,
  registerSimulatorTestPort,
  resolveSimulatorTcpPort,
  SIMULATOR_PORT_BLOCKED_HE,
  SIMULATOR_PRESET_NAME,
  SIMULATOR_TCP_PORT,
  SIMULATOR_UNAVAILABLE_HE,
} from '../lib/sim-vehicle.mjs';
import { freePort } from './test-server.mjs';
import { buildSitlLaunchPlan, SITL_STABLE_BASE_URL } from '../scripts/windows/sitl-launch-plan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public/styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const launcher = fs.readFileSync(path.join(repoRoot, 'scripts/windows/Start-AIRVIX-SITL.ps1'), 'utf8');
const bat = fs.readFileSync(path.join(repoRoot, 'scripts/windows/Start-AIRVIX-SITL.bat'), 'utf8');

function versionPayload(osText) {
  const buf = Buffer.alloc(60);
  buf.write(osText, 52, 'latin1');
  return buf;
}

const OVERRIDE_FLAGS = ['VITEST', 'VLC_QA', 'VLC_TEST', 'RUN_SITL_E2E'];

function vehicleHeartbeatFrame() {
  const payload = Buffer.alloc(9);
  payload[4] = 1;
  payload[5] = 3;
  payload[7] = 4;
  payload[8] = 3;
  const mid = Buffer.from([payload.length, 1, 1, 1, 0]);
  const crcData = Buffer.concat([mid, payload, Buffer.from([50])]);
  let crc = 0xFFFF;
  for (const b of crcData) {
    let tmp = (b ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ (tmp << 4)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return Buffer.concat([
    Buffer.from([0xfe]),
    mid,
    payload,
    Buffer.from([crc & 0xff, (crc >> 8) & 0xff]),
  ]);
}

function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function productionEnv(extra = {}) {
  const patch = { ...extra };
  for (const key of OVERRIDE_FLAGS) patch[key] = null;
  return patch;
}

describe('simulator detection', () => {
  it('does not treat a real ArduPilot heartbeat as a simulator', () => {
    const found = detectSimulatorVehicle({
      autopilotName: 'ArduPilot',
      heartbeat: { autopilot: 3, type: 1 },
      host: '127.0.0.1',
      port: SIMULATOR_TCP_PORT,
      params: { AIRSPEED_MIN: 12, FLTMODE1: 11 },
    });
    expect(found).toEqual({ simulator: false, reason: null });
  });

  it('detects the simulator preset, a SITL version string, and SIM_ params', () => {
    expect(detectSimulatorVehicle({ preset: 'simulator' })).toEqual({ simulator: true, reason: 'preset' });
    expect(detectSimulatorVehicle({ name: SIMULATOR_PRESET_NAME }).reason).toBe('preset');
    expect(detectSimulatorVehicle({
      autopilotVersion: { osCustomVersion: 'SITL' },
    }).reason).toBe('autopilot-version');
    expect(detectSimulatorVehicle({
      autopilotVersion: parseAutopilotVersion(versionPayload('SITL')),
    }).reason).toBe('autopilot-version');
    expect(detectSimulatorVehicle({
      params: { SIM_SPEEDUP: 1 },
    }).reason).toBe('sim-params');
  });

  it('ignores ordinary params, short version frames, and a denial that merely mentions SITL', () => {
    expect(detectSimulatorVehicle({ params: { SIMPLE_MODE: 1, SIMSPEED: 1 } }).simulator).toBe(false);
    expect(parseAutopilotVersion(Buffer.alloc(20))).toBeNull();
    expect(detectSimulatorVehicle({
      autopilotVersion: { osCustomVersion: 'not SITL' },
    }).simulator).toBe(false);
    expect(detectSimulatorVehicle({
      autopilotVersion: { flightCustomVersion: 'ArduPlane' },
    }).simulator).toBe(false);
  });

  it('keeps the badge off until a vehicle heartbeat, then on for preset or SIM_ params', () => {
    const preset = new MavlinkConnection({
      id: 7,
      name: SIMULATOR_PRESET_NAME,
      type: 'tcp',
      host: '127.0.0.1',
      port: SIMULATOR_TCP_PORT,
      simulatorPreset: true,
    });
    expect(preset.getStatus().simulator).toBe(false);
    preset.connected = true;
    expect(preset.getStatus().simulator).toBe(false);
    preset.heartbeatCount = 1;
    expect(preset.getStatus().simulator).toBe(true);
    expect(preset.getStatus().simulatorReason).toBe('preset');

    const real = new MavlinkConnection({ id: 8, name: 'Serial COM3', type: 'serial' });
    real.connected = true;
    real.autopilotName = 'ArduPilot';
    real.params.AIRSPEED_MIN = 9;
    expect(real.getStatus().simulator).toBe(false);
    real.params.SIM_SPEEDUP = 1;
    expect(real.getStatus().simulator).toBe(false);
    real.heartbeatCount = 1;
    expect(real.getStatus().simulatorReason).toBe('sim-params');
    real.params = {};
    real.autopilotVersion = { osCustomVersion: 'SITL' };
    expect(real.getStatus().simulatorReason).toBe('autopilot-version');

    const quiet = buildSseMavlinkSnapshot({
      connected: true,
      listening: false,
      heartbeatCount: 0,
      params: { SIM_OPOS_LAT: 32.08 },
      autopilotName: 'ArduPilot',
    });
    expect(quiet.simulator).toBe(false);
    const snap = buildSseMavlinkSnapshot({
      connected: true,
      listening: false,
      heartbeatCount: 1,
      params: { SIM_OPOS_LAT: 32.08 },
      autopilotName: 'ArduPilot',
    });
    expect(snap.simulator).toBe(true);
    expect(snap.simulatorReason).toBe('sim-params');
    expect(buildSseMavlinkSnapshot(null).simulator).toBe(false);
    expect(buildSseMavlinkSnapshot({
      connected: false,
      listening: false,
      heartbeatCount: 1,
      name: SIMULATOR_PRESET_NAME,
      simulatorPreset: true,
    }).simulator).toBe(false);
  });

  it('does not label a link סימולטור until a vehicle heartbeat arrives', () => {
    const link = new MavlinkConnection({
      id: 9,
      name: SIMULATOR_PRESET_NAME,
      type: 'tcp',
      host: '127.0.0.1',
      port: SIMULATOR_TCP_PORT,
      simulatorPreset: true,
    });
    link.connected = true;
    const before = link.getStatus();
    expect(before.simulator).toBe(false);
    expect(before.heartbeatCount).toBe(0);
    expect(hebrewPillLabel({ radio: 'connected', simulator: before.simulator })).toBe('מחובר · RF פעיל');

    const gcs = Buffer.alloc(9);
    gcs[4] = 6;
    gcs[5] = 8;
    link._handleData(buildMavlink1Frame(0, gcs, 1));
    expect(link.heartbeatCount).toBe(0);
    expect(link.getStatus().simulator).toBe(false);
    expect(hebrewPillLabel({ radio: 'connected', simulator: link.getStatus().simulator })).not.toContain('סימולטור');

    link._handleData(vehicleHeartbeatFrame());
    const after = link.getStatus();
    expect(after.heartbeatCount).toBe(1);
    expect(after.simulator).toBe(true);
    expect(after.simulatorReason).toBe('preset');
    expect(hebrewPillLabel({ radio: 'connected', simulator: after.simulator })).toBe('מחובר · סימולטור');
  });
});

describe('Windows SITL launch plan', () => {
  it('points at the stable Mission Planner build, Tel Aviv home, and both outputs', () => {
    const plan = buildSitlLaunchPlan();
    expect(plan.baseUrl).toBe(SITL_STABLE_BASE_URL);
    expect(plan.baseUrl).toMatch(/\/Stable\/$/);
    expect(plan.files.map((file) => file.name)).toContain('ArduPlane.elf');
    expect(plan.files.every((file) => file.url.startsWith(SITL_STABLE_BASE_URL))).toBe(true);
    expect(plan.homeArg).toBe('32.0853,34.7818,15,90');
    expect(plan.tcp).toEqual({ host: '127.0.0.1', port: 5760 });
    expect(plan.argv).toEqual([
      '--model', 'plane',
      '--speedup', '1',
      '--home', '32.0853,34.7818,15,90',
      '--serial0', `tcp:${plan.tcp.port}`,
      '--serial1', 'udpclient:127.0.0.1:14550',
    ]);
  });

  it('supports RealFlight and a home override, and can omit the second output', () => {
    const plan = buildSitlLaunchPlan({
      physics: 'flightaxis',
      lat: 32.1,
      lon: 34.8,
      altM: 20,
      hdg: 180,
      gcsUdp: false,
    });
    expect(plan.model).toBe('flightaxis:127.0.0.1');
    expect(plan.argv).toContain('--model');
    expect(plan.argv).toContain('flightaxis:127.0.0.1');
    expect(plan.argv.join(' ')).not.toContain('udpclient');
    expect(plan.homeArg).toBe('32.1,34.8,20,180');
    expect(plan.messages.realflight.length).toBeGreaterThan(10);
    expect(() => buildSitlLaunchPlan({ lat: 120 })).toThrow(/קו רוחב/);
  });

  it('the launcher reports failures and does not ask for administrator rights', () => {
    expect(bat).toContain('Start-AIRVIX-SITL.ps1');
    expect(bat).toContain('ההפעלה נכשלה');
    expect(launcher).toContain('sitl-launch-plan.mjs');
    expect(launcher).toContain('Invoke-WebRequest');
    expect(launcher).toContain('exit 1');
    expect(launcher).not.toMatch(/RunAs|requireAdministrator|#Requires -RunAsAdministrator/i);
    expect(readme).toContain('סימולטור על ווינדוס');
    expect(readme).toContain('flightaxis');
  });
});

describe('simulator TCP port override', () => {
  it('keeps 5760 unless simulatorPort or SIMULATOR_TCP_PORT is set', () => {
    expect(applySimulatorPreset({
      preset: 'simulator',
      type: 'tcp',
      host: '10.0.0.8',
      port: 9999,
    })).toMatchObject({ host: '127.0.0.1', port: SIMULATOR_TCP_PORT });
    expect(applySimulatorPreset({
      preset: 'simulator',
      type: 'tcp',
      port: 9999,
      simulatorPort: 5761,
    }).port).toBe(5761);
    const prev = process.env.SIMULATOR_TCP_PORT;
    process.env.SIMULATOR_TCP_PORT = '5802';
    try {
      expect(applySimulatorPreset({ preset: 'simulator', type: 'tcp', port: 9999 }).port).toBe(5802);
      expect(applySimulatorPreset({
        preset: 'simulator',
        type: 'tcp',
        simulatorPort: 5840,
      }).port).toBe(5840);
    } finally {
      if (prev == null) delete process.env.SIMULATOR_TCP_PORT;
      else process.env.SIMULATOR_TCP_PORT = prev;
    }
  });

  it('production ignores simulatorPort and SIMULATOR_TCP_PORT', () => {
    withEnv(productionEnv({ SIMULATOR_TCP_PORT: '4010' }), () => {
      const shaped = applySimulatorPreset({
        preset: 'simulator',
        type: 'tcp',
        host: '10.0.0.8',
        port: 4010,
        simulatorPort: 5761,
      });
      expect(shaped.simulatorPortRefused).toBeFalsy();
      expect(shaped).toMatchObject({ host: '127.0.0.1', port: SIMULATOR_TCP_PORT });
    });
  });

  it('follows the qa-mode VLC_QA check and refuses the relay port', () => {
    withEnv({ ...productionEnv(), VLC_QA: 'maybe' }, () => {
      const shaped = applySimulatorPreset({
        preset: 'simulator',
        type: 'tcp',
        simulatorPort: 5761,
      });
      expect(shaped.simulatorPortRefused).toBeFalsy();
      expect(shaped.port).toBe(SIMULATOR_TCP_PORT);
    });
    withEnv({ ...productionEnv(), VLC_QA: 'yes' }, () => {
      expect(applySimulatorPreset({
        preset: 'simulator',
        type: 'tcp',
        simulatorPort: 5761,
      }).port).toBe(5761);
      expect(resolveSimulatorTcpPort(5770).ok).toBe(false);
      expect(resolveSimulatorTcpPort(4401).ok).toBe(false);
    });
  });

  it('accepts a helper free port and still refuses the console port', async () => {
    const free = await freePort();
    expect(resolveSimulatorTcpPort(free).port).toBe(free);
    await withEnv({ PORT: String(free) }, () => {
      expect(resolveSimulatorTcpPort(free).ok).toBe(false);
      expect(resolveSimulatorTcpPort(5770).ok).toBe(false);
    });
  });

  it('ignores free-port env entries the helper did not register', () => {
    const blocked = [3090, 3091, 3092, 3190, 3191, 4010, 5770, 8080, 8081];
    withEnv({ VLC_SIM_FREE_PORTS: [...blocked, 4401].join(',') }, () => {
      for (const port of [...blocked, 4401]) {
        expect(resolveSimulatorTcpPort(port).ok, String(port)).toBe(false);
      }
      expect(resolveSimulatorTcpPort(5761).port).toBe(5761);
      expect(resolveSimulatorTcpPort(5859).port).toBe(5859);
    });
  });

  it('refuses the block list even after the helper registers those ports', () => {
    for (const port of [3090, 3091, 3092, 3190, 3191, 4010, 5770, 8080, 8081]) {
      expect(registerSimulatorTestPort(port), String(port)).toBeNull();
      expect(resolveSimulatorTcpPort(port).ok, String(port)).toBe(false);
    }
  });

  it('refuses a blocked simulator port instead of dialing the console', async () => {
    const dbPath = path.join(os.tmpdir(), `airvix-sim-block-${process.pid}-${Date.now()}.sqlite`);
    const db = openDatabase(dbPath);
    const ownPort = '4408';
    const blocked = [3090, 3091, 3092, 3190, 3191, 4010, 5770, 8080, 8081, Number(ownPort), 4401];
    try {
      await withEnv({ PORT: ownPort, SIMULATOR_TCP_PORT: null }, async () => {
        for (const port of blocked) {
          const result = await connectLink({ db }, {
            role: 'radio',
            type: 'tcp',
            host: '10.1.1.1',
            port: 9999,
            preset: 'simulator',
            simulatorPort: port,
          });
          expect(result.ok, String(port)).toBe(false);
          expect(result.message, String(port)).toBe(SIMULATOR_PORT_BLOCKED_HE);
        }
        const fromEnv = await withEnv({ SIMULATOR_TCP_PORT: '8081' }, () => connectLink({ db }, {
          role: 'radio',
          type: 'tcp',
          host: '10.1.1.1',
          port: 9999,
          preset: 'simulator',
        }));
        expect(fromEnv.ok).toBe(false);
        expect(fromEnv.message).toBe(SIMULATOR_PORT_BLOCKED_HE);
      });
      const row = db.prepare('SELECT * FROM connections WHERE name = ?').get(SIMULATOR_PRESET_NAME);
      expect(row).toBeFalsy();
    } finally {
      db.close();
      fs.unlinkSync(dbPath);
    }
  });
});

describe('simulator connection preset', () => {
  let dbPath = null;
  let server = null;

  afterEach(async () => {
    disconnectLink({ db: null }, 'radio');
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    dbPath = null;
  });

  it('refuses a missing simulator in Hebrew and connects only to the local preset', async () => {
    dbPath = path.join(os.tmpdir(), `airvix-sim-preset-${process.pid}-${Date.now()}.sqlite`);
    const db = openDatabase(dbPath);
    const missing = await connectLink({ db }, {
      role: 'radio',
      type: 'tcp',
      host: '10.1.1.1',
      port: 9999,
      preset: 'simulator',
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toBe(SIMULATOR_UNAVAILABLE_HE);
    const row = db.prepare(`SELECT * FROM connections WHERE name = ?`).get(SIMULATOR_PRESET_NAME);
    expect(row).toBeFalsy();

    server = net.createServer((socket) => {
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(SIMULATOR_TCP_PORT, '127.0.0.1', resolve);
    });
    const tcp = await connectLink({ db }, {
      role: 'radio',
      type: 'tcp',
      host: '10.1.1.1',
      port: 9999,
      preset: 'simulator',
    });
    expect(tcp.ok).toBe(true);
    expect(tcp.status.name).toBe(SIMULATOR_PRESET_NAME);
    expect(tcp.status.type).toBe('tcp');
    expect(tcp.status.host).toBe('127.0.0.1');
    expect(tcp.status.port).toBe(SIMULATOR_TCP_PORT);
    expect(tcp.status.simulator).toBe(false);
    expect(tcp.status.simulatorReason).toBe(null);
    expect(hebrewPillLabel({ radio: 'connected', simulator: tcp.status.simulator })).not.toContain('סימולטור');
    deactivateConnection(tcp.id);

    const udp = await connectLink({ db }, {
      role: 'radio',
      type: 'udp',
      host: '10.9.9.9',
      port: 9999,
      preset: 'simulator',
    });
    expect(udp.ok).toBe(true);
    expect(udp.status.type).toBe('udp');
    expect(udp.status.host).toBe('0.0.0.0');
    expect(udp.status.port).toBe(14550);
    expect(udp.status.host).not.toBe('10.9.9.9');
    expect(udp.status.simulator).toBe(false);
    expect(udp.status.simulatorReason).toBe(null);
    deactivateConnection(udp.id);
    db.close();
  });
});

describe('simulator chrome', () => {
  it('shows a simulator preset and a header badge that stays hidden until detection', () => {
    expect(html).toContain('id="connectSimTcpBtn"');
    expect(html).toContain('id="connectSimUdpBtn"');
    expect(html).toContain('>TCP 5760</button>');
    expect(html).toContain('>UDP 14550</button>');
    expect(html).toContain('>סימולטור</span>');
    expect(html).toContain('מטוס וירטואלי על המחשב, לא מטוס אמיתי.');
    expect(html).toContain('id="simVehicleBadge"');
    expect(html).toContain('>SIM</span>');
    expect(html).toContain('hidden');
    expect(html).toContain('מחובר לסימולטור. זה לא מטוס אמיתי.');
    expect(js).toContain('function applySimVehicleBadge');
    expect(js).toContain("preset: 'simulator'");
    expect(js).toContain('mav.simulator === true');
    expect(css).toContain('.sim-vehicle-badge');
    expect(css).toMatch(/\.sim-vehicle-badge\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});
