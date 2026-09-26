import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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

  it('keeps a sibling failed copy, uses the app port, and kills only this install', async () => {
    const text = fs.readFileSync(script, 'utf8');
    const restart = fs.readFileSync(path.join(repoRoot, 'restart.sh'), 'utf8');
    expect(text).not.toContain('fuser');
    expect(text).not.toContain('3090');
    expect(text).toContain('4010');
    expect(text).toContain('console.pid');
    expect(restart).not.toContain('fuser');
    expect(restart).not.toContain('3090');
    expect(restart).toContain('4010');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-rb-'));
    const app = path.join(parent, 'console');
    const prev = path.join(parent, 'airvix-rollback', 'console');
    const sibling = path.join(parent, 'airvix-failed');
    writeApp(app, '1.02.338');
    writeApp(prev, '1.02.335');
    const ranRestart = path.join(parent, 'ran-old-restart');
    const ranServer = path.join(parent, 'ran-server');
    const oldRestart = `#!/bin/sh\necho ran > ${ranRestart}\n`;
    fs.writeFileSync(path.join(prev, 'restart.sh'), oldRestart);
    fs.writeFileSync(path.join(app, 'restart.sh'), oldRestart);
    fs.writeFileSync(path.join(prev, 'server.js'), `require('fs').writeFileSync(${JSON.stringify(ranServer)}, 'yes');\n`);
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'stay');
    fs.mkdirSync(path.join(app, 'data'), { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], {
      cwd: app,
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(app, 'data', 'console.pid'), `${child.pid}\n`);
    const py = spawn('python3', ['-m', 'http.server', '45123', '--bind', '127.0.0.1'], {
      cwd: os.tmpdir(),
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const env = {
      ...process.env,
      AIRVIX_APP_DIR: app,
      AIRVIX_UPDATE_LOG: path.join(parent, 'update.log'),
      AIRVIX_UPDATE_STATUS: path.join(parent, 'status.json'),
    };
    delete env.PORT;
    const result = spawnSync('sh', [script, '--rollback'], { encoding: 'utf8', env });
    let portAlive = false;
    try {
      const probe = await fetch('http://127.0.0.1:45123/');
      portAlive = probe.status === 200;
    } catch { portAlive = false; }
    py.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 1000);
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(child.signalCode === 'SIGTERM' || child.exitCode !== null).toBe(true);
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    expect(portAlive).toBe(true);
    expect(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8')).toBe('stay');
    expect(fs.readFileSync(path.join(parent, 'update.log'), 'utf8')).toContain('port 45123');
    expect(text).not.toContain('sh ./restart.sh');
    expect(fs.existsSync(path.join(parent, 'ran-old-restart'))).toBe(false);
    expect(fs.readFileSync(path.join(parent, 'ran-server'), 'utf8')).toBe('yes');
    const names = fs.readdirSync(path.join(parent, 'airvix-rollback'));
    expect(names.some((name) => name.startsWith('failed-') || name.startsWith('outgoing-') || name.startsWith('replaced-') || name === 'console')).toBe(true);
  });
});
