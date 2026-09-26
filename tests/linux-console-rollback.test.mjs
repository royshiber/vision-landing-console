import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'linux', 'update-airvix.sh');

function writeApp(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), 'console.log("server")\n');
  fs.writeFileSync(path.join(dir, 'version.js'), `export const APP_VERSION = '${version}';\n`);
  fs.writeFileSync(path.join(dir, 'restart.sh'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'restart.sh'), 0o755);
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=45123\nKEEP=yes\n');
}

describe('linux updater rollback', () => {
  it('swaps back to the kept tree and preserves .env', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-rb-'));
    const app = path.join(parent, 'console');
    const prev = path.join(parent, 'airvix-rollback', 'console');
    writeApp(app, '1.02.338');
    writeApp(prev, '1.02.335');
    fs.writeFileSync(path.join(app, 'data-marker.txt'), 'current');
    const result = spawnSync('sh', [script, '--rollback'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIRVIX_APP_DIR: app,
        AIRVIX_UPDATE_LOG: path.join(parent, 'update.log'),
        AIRVIX_UPDATE_STATUS: path.join(parent, 'status.json'),
      },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(path.join(app, 'version.js'), 'utf8')).toContain('1.02.335');
    expect(fs.readFileSync(path.join(app, '.env'), 'utf8')).toContain('KEEP=yes');
    expect(fs.readFileSync(path.join(parent, 'airvix-rollback', 'console', 'version.js'), 'utf8')).toContain('1.02.338');
  });

  it('fails without a previous tree and leaves the app in place', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-rb-'));
    const app = path.join(parent, 'console');
    writeApp(app, '1.02.338');
    const result = spawnSync('sh', [script, '--rollback'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIRVIX_APP_DIR: app,
        AIRVIX_UPDATE_LOG: path.join(parent, 'update.log'),
        AIRVIX_UPDATE_STATUS: path.join(parent, 'status.json'),
      },
    });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(app, 'version.js'), 'utf8')).toContain('1.02.338');
  });
});
