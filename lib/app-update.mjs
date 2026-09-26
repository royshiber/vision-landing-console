/**
 * In-app update check and detached apply.
 * Never reads or writes .env, data/, var/, or secrets.
 * Apply is refused while the aircraft is armed or in flight.
 */

import { spawn } from 'child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { isFcArmed } from './advisor-apply.mjs';
import { logger } from './logger.mjs';

export const UPDATE_PRESERVE = Object.freeze(['.env', 'data', 'var', 'node_modules']);
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const IN_FLIGHT_REL_ALT_M = 2;
export const RAW_VERSION_JSON = 'https://raw.githubusercontent.com/royshiber/vision-landing-console/master/version.json';
export const RAW_VERSION_JS = 'https://raw.githubusercontent.com/royshiber/vision-landing-console/master/version.js';
export const COMMITS_URL = 'https://api.github.com/repos/royshiber/vision-landing-console/commits?sha=master&per_page=20';

const BLOCKED_HE = Object.freeze({
  armed: 'העדכון חסום כי המטוס חמוש.',
  in_flight: 'העדכון חסום כי המטוס באוויר.',
  unknown_connected: 'מצב הטיסה לא ידוע למרות שיש חיבור. אשר שוב כדי לעדכן.',
});

export function parseVersionParts(value) {
  return String(value || '')
    .trim()
    .split('.')
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** @returns {-1|0|1} */
export function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const n = Math.max(pa.length, pb.length, 1);
  for (let i = 0; i < n; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  return compareVersions(latest, current) > 0;
}

export function parseVersionPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const v = String(data?.version || '').trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  } catch {
    /* version.js text */
  }
  const m = raw.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

export function isLoopbackRequest(req) {
  const raw = String(req?.socket?.remoteAddress || req?.ip || '');
  const host = raw.replace(/^::ffff:/i, '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Armed or airborne blocks apply.
 * Connected with unknown arm state needs a second confirmation.
 */
export function assessUpdateSafety(mavConn, { confirmUnknown = false } = {}) {
  const connected = !!(mavConn && mavConn.connected);
  const armed = isFcArmed(mavConn);
  const rel = mavConn?.lastGlobalPos?.relativeAltM;
  const gs = mavConn?.lastGlobalPos?.groundspeedMs;
  const airborne = (Number.isFinite(rel) && rel > IN_FLIGHT_REL_ALT_M)
    || (Number.isFinite(gs) && gs > 1.5 && Number.isFinite(rel) && rel > 0.5);
  if (armed === true) {
    return { allowed: false, blockedReason: 'armed', needsConfirmation: false, message: BLOCKED_HE.armed };
  }
  if (airborne) {
    return { allowed: false, blockedReason: 'in_flight', needsConfirmation: false, message: BLOCKED_HE.in_flight };
  }
  const unknown = connected && armed == null && !Number.isFinite(rel);
  if (unknown && !confirmUnknown) {
    return {
      allowed: false,
      blockedReason: 'unknown_connected',
      needsConfirmation: true,
      message: BLOCKED_HE.unknown_connected,
    };
  }
  return { allowed: true, blockedReason: null, needsConfirmation: false, message: null };
}

export function defaultUpdateLogPath() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'AIRVIX', 'update.log');
  }
  return path.join(os.tmpdir(), 'airvix-update.log');
}

export function defaultUpdateStatusPath() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'AIRVIX', 'update-status.json');
  }
  return path.join(os.tmpdir(), 'airvix-update-status.json');
}

export function buildUpdaterLaunch({ platform = process.platform, appRoot, logPath, statusPath } = {}) {
  const root = appRoot || process.cwd();
  if (platform === 'win32') {
    const script = path.join(root, 'scripts', 'windows', 'install-airvix.ps1');
    return {
      platform,
      script,
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-UpdateOnly'],
      cwd: root,
      logPath: logPath || defaultUpdateLogPath(),
      statusPath: statusPath || defaultUpdateStatusPath(),
      env: {},
    };
  }
  const script = path.join(root, 'scripts', 'linux', 'update-airvix.sh');
  const log = logPath || defaultUpdateLogPath();
  const status = statusPath || defaultUpdateStatusPath();
  return {
    platform: 'linux',
    script,
    command: 'bash',
    args: [script],
    cwd: root,
    logPath: log,
    statusPath: status,
    env: {
      AIRVIX_APP_DIR: root,
      AIRVIX_UPDATE_LOG: log,
      AIRVIX_UPDATE_STATUS: status,
    },
  };
}

function stageScript(scriptPath) {
  const dir = path.join(os.tmpdir(), 'airvix-updater');
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(scriptPath));
  copyFileSync(scriptPath, dest);
  return dest;
}

export function readUpdateStatusFile(statusPath) {
  try {
    const data = JSON.parse(readFileSync(statusPath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeUpdateStatusFile(statusPath, payload) {
  try {
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    /* status file is best-effort */
  }
}

function commitSubjects(commits, current) {
  const subjects = [];
  const cur = String(current || '');
  for (const row of commits || []) {
    const msg = String(row?.commit?.message || row?.message || '').split('\n')[0].trim();
    if (!msg) continue;
    if (cur && msg.includes(cur)) break;
    subjects.push(msg);
    if (subjects.length >= 8) break;
  }
  return subjects;
}

export function createAppUpdateService(opts = {}) {
  const getCurrentVersion = opts.getCurrentVersion || (() => '0.0.0');
  const fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  const appRoot = opts.appRoot || process.cwd();
  const intervalMs = opts.intervalMs || UPDATE_CHECK_INTERVAL_MS;
  const logPath = opts.logPath || defaultUpdateLogPath();
  const statusPath = opts.statusPath || defaultUpdateStatusPath();
  const spawnImpl = opts.spawnImpl || spawn;
  const platform = opts.platform || process.platform;
  let timer = null;
  let inflight = null;
  let offlineLogged = false;
  const state = {
    latest: null,
    lastChecked: null,
    error: null,
    changelog: [],
    applying: false,
    applyError: null,
  };

  function current() {
    return String(getCurrentVersion() || '0.0.0');
  }

  function publicStatus(mavConn) {
    const safety = assessUpdateSafety(mavConn);
    const report = readUpdateStatusFile(statusPath);
    let applying = state.applying;
    let applyError = state.applyError;
    let reportLog = null;
    if (report) {
      reportLog = report.logPath || null;
      if (report.state === 'failed') {
        applying = false;
        applyError = report.error || applyError || 'update failed';
      } else if (report.state === 'ok' || report.state === 'applied') {
        applying = false;
      } else if (report.state === 'applying') {
        applying = true;
      }
    }
    const latest = state.latest;
    const now = current();
    if (latest && compareVersions(now, latest) >= 0) applying = false;
    return {
      ok: true,
      current: now,
      latest,
      available: isNewerVersion(latest, now),
      lastChecked: state.lastChecked,
      error: state.error,
      blockedReason: safety.blockedReason,
      needsConfirmation: safety.needsConfirmation,
      message: safety.message,
      changelog: state.changelog,
      applying,
      logPath: reportLog || logPath,
      applyError,
    };
  }

  async function fetchText(url) {
    const ac = new AbortController();
    const timerId = setTimeout(() => ac.abort(), opts.fetchTimeoutMs || 8000);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json, application/json, text/plain',
          'User-Agent': 'airvix-console',
        },
        signal: ac.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } finally {
      clearTimeout(timerId);
    }
  }

  async function readLatestVersion() {
    if (process.env.AIRVIX_UPDATE_PREVIEW === '1' && !opts.ignorePreview) {
      return { version: '9.9.9', preview: true };
    }
    const versionJsonUrl = opts.versionJsonUrl || RAW_VERSION_JSON;
    const versionJsUrl = opts.versionJsUrl || RAW_VERSION_JS;
    try {
      const jsonText = await fetchText(versionJsonUrl);
      const parsed = parseVersionPayload(jsonText);
      if (parsed) return { version: parsed };
    } catch {
      /* fall through to version.js */
    }
    const jsText = await fetchText(versionJsUrl);
    const parsed = parseVersionPayload(jsText);
    if (!parsed) throw new Error('version payload missing');
    return { version: parsed };
  }

  async function readChangelog(cur) {
    if (process.env.AIRVIX_UPDATE_PREVIEW === '1' && !opts.ignorePreview) {
      return ['חלון עדכון לבדיקה'];
    }
    try {
      const text = await fetchText(opts.commitsUrl || COMMITS_URL);
      const rows = JSON.parse(text);
      return commitSubjects(Array.isArray(rows) ? rows : [], cur);
    } catch {
      return [];
    }
  }

  async function check() {
    if (inflight) return inflight;
    inflight = (async () => {
      const cur = current();
      try {
        const found = await readLatestVersion();
        state.latest = found.version;
        state.error = null;
        state.lastChecked = new Date().toISOString();
        offlineLogged = false;
        if (isNewerVersion(state.latest, cur)) {
          state.changelog = await readChangelog(cur);
        } else {
          state.changelog = [];
        }
      } catch (err) {
        state.error = 'offline';
        state.lastChecked = new Date().toISOString();
        if (!offlineLogged) {
          offlineLogged = true;
          logger.warn({ message: err?.message || 'offline' }, 'update check unavailable');
        }
      }
      return publicStatus(opts.getMavConn?.());
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function start() {
    check().catch(() => {});
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      check().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function apply({ confirmUnknown = false, mavConn = null } = {}) {
    const safety = assessUpdateSafety(mavConn, { confirmUnknown });
    if (!safety.allowed) {
      return {
        ok: false,
        status: 409,
        blockedReason: safety.blockedReason,
        needsConfirmation: safety.needsConfirmation,
        message: safety.message,
        ...publicStatus(mavConn),
        ok: false,
      };
    }
    await check();
    const snap = publicStatus(mavConn);
    if (!snap.available) {
      return { ok: false, status: 409, error: 'up_to_date', message: 'אין גרסה חדשה.', ...snap, ok: false };
    }
    const launch = buildUpdaterLaunch({ platform, appRoot, logPath, statusPath });
    if (!existsSync(launch.script)) {
      return {
        ok: false,
        status: 500,
        error: 'updater_missing',
        message: 'סקריפט העדכון לא נמצא.',
        logPath: launch.logPath,
      };
    }
    const staged = stageScript(launch.script);
    const args = launch.args.map((arg) => (arg === launch.script ? staged : arg));
    writeUpdateStatusFile(statusPath, {
      state: 'applying',
      error: '',
      logPath: launch.logPath,
      target: snap.latest,
    });
    state.applying = true;
    state.applyError = null;
    try {
      mkdirSync(path.dirname(launch.logPath), { recursive: true });
      const fd = openSync(launch.logPath, 'a');
      const child = spawnImpl(launch.command, args, {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref?.();
      return {
        ok: true,
        status: 202,
        state: 'applying',
        current: snap.current,
        latest: snap.latest,
        logPath: launch.logPath,
        pid: child.pid ?? null,
      };
    } catch (err) {
      state.applying = false;
      state.applyError = err?.message || 'spawn failed';
      writeUpdateStatusFile(statusPath, {
        state: 'failed',
        error: state.applyError,
        logPath: launch.logPath,
      });
      return {
        ok: false,
        status: 500,
        error: 'spawn_failed',
        message: state.applyError,
        logPath: launch.logPath,
      };
    }
  }

  return {
    check,
    start,
    stop,
    apply,
    status: async ({ refresh = false, mavConn = null } = {}) => {
      if (refresh) await check();
      return publicStatus(mavConn);
    },
    publicStatus,
  };
}
