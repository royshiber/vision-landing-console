import fs from 'fs';
import path from 'path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { assertValidDistroName, decodeWslOutput, parseWslVerboseList, resolveWslDistro } from './wsl-distro.mjs';
import { assertSafeLinuxPath, mapApprovedWorktreeToWsl, windowsPathToWsl } from './wsl-path-map.mjs';
import {
  IPC_COMMAND_TYPES,
  IPC_EVENT_TYPES,
  createLineBuffer,
  encodeIpcMessage,
  parseIpcLine,
} from './wsl-cursor-ipc.mjs';
import { publicUnavailableReason, redactSecrets } from './wsl-cursor-secret.mjs';
import {
  CURSOR_SDK_PINNED_VERSION,
  RUNTIME_SETUP_HINT,
  evaluateRuntimeHealth,
  runtimeDirFor,
  runtimeEntrypointFor,
  runtimePackageManifest,
  runtimeSdkMarkerFor,
} from './wsl-cursor-runtime-spec.mjs';

const LIST_TIMEOUT_MS = 30_000;
const SHORT_TIMEOUT_MS = 30_000;
/** WSL may be Stopped; cold-starting the VM regularly exceeds 30s under load. */
const COLD_START_TIMEOUT_MS = 120_000;
const WSL_WAKE_ATTEMPTS = 3;
const HEALTH_TIMEOUT_MS = 90_000;
const HELLO_TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const HEALTH_OK_TTL_MS = 30_000;
const HEALTH_FAIL_TTL_MS = 5_000;
const STDERR_RING_LIMIT = 40;
const NOISE_TOLERANCE = 20;

export function resolveWslExecutable(env = process.env) {
  const root = String(env?.SystemRoot || env?.SYSTEMROOT || '').trim();
  if (root) return path.join(root, 'System32', 'wsl.exe');
  return 'wsl.exe';
}

/**
 * `-e` runs the target without a shell, so no argument is ever interpreted by
 * bash. `--cd` pins the Linux working directory to the runtime prefix so Node
 * module resolution cannot walk out into a /mnt/c tree.
 */
export function buildWslNodeArgs({ distro, runtimeDir, entrypoint, health = false, argv = [] } = {}) {
  assertValidDistroName(distro);
  assertSafeLinuxPath(runtimeDir, 'runtime directory');
  assertSafeLinuxPath(entrypoint, 'runtime entrypoint');
  const args = ['-d', distro, '--cd', runtimeDir, '-e', 'node', entrypoint];
  if (health) args.push('--health');
  for (const extra of argv) args.push(String(extra));
  return args;
}

/**
 * The API key is bridged through the child process environment only. WSLENV is
 * the documented mechanism for making a Windows environment variable visible to
 * the Linux side; it never appears in argv, files, or logs.
 */
export function buildWslSpawnEnv({ apiKey, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  const key = String(apiKey || '').trim();
  if (!key) {
    delete env.CURSOR_API_KEY;
    return env;
  }
  env.CURSOR_API_KEY = key;
  const existing = String(baseEnv?.WSLENV || '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('CURSOR_API_KEY'));
  env.WSLENV = [...existing, 'CURSOR_API_KEY/u'].join(':');
  return env;
}

function defaultEntrypointPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'wsl-runtime', 'cursor-agent-entrypoint.mjs');
}

function defaultManifestPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'wsl-runtime', 'runtime-package.json');
}

export function createWslCursorAgentRuntime(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const spawnFn = opts.spawn || nodeSpawn;
  const spawnSyncFn = opts.spawnSync || nodeSpawnSync;
  const wslExe = opts.wslExe || resolveWslExecutable(env);
  const configuredDistro = String(opts.distro || env.CURSOR_WSL_DISTRO || '').trim();
  const runtimeDirOverride = String(opts.runtimeDir || env.CURSOR_WSL_RUNTIME_DIR || '').trim();
  const secrets = [String(opts.apiKey || '').trim()].filter(Boolean);

  let contextCache = null;
  let stagedEntrypoint = false;
  let healthCache = null;

  function runSync(args, timeout) {
    const result = spawnSyncFn(wslExe, args, { timeout, windowsHide: true });
    const stdout = decodeWslOutput(result?.stdout);
    const stderr = decodeWslOutput(result?.stderr);
    return {
      ok: !result?.error && result?.status === 0,
      status: result?.status ?? null,
      error: result?.error || null,
      stdout,
      stderr,
    };
  }

  function listDistros() {
    const result = runSync(['--list', '--verbose'], LIST_TIMEOUT_MS);
    if (!result.ok && !result.stdout) {
      throw new Error('WSL is not available on this host');
    }
    return parseWslVerboseList(result.stdout);
  }

  /**
   * Contact the configured distro. WSL cold-start after Stopped is external
   * nondeterminism: we bound retries and surface a truthful failure if the
   * distro never answers. This does not retry agent runs or hide SDK errors.
   */
  function resolveLinuxHome(distro) {
    let last = null;
    for (let attempt = 1; attempt <= WSL_WAKE_ATTEMPTS; attempt += 1) {
      const timeout = attempt === 1 ? SHORT_TIMEOUT_MS : COLD_START_TIMEOUT_MS;
      last = runSync(['-d', distro, '-e', 'sh', '-c', 'printf %s "$HOME"'], timeout);
      if (last.ok) {
        return assertSafeLinuxPath(last.stdout.trim(), 'linux home directory');
      }
      const timedOut = String(last.error?.code || last.error?.message || '').includes('ETIMEDOUT')
        || String(last.error?.message || '').toLowerCase().includes('timeout');
      if (!timedOut && attempt === 1) {
        // Hard failure (missing distro, bad name) — do not burn cold-start budget.
        break;
      }
    }
    const detail = last?.error?.message || last?.stderr || `status=${last?.status}`;
    throw new Error(
      `WSL distribution is not reachable after ${WSL_WAKE_ATTEMPTS} attempts (${String(detail).slice(0, 160)})`,
    );
  }

  function resolveContext() {
    if (contextCache) return contextCache;
    if (platform !== 'win32') {
      throw new Error('WSL agent bridge requires a Windows host');
    }
    const distro = resolveWslDistro({ configured: configuredDistro, distros: listDistros() });
    const home = resolveLinuxHome(distro);
    const runtimeDir = runtimeDirOverride
      ? assertSafeLinuxPath(runtimeDirOverride, 'runtime directory')
      : runtimeDirFor(home);
    contextCache = {
      distro,
      home,
      runtimeDir,
      entrypoint: runtimeEntrypointFor(runtimeDir),
      sdkMarker: runtimeSdkMarkerFor(runtimeDir),
    };
    return contextCache;
  }

  function copyIntoWsl(distro, windowsSource, linuxTarget) {
    if (!fs.existsSync(windowsSource)) throw new Error('WSL runtime source file is missing');
    const source = windowsPathToWsl(windowsSource);
    const result = runSync(['-d', distro, '-e', 'cp', source, linuxTarget], SHORT_TIMEOUT_MS);
    if (!result.ok) throw new Error('WSL runtime file staging failed');
  }

  function stageEntrypoint(ctx) {
    if (opts.skipEntrypointStage) return;
    if (stagedEntrypoint) return;
    copyIntoWsl(ctx.distro, opts.entrypointWindowsPath || defaultEntrypointPath(), ctx.entrypoint);
    stagedEntrypoint = true;
  }

  function runtimeInstalled(ctx) {
    const result = runSync(['-d', ctx.distro, '-e', 'test', '-f', ctx.sdkMarker], SHORT_TIMEOUT_MS);
    return result.ok;
  }

  function parseHealthOutput(stdout) {
    const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines.reverse()) {
      try {
        return parseIpcLine(line, { allowedTypes: ['health', 'error'], extraSecrets: secrets });
      } catch {
        /* keep scanning: only the protocol line matters */
      }
    }
    return null;
  }

  function readinessFailure(reason) {
    return {
      ok: false,
      kind: 'wsl-cursor-sdk',
      reason: publicUnavailableReason(reason, secrets),
      details: null,
    };
  }

  async function probeHealth({ force = false } = {}) {
    const now = Date.now();
    if (!force && healthCache && healthCache.expiresAt > now) return healthCache.value;

    let value;
    try {
      const ctx = resolveContext();
      if (!runtimeInstalled(ctx)) {
        value = readinessFailure(
          `Linux Cursor runtime is not prepared in WSL (${RUNTIME_SETUP_HINT})`,
        );
      } else {
        stageEntrypoint(ctx);
        const args = buildWslNodeArgs({
          distro: ctx.distro,
          runtimeDir: ctx.runtimeDir,
          entrypoint: ctx.entrypoint,
          health: true,
        });
        const result = runSync(args, HEALTH_TIMEOUT_MS);
        const report = parseHealthOutput(result.stdout);
        if (!report) {
          value = readinessFailure(
            result.stderr ? `WSL runtime health failed: ${result.stderr.slice(0, 200)}` : 'WSL runtime health failed',
          );
        } else if (report.type === 'error') {
          value = readinessFailure(report.message || 'WSL runtime health failed');
        } else {
          const verdict = evaluateRuntimeHealth(report, { runtimeDir: ctx.runtimeDir });
          value = verdict.ok
            ? {
              ok: true,
              kind: 'wsl-cursor-sdk',
              reason: null,
              details: {
                distro: ctx.distro,
                node: report.node,
                sdkVersion: report.sdkVersion,
                pinnedSdkVersion: CURSOR_SDK_PINNED_VERSION,
                platformPackage: report.platformPackage,
                sandboxEnabled: report.sandboxEnabled === true,
                linuxNative: true,
              },
            }
            : readinessFailure(`${verdict.reason} (${RUNTIME_SETUP_HINT})`);
        }
      }
    } catch (err) {
      value = readinessFailure(String(err?.message || err));
    }

    healthCache = { value, expiresAt: now + (value.ok ? HEALTH_OK_TTL_MS : HEALTH_FAIL_TTL_MS) };
    return value;
  }

  /**
   * Controlled bootstrap. Never called from the task-start path: an operator
   * runs it once per machine (npm run setup:wsl-agent).
   */
  async function prepareRuntime({ install = true } = {}) {
    const ctx = resolveContext();
    const steps = [];
    const mk = runSync(['-d', ctx.distro, '-e', 'mkdir', '-p', ctx.runtimeDir], SHORT_TIMEOUT_MS);
    if (!mk.ok) throw new Error('cannot create the Linux runtime directory');
    steps.push('runtime directory');

    copyIntoWsl(ctx.distro, opts.manifestWindowsPath || defaultManifestPath(), `${ctx.runtimeDir}/package.json`);
    steps.push('pinned package.json');

    copyIntoWsl(ctx.distro, opts.entrypointWindowsPath || defaultEntrypointPath(), ctx.entrypoint);
    stagedEntrypoint = true;
    steps.push('runtime entrypoint');

    if (install) {
      const result = runSync(
        ['-d', ctx.distro, '--cd', ctx.runtimeDir, '-e', 'npm', 'install', '--no-audit', '--no-fund'],
        INSTALL_TIMEOUT_MS,
      );
      if (!result.ok) {
        throw new Error(`Linux npm install failed: ${redactSecrets(result.stderr || '', secrets).slice(-300)}`);
      }
      steps.push(`@cursor/sdk@${CURSOR_SDK_PINNED_VERSION}`);
    }

    const health = await probeHealth({ force: true });
    return {
      distro: ctx.distro,
      runtimeDir: ctx.runtimeDir,
      manifest: runtimePackageManifest(),
      steps,
      health,
    };
  }

  function mapWorktree(worktree) {
    return mapApprovedWorktreeToWsl(repoRoot, worktree);
  }

  function createHandle(child) {
    const eventListeners = new Set();
    const exitListeners = new Set();
    const waiters = new Set();
    const eventHistory = [];
    const EVENT_HISTORY_LIMIT = 64;
    const stderrRing = [];
    const stdoutBuffer = createLineBuffer();
    let noise = 0;
    let exitInfo = null;
    let closing = null;

    function dispatch(event) {
      eventHistory.push(event);
      while (eventHistory.length > EVENT_HISTORY_LIMIT) eventHistory.shift();
      for (const waiter of [...waiters]) {
        if (waiter.settled) continue;
        if (waiter.predicate(event)) waiter.resolve(event);
      }
      for (const listener of eventListeners) {
        try {
          listener(event);
        } catch {
          /* listener errors must not tear down the bridge */
        }
      }
    }

    function handleLine(line) {
      let event;
      try {
        event = parseIpcLine(line, { allowedTypes: IPC_EVENT_TYPES, extraSecrets: secrets });
      } catch (err) {
        const message = String(err?.message || '');
        if (message === 'ipc line is not json' && noise < NOISE_TOLERANCE) {
          noise += 1;
          return;
        }
        dispatch({ type: 'error', message: 'WSL runtime sent a malformed protocol message' });
        return;
      }
      dispatch(event);
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      for (const line of stdoutBuffer.push(chunk)) handleLine(line);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      const text = redactSecrets(String(chunk), secrets).trim();
      if (!text) return;
      stderrRing.push(text.slice(0, 500));
      while (stderrRing.length > STDERR_RING_LIMIT) stderrRing.shift();
    });

    function finish(code, signal) {
      if (exitInfo) return;
      exitInfo = { code: code ?? null, signal: signal ?? null, stderr: [...stderrRing] };
      for (const waiter of [...waiters]) {
        waiter.reject(new Error(
          `WSL runtime exited${exitInfo.code != null ? ` (${exitInfo.code})` : ''}`,
        ));
      }
      for (const listener of exitListeners) {
        try {
          listener(exitInfo);
        } catch {
          /* ignore */
        }
      }
    }

    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', () => finish(null, null));

    return {
      pid: child.pid ?? null,
      get exited() {
        return exitInfo !== null;
      },
      get stderrTail() {
        return [...stderrRing];
      },
      send(message) {
        if (exitInfo) throw new Error('WSL runtime exited');
        const type = String(message?.type || '');
        if (!IPC_COMMAND_TYPES.includes(type)) throw new Error(`unsupported runtime command: ${type || '(missing)'}`);
        child.stdin?.write(encodeIpcMessage(message, secrets));
      },
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        if (exitInfo) listener(exitInfo);
        return () => exitListeners.delete(listener);
      },
      waitFor(predicate, timeoutMs = HELLO_TIMEOUT_MS) {
        if (exitInfo) {
          return Promise.reject(new Error(
            `WSL runtime exited${exitInfo.code != null ? ` (${exitInfo.code})` : ''}`,
          ));
        }
        return new Promise((resolve, reject) => {
          const waiter = {
            predicate,
            settled: false,
            timer: null,
            resolve(event) {
              if (waiter.settled) return;
              waiter.settled = true;
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              resolve(event);
            },
            reject(err) {
              if (waiter.settled) return;
              waiter.settled = true;
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              reject(err);
            },
          };
          waiter.timer = setTimeout(() => {
            const stderrHint = stderrRing.length
              ? `; stderr: ${stderrRing.slice(-3).join(' | ').slice(0, 240)}`
              : '';
            waiter.reject(new Error(`WSL runtime timed out${stderrHint}`));
          }, timeoutMs);
          if (waiter.timer?.unref) waiter.timer.unref();
          // Register before replaying history so an event that arrives between
          // the history scan and registration cannot be missed.
          waiters.add(waiter);
          for (const past of eventHistory) {
            if (waiter.settled) break;
            if (predicate(past)) waiter.resolve(past);
          }
        });
      },
      async close() {
        if (exitInfo) return;
        if (closing) return closing;
        closing = (async () => {
          try {
            child.stdin?.write(encodeIpcMessage({ type: 'dispose' }, secrets));
            child.stdin?.end();
          } catch {
            /* the runtime may already be gone */
          }
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              try {
                child.kill();
              } catch {
                /* ignore */
              }
              resolve();
            }, 3000);
            if (timer.unref) timer.unref();
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        })();
        return closing;
      },
    };
  }

  async function spawnSession({ apiKey } = {}) {
    const health = await probeHealth();
    if (!health.ok) throw new Error(health.reason || 'Development agent unavailable');
    const ctx = resolveContext();
    const args = buildWslNodeArgs({
      distro: ctx.distro,
      runtimeDir: ctx.runtimeDir,
      entrypoint: ctx.entrypoint,
    });
    const child = spawnFn(wslExe, args, {
      env: buildWslSpawnEnv({ apiKey: apiKey || opts.apiKey, baseEnv: env }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const handle = createHandle(child);
    try {
      await handle.waitFor((ev) => ev?.type === 'hello' || ev?.type === 'error', opts.helloTimeoutMs || HELLO_TIMEOUT_MS);
    } catch (err) {
      await handle.close();
      throw new Error(publicUnavailableReason(`WSL runtime did not start: ${String(err?.message || err)}`, secrets));
    }
    return handle;
  }

  async function describe() {
    const health = await probeHealth();
    return {
      provider: 'cursor-sdk',
      runtime: health.ok ? 'READY' : 'UNAVAILABLE',
      reason: health.reason,
    };
  }

  return {
    kind: 'wsl-cursor-sdk',
    probeHealth,
    prepareRuntime,
    mapWorktree,
    spawnSession,
    describe,
    resolveContext,
    get contextForTests() {
      return contextCache;
    },
  };
}
