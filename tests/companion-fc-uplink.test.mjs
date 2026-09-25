import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionMock } from '../lib/companion-mock.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companion = path.join(repoRoot, 'scripts', 'jetson-companion');

function py(code, extra = {}) {
  const env = { ...process.env, VLC_SKIP_RELAY: '1', ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, 'VLC_FC_SERIAL_NAME')) {
    delete env.VLC_FC_SERIAL_NAME;
  }
  return spawnSync('python3', ['-c', code], {
    cwd: companion,
    encoding: 'utf8',
    env,
  });
}

describe('companion FC label, telemetry, and uplinks', () => {
  it('defaults the FC port label to SERIAL4 and honors VLC_FC_SERIAL_NAME', () => {
    const fallback = py('import companion_agent; print(companion_agent.FC_SERIAL_NAME)');
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(fallback.stdout.trim()).toBe('SERIAL4');
    const override = py('import companion_agent; print(companion_agent.FC_SERIAL_NAME)', {
      VLC_FC_SERIAL_NAME: 'SERIAL9',
    });
    expect(override.status, override.stderr).toBe(0);
    expect(override.stdout.trim()).toBe('SERIAL9');
  });

  it('decodes recorded MAVLink and HiLink fixtures without inventing values', () => {
    const script = path.join(repoRoot, 'tests', 'companion_fc_uplink_check.py');
    const result = spawnSync('python3', [script], {
      encoding: 'utf8',
      env: { ...process.env, VLC_SKIP_RELAY: '1' },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/ok/);
  });

  it('advertises read-only uplinks on the proxy and mock', async () => {
    const proxy = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'companion-proxy-api.mjs'), 'utf8');
    const yaml = fs.readFileSync(
      path.join(repoRoot, 'vendor', 'jetson-companion-api', 'openapi', 'companion-api-v1.yaml'),
      'utf8',
    );
    expect(proxy).toContain('/network/uplinks');
    expect(proxy).not.toMatch(/uplinks\/(enable|disable)/);
    expect(yaml).toContain('/network/uplinks:');
    expect(yaml).toContain('uplinkStatus:');
    const mock = createCompanionMock();
    const health = await mock.getHealth();
    const uplinks = await mock.getNetworkUplinks();
    expect(health.capabilities.uplinkStatus).toBe(true);
    expect(uplinks.read_only).toBe(true);
    expect(uplinks.wifi.up).toBe(false);
    expect(uplinks.wifi.signal_dbm).toBeNull();
    expect(uplinks.cellular.signal.rssi).toBeNull();
    expect(uplinks.default_iface).toBeNull();
  });
});

describe('e3372 boot trigger', () => {
  const script = path.join(repoRoot, 'scripts', 'jetson-cellular', 'e3372-boot-trigger.sh');

  function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3372-boot-'));
    fs.mkdirSync(path.join(root, 'dev'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sys', 'class', 'net'), { recursive: true });
    return root;
  }

  function run(root) {
    return spawnSync(script, [], {
      encoding: 'utf8',
      env: { ...process.env, AIRVIX_E3372_SYS_ROOT: root },
    });
  }

  it('matches cdc-wdm0 or a Huawei enx device and ignores usb0', () => {
    const gadget = tree();
    fs.mkdirSync(path.join(gadget, 'sys', 'class', 'net', 'usb0', 'device'), { recursive: true });
    fs.writeFileSync(
      path.join(gadget, 'sys', 'class', 'net', 'usb0', 'device', 'uevent'),
      'PRODUCT=12d1/14dc/102\n',
    );
    expect(run(gadget).status).toBe(1);
    expect(run(gadget).status).toBe(1);

    const wdm = tree();
    fs.writeFileSync(path.join(wdm, 'dev', 'cdc-wdm0'), '');
    expect(run(wdm).status).toBe(0);

    const hilink = tree();
    const iface = path.join(hilink, 'sys', 'class', 'net', 'enx0c5b8f279a64', 'device');
    fs.mkdirSync(iface, { recursive: true });
    fs.writeFileSync(path.join(iface, 'uevent'), 'PRODUCT=12d1/14dc/102\n');
    expect(run(hilink).status).toBe(0);

    const other = tree();
    const foreign = path.join(other, 'sys', 'class', 'net', 'enxaabbccddeeff', 'device');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'uevent'), 'PRODUCT=0bda/8153/300\n');
    expect(run(other).status).toBe(1);
  });
});
