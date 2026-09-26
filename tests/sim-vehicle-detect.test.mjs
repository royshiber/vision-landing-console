import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { connectLink, disconnectLink } from '../lib/dual-link-runtime.mjs';
import { deactivateConnection, MavlinkConnection } from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';
import {
  detectSimulatorVehicle,
  parseAutopilotVersion,
  SIMULATOR_PRESET_NAME,
  SIMULATOR_TCP_PORT,
  SIMULATOR_UNAVAILABLE_HE,
} from '../lib/sim-vehicle.mjs';
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

  it('keeps the badge off until the socket is up, then on for preset or SIM_ params', () => {
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
    expect(preset.getStatus().simulator).toBe(true);
    expect(preset.getStatus().simulatorReason).toBe('preset');

    const real = new MavlinkConnection({ id: 8, name: 'Serial COM3', type: 'serial' });
    real.connected = true;
    real.autopilotName = 'ArduPilot';
    real.params.AIRSPEED_MIN = 9;
    expect(real.getStatus().simulator).toBe(false);
    real.params.SIM_SPEEDUP = 1;
    expect(real.getStatus().simulatorReason).toBe('sim-params');
    real.params = {};
    real.autopilotVersion = { osCustomVersion: 'SITL' };
    expect(real.getStatus().simulatorReason).toBe('autopilot-version');

    const snap = buildSseMavlinkSnapshot({
      connected: true,
      listening: false,
      params: { SIM_OPOS_LAT: 32.08 },
      autopilotName: 'ArduPilot',
    });
    expect(snap.simulator).toBe(true);
    expect(snap.simulatorReason).toBe('sim-params');
    expect(buildSseMavlinkSnapshot(null).simulator).toBe(false);
    expect(buildSseMavlinkSnapshot({
      connected: false,
      listening: false,
      name: SIMULATOR_PRESET_NAME,
      simulatorPreset: true,
    }).simulator).toBe(false);
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
    expect(plan.argv).toEqual([
      '--model', 'plane',
      '--speedup', '1',
      '--home', '32.0853,34.7818,15,90',
      '--serial0', 'tcp:5760',
      '--serial1', 'udpclient:127.0.0.1:14550',
    ]);
    expect(plan.tcp).toEqual({ host: '127.0.0.1', port: 5760 });
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
    const live = await connectLink({ db }, {
      role: 'radio',
      type: 'udp',
      host: '10.9.9.9',
      port: 14550,
      preset: 'simulator',
    });
    expect(live.ok).toBe(true);
    expect(live.status.name).toBe(SIMULATOR_PRESET_NAME);
    expect(live.status.type).toBe('tcp');
    expect(live.status.host).toBe('127.0.0.1');
    expect(live.status.port).toBe(SIMULATOR_TCP_PORT);
    expect(live.status.simulator).toBe(true);
    expect(live.status.simulatorReason).toBe('preset');
    deactivateConnection(live.id);
    db.close();
  });
});

describe('simulator chrome', () => {
  it('shows a simulator preset and a header badge that stays hidden until detection', () => {
    expect(html).toContain('id="connectSimPresetBtn"');
    expect(html).toContain('>סימולטור</button>');
    expect(html).toContain('לא כלי אמיתי');
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
