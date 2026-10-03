import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRESERVE,
  RELEASE_TARBALL_URL,
  compareVersions,
  entryOutputPath,
  extractTarGz,
  readAppVersion,
  readListenPort,
  shouldStopProcess,
  updateConsoleRelease,
  windowsLauncherCommand,
  windowsLauncherPath,
} from '../scripts/windows/apply-console-update.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveEnv = [
  'PORT=4010',
  'ELEVENLABS_API_KEY=sk-live-secret',
  'ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB',
  '',
].join('\n');

function bytesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = path.relative(dir, abs);
    if (fs.statSync(abs).isDirectory()) {
      for (const [child, buf] of bytesUnder(abs)) out.push([path.join(rel, child), buf]);
    } else {
      out.push([rel, fs.readFileSync(abs)]);
    }
  }
  return out;
}

function keptBytes(app) {
  return {
    env: fs.readFileSync(path.join(app, '.env')),
    data: bytesUnder(path.join(app, 'data')),
    varFiles: bytesUnder(path.join(app, 'var')),
  };
}

function expectSameBytes(actual, expected) {
  expect(Buffer.compare(actual.env, expected.env)).toBe(0);
  expect(actual.data.map(([name]) => name)).toEqual(expected.data.map(([name]) => name));
  actual.data.forEach((row, i) => expect(Buffer.compare(row[1], expected.data[i][1])).toBe(0));
  expect(actual.varFiles.map(([name]) => name)).toEqual(expected.varFiles.map(([name]) => name));
  actual.varFiles.forEach((row, i) => expect(Buffer.compare(row[1], expected.varFiles[i][1])).toBe(0));
}

function writeConsole(dir, version, serverBody, envBody) {
  fs.mkdirSync(path.join(dir, 'data', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'var'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), serverBody);
  fs.writeFileSync(path.join(dir, 'version.js'), `export const APP_VERSION = '${version}';\n`);
  fs.writeFileSync(path.join(dir, '.env'), envBody);
  fs.writeFileSync(path.join(dir, 'data', 'nested', 'keep.bin'), Buffer.from([0, 1, 255, 10, 13, 65]));
  fs.writeFileSync(path.join(dir, 'data', 'console.pid'), '4242\n');
  fs.writeFileSync(path.join(dir, 'var', 'state.txt'), 'voice-cache\n');
}

function layout() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-win-update-'));
  const app = path.join(parent, 'console');
  const stage = path.join(parent, 'stage');
  writeConsole(app, '1.02.10', 'old-server\n', liveEnv);
  writeConsole(stage, '1.02.11', 'new-server\n', 'PORT=4010\nELEVENLABS_API_KEY=replaced\n');
  fs.writeFileSync(path.join(stage, 'data', 'evil.txt'), 'do-not-keep');
  return { parent, app, stage };
}

describe('windows console release update', () => {
  it('keeps settings and data byte for byte and leaves the new version running', async () => {
    const { app, stage } = layout();
    const before = keptBytes(app);
    const envBefore = fs.readFileSync(path.join(app, '.env'));
    const running = { up: true, version: '1.02.10', starts: [] };
    const result = await updateConsoleRelease({
      appDir: app,
      stageDir: stage,
      stopServer: async () => { running.up = false; },
      startServer: async () => {
        running.up = true;
        running.version = readAppVersion(app);
        running.starts.push(running.version);
      },
      healthCheck: async () => ({ ok: running.up, version: running.version }),
    });
    expect(result.ok).toBe(true);
    expect(result.preserved).toBe(true);
    expect(result.running).toBe(true);
    expect(result.runningVersion).toBe('1.02.11');
    expect(fs.readFileSync(path.join(app, 'server.js'), 'utf8')).toBe('new-server\n');
    expectSameBytes(keptBytes(app), before);
    expect(Buffer.compare(fs.readFileSync(path.join(app, '.env')), envBefore)).toBe(0);
    expect(fs.existsSync(path.join(app, 'data', 'evil.txt'))).toBe(false);
    expect(readListenPort(app)).toBe(4010);
    expect(running.up).toBe(true);
    expect(running.starts).toEqual(['1.02.11']);
    expect(PRESERVE).toEqual(['.env', 'data', 'var']);
  });

  it('leaves the old version running and settings untouched when the new server does not come back', async () => {
    const { parent, app, stage } = layout();
    const before = keptBytes(app);
    const running = { up: true, version: '1.02.10', starts: [] };
    let stops = 0;
    const result = await updateConsoleRelease({
      appDir: app,
      stageDir: stage,
      stopServer: async () => {
        stops += 1;
        running.up = false;
      },
      startServer: async () => {
        running.up = true;
        running.version = readAppVersion(app);
        running.starts.push(running.version);
      },
      healthCheck: async () => ({ ok: false, version: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('rollback');
    expect(result.preserved).toBe(true);
    expect(result.running).toBe(true);
    expect(result.runningVersion).toBe('1.02.10');
    expect(fs.readFileSync(path.join(app, 'server.js'), 'utf8')).toBe('old-server\n');
    expect(readAppVersion(app)).toBe('1.02.10');
    expectSameBytes(keptBytes(app), before);
    expect(fs.existsSync(path.join(app, 'data', 'evil.txt'))).toBe(false);
    expect(running.up).toBe(true);
    expect(running.version).toBe('1.02.10');
    expect(running.starts.at(-1)).toBe('1.02.10');
    expect(stops).toBeGreaterThan(0);
    expect(fs.readdirSync(parent).some((name) => name.startsWith('update-failed'))).toBe(false);
  });

  it('does not stop the running server when prepare fails', async () => {
    const { app } = layout();
    const before = keptBytes(app);
    let stopped = false;
    let started = false;
    const result = await updateConsoleRelease({
      appDir: app,
      prepareStage: async () => { throw new Error('download failed'); },
      stopServer: async () => { stopped = true; },
      startServer: async () => { started = true; },
      healthCheck: async () => ({ ok: false, version: null }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('prepare');
    expect(result.running).toBe(true);
    expect(result.preserved).toBe(true);
    expect(result.runningVersion).toBe('1.02.10');
    expect(stopped).toBe(false);
    expect(started).toBe(false);
    expect(fs.readFileSync(path.join(app, 'server.js'), 'utf8')).toBe('old-server\n');
    expectSameBytes(keptBytes(app), before);
  });

  it('restarts only through run-server.bat and skips a different process', () => {
    const app = 'C:\\Users\\shibe\\AppData\\Local\\AIRVIX\\console';
    expect(windowsLauncherPath(app)).toBe('C:\\Users\\shibe\\AppData\\Local\\AIRVIX\\run-server.bat');
    const command = windowsLauncherCommand(app);
    expect(command.file).toBe('cmd.exe');
    expect(command.args.at(-1)).toBe('C:\\Users\\shibe\\AppData\\Local\\AIRVIX\\run-server.bat');
    expect(command.args.join(' ')).not.toContain('server.js');
    expect(command.secondServer).toBe(false);
    expect(command.host).toBe('127.0.0.1');
    expect(command.port).toBe(4010);
    expect(shouldStopProcess({
      pid: 50,
      pidFilePid: 50,
      commandLine: 'node.exe server.js',
      cwd: '',
      appDir: app,
    })).toBe(true);
    expect(shouldStopProcess({
      pid: 50,
      pidFilePid: 99,
      commandLine: 'node.exe server.js',
      cwd: '',
      appDir: app,
    })).toBe(false);
    expect(shouldStopProcess({
      pid: 50,
      pidFilePid: 50,
      commandLine: 'node.exe apply-console-update.mjs',
      cwd: '',
      appDir: app,
    })).toBe(false);
  });

  it('extracts a long path from a gzip tarball and skips names Windows cannot store', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-tar-'));
    const top = path.join(root, 'vision-landing-console');
    const longName = 'n'.repeat(220);
    fs.mkdirSync(path.join(top, longName), { recursive: true });
    fs.writeFileSync(path.join(top, longName, 'file.txt'), 'long-ok');
    fs.writeFileSync(path.join(top, 'server.js'), 'srv');
    fs.writeFileSync(path.join(top, 'bad:name.txt'), 'nope');
    const archive = path.join(root, 'release.tar.gz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'vision-landing-console'], { encoding: 'utf8' });
    expect(packed.status).toBe(0);
    const dest = path.join(root, 'out');
    await extractTarGz(archive, dest, { platform: 'win32' });
    expect(fs.readFileSync(path.join(dest, 'vision-landing-console', longName, 'file.txt'), 'utf8')).toBe('long-ok');
    expect(fs.existsSync(path.join(dest, 'vision-landing-console', 'bad:name.txt'))).toBe(false);
    const winPath = entryOutputPath(
      'C:\\Users\\shibe\\AppData\\Local\\AIRVIX\\update-stage',
      `${longName}/file.txt`,
      'win32',
    );
    expect(winPath.startsWith('\\\\?\\')).toBe(true);
    expect(winPath.length).toBeGreaterThan(260);
    expect(entryOutputPath('C:\\Users\\shibe\\AppData\\Local\\AIRVIX\\update-stage', 'bad:name.txt', 'win32')).toBe(null);
    expect(entryOutputPath('C:\\AIRVIX\\stage', '../outside.txt', 'win32')).toBe(null);
  });

  it('points the Windows button at one Hebrew action and the merged tarball', () => {
    const updater = fs.readFileSync(path.join(repoRoot, 'scripts', 'windows', 'apply-console-update.mjs'), 'utf8');
    const ps1 = fs.readFileSync(path.join(repoRoot, 'scripts', 'windows', 'install-airvix.ps1'), 'utf8');
    const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    const glossary = fs.readFileSync(path.join(repoRoot, 'docs', 'hebrew-copy-glossary.md'), 'utf8');
    expect(updater).not.toContain('Expand-Archive');
    expect(ps1).not.toContain('Expand-Archive');
    expect(RELEASE_TARBALL_URL).toContain('tar.gz/refs/heads/master');
    expect(RELEASE_TARBALL_URL).not.toContain('.zip');
    expect(updater).not.toContain('JETSON_COMPANION_BASE_URL');
    const main = ps1.slice(ps1.indexOf('function Invoke-Main'));
    const handoff = main.indexOf('apply-console-update.mjs');
    const envWrite = main.indexOf('Update-EnvFile');
    expect(handoff).toBeGreaterThan(0);
    expect(handoff).toBeLessThan(envWrite);
    expect(main.slice(handoff, envWrite)).toContain('exit $LASTEXITCODE');
    expect(main.slice(handoff, envWrite)).not.toContain('JETSON_COMPANION');
    expect(html).toContain('>עדכנו עכשיו<');
    expect(html).not.toContain('עדכן עכשיו');
    expect(js).toContain('עדכנו עכשיו');
    expect(js).toContain('אשרו עדכון');
    expect(js).not.toContain('אשר עדכון');
    expect(js).not.toContain('עדכן עכשיו');
    expect(glossary).toContain('| עדכנו | עדכן |');
    expect(glossary).toContain('| אשרו | אשר |');
    expect(compareVersions('1.02.11', '1.02.10')).toBe(1);
  });
});
