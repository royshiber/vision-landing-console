import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOTATED_VIDEO_PATH, cellularConnectGate } from '../lib/dual-link.mjs';
import { probeHuaweiE3372 } from '../lib/cellular-modem.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pack = path.join(repoRoot, 'scripts', 'jetson-cellular');

const PACK_FILES = [
  'README.md',
  'install.sh',
  'e3372-status.sh',
  'e3372-bringup.sh',
  'pack.sh',
  'lib/e3372-common.sh',
  'udev/99-huawei-e3372.rules',
  'systemd/airvix-e3372-status.service',
  'systemd/airvix-e3372-bringup.service',
  'usb-modeswitch/12d1:1f01',
  'usb-modeswitch/12d1:14fe',
  'conf/e3372.env.example',
];

function read(rel) {
  return fs.readFileSync(path.join(pack, rel), 'utf8');
}

function run(script, args, env = {}) {
  const result = spawnSync(path.join(pack, script), args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: pack,
  });
  return result;
}

function lastJson(stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  expect(start, `JSON in stdout:\n${stdout}`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(text.slice(start, end + 1));
}

describe('Jetson Huawei E3372 host pack (software before hardware)', () => {
  it('pins APP_VERSION at 1.02.293', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');
    expect(version).toContain("export const APP_VERSION = '1.02.293'");
    expect(pkg.version).toBe('1.02.293');
    expect(changelog).toContain('"version": "1.02.293"');
  });

  it('ships the install pack with executable dry-run scripts', () => {
    for (const rel of PACK_FILES) {
      const abs = path.join(pack, rel);
      expect(fs.existsSync(abs), rel).toBe(true);
    }
    for (const rel of ['install.sh', 'e3372-status.sh', 'e3372-bringup.sh', 'pack.sh']) {
      expect(fs.statSync(path.join(pack, rel)).mode & 0o111, rel).toBeTruthy();
    }
  });

  it('dry-runs install, status, bringup, and pack without a live modem', () => {
    const install = run('install.sh', ['--dry-run']);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toMatch(/dry-run: ok/);
    expect(install.stdout).toMatch(/modem_absent/);
    expect(install.stdout).not.toMatch(/apt-get install/);

    const status = run('e3372-status.sh', ['--dry-run']);
    expect(status.status, status.stderr).toBe(0);
    const absent = lastJson(status.stdout);
    expect(absent.present).toBe(false);
    expect(absent.state).toBe('modem_absent');
    expect(absent.role).toBe('cellular');
    expect(absent.videoPath).toBe('cellular');
    expect(absent.companionHttpCommandPath).toBe(false);
    expect(absent.flightCommands).toBe(false);

    const mock = run('e3372-status.sh', ['--dry-run', '--mock']);
    expect(mock.status, mock.stderr).toBe(0);
    const mocked = lastJson(mock.stdout);
    expect(mocked.present).toBe(true);
    expect(mocked.state).toBe('mock_present');
    expect(mocked.transport).toBe('mock');

    const bringup = run('e3372-bringup.sh', ['--dry-run']);
    expect(bringup.status, bringup.stderr).toBe(0);
    expect(bringup.stderr || '').not.toMatch(/usb_modeswitch -v/);
    const brought = lastJson(bringup.stdout);
    expect(brought.state === 'modem_absent' || brought.state === 'mock_present').toBe(true);

    const packed = run('pack.sh', ['--dry-run']);
    expect(packed.status, packed.stderr).toBe(0);
    expect(packed.stdout).toMatch(/99-huawei-e3372\.rules/);

    const apply = run('install.sh', ['--apply']);
    expect(apply.status).toBe(1);
    expect(apply.stderr).toMatch(/refusing --apply on a non-Jetson host/);
  });

  it('keeps udev / systemd / modeswitch stubs device-triggered and fail-open', () => {
    const udev = read('udev/99-huawei-e3372.rules');
    expect(udev).toMatch(/12d1/);
    expect(udev).toMatch(/1f01/);
    expect(udev).toMatch(/14dc/);
    expect(udev).toMatch(/usb_modeswitch/);
    expect(udev).toMatch(/SYSTEMD_WANTS.*airvix-e3372-bringup\.service/);

    const statusUnit = read('systemd/airvix-e3372-status.service');
    const bringUnit = read('systemd/airvix-e3372-bringup.service');
    expect(statusUnit).toMatch(/SuccessExitStatus=0/);
    expect(bringUnit).toMatch(/SuccessExitStatus=0/);
    expect(bringUnit).toMatch(/ConditionPathExists=\|\/dev\/cdc-wdm0/);
    expect(bringUnit).not.toMatch(/ConditionPathExists=.*ttyUSB0/);
    expect(statusUnit + bringUnit).not.toMatch(/ExecStart=.*companion|systemctl restart|mavlink_to_fc/i);

    const switchA = read('usb-modeswitch/12d1:1f01');
    expect(switchA).toMatch(/HuaweiNewMode=1/);
    expect(switchA).toMatch(/14dc/);
  });

  it('documents modem_absent / mock and forbids secrets in the pack', () => {
    const readme = read('README.md');
    const env = read('conf/e3372.env.example');
    const docs = fs.readFileSync(path.join(repoRoot, 'docs', 'JETSON_CELLULAR_E3372.md'), 'utf8');
    const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');
    const jetson = fs.readFileSync(path.join(repoRoot, 'docs', 'JETSON_AGENT.md'), 'utf8');
    expect(readme).toMatch(/modem_absent/);
    expect(readme).toMatch(/CELLULAR_MODEM_MOCK/);
    expect(readme).toMatch(/annotated vision video is cellular only/i);
    expect(readme).toMatch(/scp/);
    expect(docs).toMatch(/modem_absent/);
    expect(docs).toMatch(/Do not SSH/);
    expect(commercial).toMatch(/scripts\/jetson-cellular/);
    expect(jetson).toMatch(/scripts\/jetson-cellular/);
    expect(env).not.toMatch(/^\s*(APN|PASSWORD|SECRET|TOKEN|VLC_COMPANION_TOKEN)\s*=\s*\S+/im);
    expect(env).not.toMatch(/100\.82\.59\.45/);
    expect(readme).not.toMatch(/100\.82\.59\.45/);
    expect(docs).not.toMatch(/100\.82\.59\.45/);
  });

  it('leaves console dual-link on the mock / absent path until USB exists', () => {
    expect(ANNOTATED_VIDEO_PATH).toBe('cellular');
    const probe = probeHuaweiE3372({ env: {}, existsSync: () => false });
    expect(probe.present).toBe(false);
    expect(cellularConnectGate({ modemPresent: false, host: '10.0.0.8' }).state).toBe('modem_absent');
    expect(cellularConnectGate({ modemPresent: false, host: '127.0.0.1' }).allowed).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-e3372-'));
    const written = run('e3372-status.sh', ['--write', '--dry-run'], {
      AIRVIX_E3372_STATUS_FILE: path.join(tmp, 'e3372.status'),
      AIRVIX_E3372_DRY_STATUS_FILE: path.join(tmp, 'e3372.status'),
    });
    expect(written.status, written.stderr).toBe(0);
    const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'e3372.status'), 'utf8'));
    expect(disk.state).toBe('modem_absent');
  });
});
