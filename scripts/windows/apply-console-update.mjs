/**
 * Light update for the Windows AIRVIX console.
 * Downloads the merged master tree, installs it beside the live console,
 * then swaps only the code. .env, data, and var are moved aside and back
 * by rename, never rewritten. Restart is the existing run-server.bat on
 * 127.0.0.1:4010. A failed prepare leaves that server running. A failed
 * swap or health check puts the previous tree back and starts it again.
 * Does not expand a zip. Does not edit companion, Tailscale, DNS,
 * arming, or flight commands, and does not start a second server.
 */

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const PRESERVE = Object.freeze(['.env', 'data', 'var']);
export const RELEASE_TARBALL_URL = 'https://codeload.github.com/royshiber/vision-landing-console/tar.gz/refs/heads/master';
export const DEFAULT_PORT = 4010;

const ILLEGAL_WIN_NAME = /[:*?"<>|]/;

export function readAppVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'version.js'), 'utf8');
    const match = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
  const n = Math.max(pa.length, pb.length, 1);
  for (let i = 0; i < n; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function readListenPort(appDir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(appDir, '.env'), 'utf8');
  } catch {
    return DEFAULT_PORT;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*PORT\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^\d+$/.test(value)) return Number(value);
  }
  return DEFAULT_PORT;
}

function walkPreserve(abs, root, out) {
  const stat = fs.lstatSync(abs);
  const rel = path.relative(root, abs);
  if (stat.isSymbolicLink()) {
    out.push({ rel, type: 'link', hash: fs.readlinkSync(abs) });
    return;
  }
  if (stat.isDirectory()) {
    out.push({ rel, type: 'dir' });
    for (const name of fs.readdirSync(abs).sort()) walkPreserve(path.join(abs, name), root, out);
    return;
  }
  if (stat.isFile()) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    out.push({ rel, type: 'file', hash, size: stat.size });
  }
}

export function preserveManifest(appDir, names = PRESERVE) {
  const out = [];
  for (const name of names) {
    const abs = path.join(appDir, name);
    if (!fs.existsSync(abs)) {
      out.push({ rel: name, type: 'missing' });
      continue;
    }
    walkPreserve(abs, appDir, out);
  }
  return out;
}

export function manifestsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function safeRelative(name) {
  const rel = String(name || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  const parts = rel.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

export function entryOutputPath(destDir, rel, platform = process.platform) {
  const safe = safeRelative(rel);
  if (!safe) return null;
  if (platform === 'win32' && ILLEGAL_WIN_NAME.test(safe)) return null;
  if (platform === 'win32') {
    const full = path.win32.resolve(String(destDir).replace(/\//g, '\\'), ...safe.split('/'));
    const root = path.win32.resolve(String(destDir).replace(/\//g, '\\'));
    const prefix = root.endsWith('\\') ? root : `${root}\\`;
    if (full !== root && !full.startsWith(prefix)) return null;
    return full.startsWith('\\\\?\\') ? full : `\\\\?\\${full}`;
  }
  const full = path.resolve(destDir, ...safe.split('/'));
  const root = path.resolve(destDir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function readOctal(buf, start, len) {
  const text = buf.toString('utf8', start, start + len).replace(/\0.*$/, '').trim();
  if (!text) return 0;
  return parseInt(text, 8) || 0;
}

function headerChecksumOk(buf) {
  const stated = readOctal(buf, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 32 : buf[i];
  return sum === stated;
}

function headerName(buf) {
  const name = buf.toString('utf8', 0, 100).replace(/\0.*$/, '');
  const prefix = buf.toString('utf8', 345, 500).replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

function parsePaxPath(buf) {
  const text = buf.toString('utf8');
  let i = 0;
  let found = null;
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space < 0) break;
    const len = parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(space + 1, i + len);
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') found = rec.slice(eq + 1).replace(/\n$/, '');
    i += len;
  }
  return found;
}

function writeExtracted(destDir, rel, data, platform) {
  const out = entryOutputPath(destDir, rel, platform);
  if (!out) return false;
  const diskPath = platform === 'win32' && process.platform !== 'win32'
    ? path.resolve(destDir, ...safeRelative(rel).split('/'))
    : out;
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, data);
  return true;
}

export async function extractTarGz(archivePath, destDir, opts = {}) {
  const platform = opts.platform || process.platform;
  await fs.promises.mkdir(destDir, { recursive: true });
  const tarPath = `${destDir}.unpack.tar`;
  await pipeline(fs.createReadStream(archivePath), zlib.createGunzip(), fs.createWriteStream(tarPath));
  const fh = await fs.promises.open(tarPath, 'r');
  const header = Buffer.alloc(512);
  let pos = 0;
  let pendingName = null;
  try {
    while (true) {
      const read = await fh.read(header, 0, 512, pos);
      if (read.bytesRead < 512) break;
      pos += 512;
      if (header.every((byte) => byte === 0)) break;
      if (!headerChecksumOk(header)) throw new Error('bad tar header');
      const size = readOctal(header, 124, 12);
      const type = header[156];
      const data = Buffer.alloc(size);
      if (size > 0) {
        const body = await fh.read(data, 0, size, pos);
        if (body.bytesRead < size) throw new Error('truncated tar entry');
      }
      pos += Math.ceil(size / 512) * 512;
      if (type === 76) {
        pendingName = data.toString('utf8').replace(/\0.*$/, '');
        continue;
      }
      if (type === 120) {
        pendingName = parsePaxPath(data) || pendingName;
        continue;
      }
      if (type === 103) continue;
      const name = pendingName || headerName(header);
      pendingName = null;
      if (type === 53) {
        const rel = safeRelative(name);
        if (!rel) continue;
        if (platform === 'win32' && ILLEGAL_WIN_NAME.test(rel)) continue;
        const dir = entryOutputPath(destDir, rel, platform);
        const disk = platform === 'win32' && process.platform !== 'win32'
          ? path.resolve(destDir, ...rel.split('/'))
          : dir;
        if (disk) fs.mkdirSync(disk, { recursive: true });
        continue;
      }
      if (type !== 0 && type !== 48) continue;
      writeExtracted(destDir, name, data, platform);
    }
  } finally {
    await fh.close();
    await fs.promises.rm(tarPath, { force: true });
  }
}

export function findConsoleRoot(destDir) {
  if (fs.existsSync(path.join(destDir, 'server.js'))) return destDir;
  for (const name of fs.readdirSync(destDir)) {
    const candidate = path.join(destDir, name);
    if (fs.existsSync(path.join(candidate, 'server.js'))) return candidate;
  }
  return null;
}

export function shouldStopProcess({ pid, pidFilePid, commandLine, cwd, appDir }) {
  const id = Number(pid);
  const expected = Number(pidFilePid);
  if (!id || id !== expected) return false;
  const cmd = String(commandLine || '');
  if (cmd.includes('apply-console-update.mjs')) return false;
  if (!cmd.includes('server.js')) return false;
  if (cwd) {
    const root = path.resolve(appDir);
    const dir = path.resolve(cwd);
    if (dir !== root && !dir.startsWith(root + path.sep)) return false;
  }
  return true;
}

export function windowsLauncherPath(appDir) {
  const dir = path.win32.resolve(String(appDir).replace(/\//g, '\\'));
  return path.win32.join(path.win32.dirname(dir), 'run-server.bat');
}

export function windowsLauncherCommand(appDir) {
  const bat = windowsLauncherPath(appDir);
  return {
    file: 'cmd.exe',
    args: ['/d', '/c', 'start', 'AIRVIX', '/min', bat],
    secondServer: false,
    host: '127.0.0.1',
    port: DEFAULT_PORT,
  };
}

async function renameRetry(from, to) {
  let last = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw last;
}

function emptyJournal() {
  return {
    hold: null,
    lifted: [],
    appMovedTo: null,
    stageAtApp: false,
    olderRollback: null,
    preserveOnApp: false,
    discard: null,
  };
}

async function swapTree({ appDir, stageDir, rollbackDir, preserve, journal }) {
  const parent = path.dirname(appDir);
  const hold = path.join(parent, `update-hold-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(hold, { recursive: true });
  journal.hold = hold;
  for (const name of preserve) {
    const src = path.join(appDir, name);
    if (!fs.existsSync(src)) continue;
    await fs.promises.rename(src, path.join(hold, name));
    journal.lifted.push(name);
  }
  if (fs.existsSync(rollbackDir)) {
    const older = `${rollbackDir}-older-${Date.now()}`;
    await renameRetry(rollbackDir, older);
    journal.olderRollback = older;
  }
  await renameRetry(appDir, rollbackDir);
  journal.appMovedTo = rollbackDir;
  await renameRetry(stageDir, appDir);
  journal.stageAtApp = true;
  const discard = path.join(parent, `update-discard-${process.pid}-${Date.now()}`);
  for (const name of preserve) {
    const incoming = path.join(appDir, name);
    if (fs.existsSync(incoming)) {
      await fs.promises.mkdir(discard, { recursive: true });
      await fs.promises.rename(incoming, path.join(discard, name));
      journal.discard = discard;
    }
    const kept = path.join(hold, name);
    if (fs.existsSync(kept)) await fs.promises.rename(kept, path.join(appDir, name));
  }
  journal.preserveOnApp = true;
}

async function restoreTree({ appDir, rollbackDir, preserve, journal }) {
  if (journal.preserveOnApp && journal.hold && fs.existsSync(appDir)) {
    for (const name of preserve) {
      const live = path.join(appDir, name);
      const held = path.join(journal.hold, name);
      if (fs.existsSync(live) && !fs.existsSync(held)) await fs.promises.rename(live, held);
    }
    journal.preserveOnApp = false;
  }
  let failedDir = null;
  if (journal.stageAtApp && fs.existsSync(appDir)) {
    failedDir = path.join(path.dirname(appDir), `update-failed-${Date.now()}`);
    await renameRetry(appDir, failedDir);
    journal.stageAtApp = false;
  }
  if (journal.appMovedTo && fs.existsSync(journal.appMovedTo) && !fs.existsSync(appDir)) {
    await renameRetry(journal.appMovedTo, appDir);
    journal.appMovedTo = null;
  }
  if (journal.hold && fs.existsSync(appDir)) {
    for (const name of preserve) {
      const held = path.join(journal.hold, name);
      if (!fs.existsSync(held)) continue;
      const live = path.join(appDir, name);
      if (fs.existsSync(live)) {
        const trash = path.join(path.dirname(appDir), `update-discard-${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
        await fs.promises.mkdir(path.dirname(trash), { recursive: true });
        await fs.promises.rename(live, path.basename(trash) === name ? `${trash}.new` : trash);
      }
      await fs.promises.rename(held, path.join(appDir, name));
    }
  }
  if (journal.olderRollback && !fs.existsSync(rollbackDir)) {
    await renameRetry(journal.olderRollback, rollbackDir);
    journal.olderRollback = null;
  }
  if (failedDir) await fs.promises.rm(failedDir, { recursive: true, force: true });
  if (journal.discard) await fs.promises.rm(journal.discard, { recursive: true, force: true });
  if (journal.hold && fs.existsSync(journal.hold) && fs.readdirSync(journal.hold).length === 0) {
    await fs.promises.rm(journal.hold, { recursive: true, force: true });
  }
}

async function pruneSuccess(journal) {
  if (journal.olderRollback) await fs.promises.rm(journal.olderRollback, { recursive: true, force: true });
  if (journal.discard) await fs.promises.rm(journal.discard, { recursive: true, force: true });
  if (journal.hold) await fs.promises.rm(journal.hold, { recursive: true, force: true });
}

export async function applyStagedConsoleUpdate(opts) {
  const appDir = path.resolve(opts.appDir);
  const stageDir = path.resolve(opts.stageDir);
  const preserve = opts.preserve || PRESERVE;
  const rollbackDir = opts.rollbackDir || path.join(path.dirname(appDir), 'rollback');
  const expected = readAppVersion(stageDir);
  if (!fs.existsSync(path.join(stageDir, 'server.js')) || stageDir === appDir) {
    return {
      ok: false,
      phase: 'prepare',
      preserved: true,
      running: true,
      runningVersion: readAppVersion(appDir),
      error: 'stage is not a console tree',
    };
  }

  const journal = emptyJournal();
  let stopped = false;
  let started = false;
  let before = null;

  try {
    await opts.stopServer();
    stopped = true;
    before = preserveManifest(appDir, preserve);
    await swapTree({ appDir, stageDir, rollbackDir, preserve, journal });
    const after = preserveManifest(appDir, preserve);
    if (!manifestsEqual(before, after)) throw new Error('preserve mismatch');
    await opts.startServer();
    started = true;
    const health = await opts.healthCheck();
    if (!health?.ok || (expected && health.version !== expected)) throw new Error('health failed');
    await pruneSuccess(journal);
    return { ok: true, phase: 'done', preserved: true, running: true, runningVersion: expected, version: expected };
  } catch (err) {
    if (started) {
      try { await opts.stopServer(); } catch { /* the restart below brings the old tree back */ }
    }
    let restored = !stopped;
    if (stopped) {
      try {
        await restoreTree({ appDir, rollbackDir, preserve, journal });
        await opts.startServer();
        restored = true;
      } catch {
        restored = false;
      }
    }
    const now = preserveManifest(appDir, preserve);
    return {
      ok: false,
      phase: stopped ? 'rollback' : 'stop',
      preserved: before ? manifestsEqual(before, now) : true,
      running: restored,
      runningVersion: readAppVersion(appDir),
      error: err?.message || 'update failed',
    };
  }
}

export async function updateConsoleRelease(opts) {
  const before = preserveManifest(opts.appDir, opts.preserve || PRESERVE);
  try {
    if (typeof opts.prepareStage === 'function') await opts.prepareStage();
  } catch (err) {
    return {
      ok: false,
      phase: 'prepare',
      preserved: manifestsEqual(before, preserveManifest(opts.appDir, opts.preserve || PRESERVE)),
      running: true,
      runningVersion: readAppVersion(opts.appDir),
      error: err?.message || 'prepare failed',
    };
  }
  if (!opts.stageDir) {
    return {
      ok: false,
      phase: 'prepare',
      preserved: true,
      running: true,
      runningVersion: readAppVersion(opts.appDir),
      error: 'no stage',
    };
  }
  return applyStagedConsoleUpdate(opts);
}

function readPid(appDir) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(appDir, 'data', 'console.pid'), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readProcessInfo(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return { commandLine: '', cwd: '' };
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${id}").CommandLine`,
      ], { encoding: 'utf8' });
      return { commandLine: String(out || '').trim(), cwd: '' };
    } catch {
      return { commandLine: '', cwd: '' };
    }
  }
  try {
    const commandLine = fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').replace(/\0/g, ' ');
    let cwd = '';
    try { cwd = fs.readlinkSync(`/proc/${id}/cwd`); } catch { /* cwd is optional */ }
    return { commandLine, cwd };
  } catch {
    return { commandLine: '', cwd: '' };
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('console process did not exit');
}

export async function stopIdentifiedServer(appDir, { required = true } = {}) {
  const pid = readPid(appDir);
  if (!pid) {
    if (required) throw new Error('console pid missing');
    return;
  }
  const info = readProcessInfo(pid);
  if (!shouldStopProcess({ pid, pidFilePid: pid, commandLine: info.commandLine, cwd: info.cwd, appDir })) {
    if (required) throw new Error('console process not identified');
    return;
  }
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/F']);
  else process.kill(pid, 'SIGTERM');
  await waitDead(pid);
}

function portBusy(port) {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    return new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
  } catch {
    return false;
  }
}

export function startExistingLauncher(appDir) {
  if (process.platform !== 'win32') throw new Error('the console server is started by run-server.bat');
  const plan = windowsLauncherCommand(appDir);
  const bat = plan.args[plan.args.length - 1];
  if (!fs.existsSync(bat)) throw new Error('run-server.bat missing');
  const port = readListenPort(appDir);
  if (portBusy(port)) throw new Error('port busy');
  const child = spawn(plan.file, plan.args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: path.win32.dirname(bat),
  });
  child.unref();
}

async function waitForHealth(appDir, expected) {
  const port = readListenPort(appDir);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      const body = await res.json();
      if (body?.ok && body.version === expected) return { ok: true, version: body.version };
    } catch {
      /* the server is still coming back */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, version: null };
}

function npmCi(dir) {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
    delete env.NODE_ENV;
    const child = spawn(npm, ['ci', '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `npm ci exited ${code}`));
    });
  });
}

async function downloadFile(url, dest) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'airvix-console' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const { Readable } = await import('node:stream');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw last || new Error('download failed');
}

function writeStatus(statusPath, state, error, logPath) {
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, `${JSON.stringify({ state, error, logPath })}\n`);
  } catch {
    /* status is best-effort */
  }
}

function logLine(logPath, line) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    /* log is best-effort */
  }
}

export async function runWindowsConsoleUpdate(env = process.env) {
  const appDir = path.resolve(env.AIRVIX_APP_DIR || process.cwd());
  const parent = path.dirname(appDir);
  const logPath = env.AIRVIX_UPDATE_LOG || path.join(parent, 'update.log');
  const statusPath = env.AIRVIX_UPDATE_STATUS || path.join(parent, 'update-status.json');
  const failed = 'העדכון נכשל. הגרסה הקודמת נשארה.';
  writeStatus(statusPath, 'applying', '', logPath);
  logLine(logPath, 'prepare release tarball');
  const work = path.join(parent, 'update-work');
  const unpack = path.join(work, 'unpack');
  try {
    await fs.promises.rm(unpack, { recursive: true, force: true });
    await fs.promises.mkdir(work, { recursive: true });
    const archive = path.join(work, 'release.tar.gz');
    await downloadFile(RELEASE_TARBALL_URL, archive);
    logLine(logPath, 'extract=tar');
    await extractTarGz(archive, unpack, { platform: 'win32' });
    const src = findConsoleRoot(unpack);
    if (!src) throw new Error('archive missing server.js');
    const next = readAppVersion(src);
    const current = readAppVersion(appDir);
    if (!next || compareVersions(next, current) <= 0) throw new Error('not newer');
    logLine(logPath, 'npm-ci=stage');
    await npmCi(src);
    let stops = 0;
    const result = await applyStagedConsoleUpdate({
      appDir,
      stageDir: src,
      stopServer: async () => {
        stops += 1;
        await stopIdentifiedServer(appDir, { required: stops === 1 });
      },
      startServer: async () => startExistingLauncher(appDir),
      healthCheck: () => waitForHealth(appDir, next),
    });
    if (!result.ok || !result.preserved) {
      logLine(logPath, `rollback ${result.error || ''}`);
      writeStatus(statusPath, 'failed', failed, logPath);
      return result;
    }
    writeStatus(statusPath, 'ok', '', logPath);
    logLine(logPath, `updated ${current} -> ${next}`);
    return result;
  } catch (err) {
    logLine(logPath, `prepare failed ${err?.message || ''}`);
    writeStatus(statusPath, 'failed', failed, logPath);
    return { ok: false, phase: 'prepare', running: true, preserved: true, error: err?.message || 'prepare failed' };
  } finally {
    await fs.promises.rm(path.join(work, 'release.tar.gz'), { force: true }).catch(() => {});
    await fs.promises.rm(unpack, { recursive: true, force: true }).catch(() => {});
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runWindowsConsoleUpdate().then((result) => {
    process.exitCode = result?.ok ? 0 : 1;
  }).catch(() => {
    process.exitCode = 1;
  });
}
