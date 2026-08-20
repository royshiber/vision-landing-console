import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';

import { assertSafeLinuxPath, mapApprovedWorktreeToWsl, windowsPathToWsl } from '../lib/wsl-path-map.mjs';
import {
  decodeWslOutput,
  isValidDistroName,
  parseWslVerboseList,
  resolveWslDistro,
} from '../lib/wsl-distro.mjs';
import {
  IPC_COMMAND_TYPES,
  IPC_EVENT_TYPES,
  MAX_IPC_LINE_BYTES,
  createLineBuffer,
  encodeIpcMessage,
  parseIpcLine,
} from '../lib/wsl-cursor-ipc.mjs';
import {
  CURSOR_SDK_PINNED_VERSION,
  evaluateRuntimeHealth,
  runtimeDirFor,
  runtimeEntrypointFor,
} from '../lib/wsl-cursor-runtime-spec.mjs';
import {
  buildWslNodeArgs,
  buildWslSpawnEnv,
  createWslCursorAgentRuntime,
  resolveWslExecutable,
} from '../lib/wsl-cursor-agent-runtime.mjs';
import { createWslCursorAgentSupervisor } from '../lib/wsl-cursor-agent-supervisor.mjs';
import { CURSOR_AGENT_ALLOWED_TOOLS } from '../lib/cursor-agent-tool-policy.mjs';
import { createCursorAgentLogStore } from '../lib/cursor-agent-log-store.mjs';

const API_KEY = 'cursor_test_key_c910_abcdefghijklmnop';
const LINUX_HOME = '/home/tester';
const RUNTIME_DIR = runtimeDirFor(LINUX_HOME);
const ENTRYPOINT = runtimeEntrypointFor(RUNTIME_DIR);
const SDK_PATH = `${RUNTIME_DIR}/node_modules/@cursor/sdk/dist/esm/index.js`;

function makeRepo(prefix = 'vlc-c910-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.worktrees', 'dev-1'), { recursive: true });
  return root;
}

function approvedWorktree(id = 'dev-1') {
  return { branch: `development/tasks/${id}`, worktree_id: `.worktrees/${id}`, base_commit: 'abc123' };
}

function healthReport(overrides = {}) {
  return {
    type: 'health',
    ok: true,
    node: '22.23.2',
    sdkVersion: CURSOR_SDK_PINNED_VERSION,
    sdkPath: SDK_PATH,
    platformPackage: '@cursor/sdk-linux-x64',
    platformPackagePresent: true,
    sandboxEnabled: true,
    ...overrides,
  };
}

const DISTRO_LIST = Buffer.from(
  '  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n',
  'utf16le',
);

/** Fake `wsl.exe` reachable through spawnSync, driven by the argv shape. */
function createFakeWslSync({ installed = true, health = healthReport(), overrides = {}, homeFailures = 0 } = {}) {
  const calls = [];
  let homeAttempts = 0;
  function fn(exe, args) {
    calls.push({ exe, args: [...args] });
    const joined = args.join(' ');
    for (const [match, value] of Object.entries(overrides)) {
      if (joined.includes(match)) return value;
    }
    if (joined === '--list --verbose') return { status: 0, stdout: DISTRO_LIST, stderr: Buffer.alloc(0) };
    if (joined.includes('printf %s "$HOME"')) {
      homeAttempts += 1;
      if (homeAttempts <= homeFailures) {
        const err = new Error('spawnSync ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        return { status: null, error: err, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: LINUX_HOME, stderr: '' };
    }
    if (joined.includes('test -f')) return { status: installed ? 0 : 1, stdout: '', stderr: '' };
    if (joined.includes('-e cp')) return { status: 0, stdout: '', stderr: '' };
    if (joined.includes('mkdir -p')) return { status: 0, stdout: '', stderr: '' };
    if (joined.includes('npm install')) return { status: 0, stdout: 'added 11 packages', stderr: '' };
    if (joined.includes('--health')) {
      return { status: 0, stdout: `${JSON.stringify(health)}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
  fn.calls = calls;
  return fn;
}

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinChunks = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      child.stdinChunks.push(String(chunk));
      cb();
    },
  });
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', null, 'SIGTERM');
  };
  child.emitLine = (obj) => child.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  return child;
}

function runtimeWithFakes({ installed = true, health = healthReport(), overrides = {}, apiKey = API_KEY, repoRoot, homeFailures = 0 } = {}) {
  const spawnSync = createFakeWslSync({ installed, health, overrides, homeFailures });
  const children = [];
  const spawn = (exe, args, opts) => {
    const child = createFakeChild();
    child.spawnArgs = [...args];
    child.spawnEnv = opts?.env || {};
    children.push(child);
    return child;
  };
  const runtime = createWslCursorAgentRuntime({
    repoRoot: repoRoot || process.cwd(),
    apiKey,
    platform: 'win32',
    wslExe: 'C:/Windows/System32/wsl.exe',
    env: { SystemRoot: 'C:/Windows', CURSOR_WSL_DISTRO: 'Ubuntu' },
    spawn,
    spawnSync,
    helloTimeoutMs: 500,
  });
  return { runtime, spawnSync, children };
}

/** Scripted stand-in for a spawned WSL runtime handle. */
function createFakeHandle({ onCommand } = {}) {
  const listeners = new Set();
  const exitListeners = new Set();
  const handle = {
    sent: [],
    closed: false,
    exited: false,
    send(message) {
      if (handle.exited) throw new Error('WSL runtime exited');
      handle.sent.push(message);
      if (onCommand) setImmediate(() => onCommand(handle, message));
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    waitFor(predicate, timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        const probe = (event) => {
          if (predicate(event)) {
            listeners.delete(probe);
            clearTimeout(timer);
            resolve(event);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(probe);
          reject(new Error('WSL runtime timed out'));
        }, timeoutMs);
        if (timer.unref) timer.unref();
        listeners.add(probe);
      });
    },
    emit(event) {
      for (const cb of [...listeners]) cb(event);
    },
    exit(code = 1, stderr = []) {
      handle.exited = true;
      for (const cb of [...exitListeners]) cb({ code, stderr });
    },
    async close() {
      handle.closed = true;
    },
  };
  return handle;
}

function createFakeRuntime({ repoRoot, health = { ok: true, kind: 'wsl-cursor-sdk', reason: null }, onCommand } = {}) {
  const handles = [];
  return {
    handles,
    spawnCount: 0,
    async probeHealth() {
      return health;
    },
    mapWorktree(worktree) {
      return mapApprovedWorktreeToWsl(repoRoot, worktree);
    },
    async spawnSession() {
      this.spawnCount += 1;
      const handle = createFakeHandle({ onCommand });
      handles.push(handle);
      return handle;
    },
  };
}

function agentScript(handle, message) {
  if (message.type === 'start') {
    handle.emit({ type: 'started', sessionId: 'agent-c910-1' });
    handle.emit({ type: 'state', state: 'RUNNING', runId: 'run-c910-1' });
    handle.emit({ type: 'message', message: 'patched lib/foo.mjs' });
    return;
  }
  if (message.type === 'resume') {
    handle.emit({ type: 'started', sessionId: 'agent-c910-1', resumed: true });
    handle.emit({ type: 'state', state: 'RUNNING', runId: 'run-c910-1' });
    return;
  }
  if (message.type === 'cancel') handle.emit({ type: 'cancelled', runId: 'run-c910-1' });
}

describe('windows to WSL path mapping', () => {
  it('maps windows drives into the WSL mount namespace', () => {
    expect(windowsPathToWsl('C:\\Users\\shibe\\VisionLandingConsole\\.worktrees\\abc'))
      .toBe('/mnt/c/Users/shibe/VisionLandingConsole/.worktrees/abc');
    expect(windowsPathToWsl('D:/repo/x')).toBe('/mnt/d/repo/x');
  });

  it('rejects relative paths, traversal and shell metacharacters', () => {
    expect(() => windowsPathToWsl('.worktrees/abc')).toThrow(/absolute windows path/);
    expect(() => windowsPathToWsl('C:\\repo\\..\\etc')).toThrow(/unsafe/);
    expect(() => windowsPathToWsl('C:\\repo\\a;rm -rf b')).toThrow(/unsafe/);
    expect(() => assertSafeLinuxPath('relative/path')).toThrow(/unsafe/);
    expect(() => assertSafeLinuxPath('/tmp/$(whoami)')).toThrow(/unsafe/);
    expect(() => assertSafeLinuxPath('/tmp/a b')).toThrow(/unsafe/);
  });
});

describe('worktree validation before mapping', () => {
  let repoRoot;
  beforeEach(() => {
    repoRoot = makeRepo();
  });
  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('maps an approved worktree to its linux path', () => {
    const mapped = mapApprovedWorktreeToWsl(repoRoot, approvedWorktree());
    expect(mapped.branch).toBe('development/tasks/dev-1');
    expect(mapped.linuxPath.startsWith('/mnt/')).toBe(true);
    expect(mapped.linuxPath.endsWith('/.worktrees/dev-1')).toBe(true);
  });

  it('rejects branches outside development/tasks and worktrees outside .worktrees', () => {
    expect(() => mapApprovedWorktreeToWsl(repoRoot, { branch: 'master', worktree_id: '.worktrees/dev-1' }))
      .toThrow(/unsafe agent branch/);
    expect(() => mapApprovedWorktreeToWsl(repoRoot, { branch: 'development/tasks/dev-1', worktree_id: 'dev-1' }))
      .toThrow(/unsafe agent worktree/);
    expect(() => mapApprovedWorktreeToWsl(repoRoot, {
      branch: 'development/tasks/dev-1',
      worktree_id: '.worktrees/../../etc',
    })).toThrow(/unsafe agent worktree/);
    expect(() => mapApprovedWorktreeToWsl(repoRoot, {
      branch: 'development/tasks/missing',
      worktree_id: '.worktrees/missing',
    })).toThrow(/worktree required/);
  });

  it('ignores caller supplied paths and distro hints', () => {
    const mapped = mapApprovedWorktreeToWsl(repoRoot, {
      ...approvedWorktree(),
      linuxPath: '/etc',
      absWorktree: 'C:/Windows',
      distro: 'evil',
    });
    expect(mapped.linuxPath.endsWith('/.worktrees/dev-1')).toBe(true);
    expect(mapped.distro).toBeUndefined();
    expect(mapped.absWorktree).toBe(path.resolve(repoRoot, '.worktrees/dev-1'));
  });
});

describe('WSL distribution resolution', () => {
  it('validates distro names', () => {
    expect(isValidDistroName('Ubuntu')).toBe(true);
    expect(isValidDistroName('Ubuntu-22.04')).toBe(true);
    expect(isValidDistroName('Ubuntu; rm -rf /')).toBe(false);
    expect(isValidDistroName('')).toBe(false);
    expect(isValidDistroName('-bad')).toBe(false);
  });

  it('decodes and parses utf16 verbose listings', () => {
    expect(decodeWslOutput(DISTRO_LIST)).toContain('Ubuntu');
    const parsed = parseWslVerboseList(DISTRO_LIST);
    expect(parsed).toEqual([{ name: 'Ubuntu', isDefault: true, state: 'Running', version: '2' }]);
  });

  it('prefers the configured distro and refuses ambiguity', () => {
    const distros = [
      { name: 'Ubuntu', isDefault: true, state: 'Running' },
      { name: 'Debian', isDefault: false, state: 'Stopped' },
    ];
    expect(resolveWslDistro({ configured: 'Debian', distros })).toBe('Debian');
    expect(resolveWslDistro({ distros })).toBe('Ubuntu');
    expect(() => resolveWslDistro({ configured: 'Fedora', distros })).toThrow(/not found/);
    expect(() => resolveWslDistro({ configured: 'a;b', distros })).toThrow(/invalid WSL distribution/);
    expect(() => resolveWslDistro({ distros: [] })).toThrow(/no WSL distribution/);
    expect(() => resolveWslDistro({
      distros: [
        { name: 'Ubuntu', isDefault: false, state: 'Running' },
        { name: 'Debian', isDefault: false, state: 'Running' },
      ],
    })).toThrow(/ambiguous/);
  });
});

describe('IPC framing', () => {
  it('round-trips commands and events', () => {
    const line = encodeIpcMessage({ type: 'start', payload: { model: 'composer-2.5' } });
    expect(line.endsWith('\n')).toBe(true);
    const parsed = parseIpcLine(line, { allowedTypes: IPC_COMMAND_TYPES });
    expect(parsed.payload.model).toBe('composer-2.5');
  });

  it('rejects malformed protocol messages', () => {
    expect(() => parseIpcLine('not json', { allowedTypes: IPC_EVENT_TYPES })).toThrow(/not json/);
    expect(() => parseIpcLine('[]', { allowedTypes: IPC_EVENT_TYPES })).toThrow(/must be an object/);
    expect(() => parseIpcLine('{}', { allowedTypes: IPC_EVENT_TYPES })).toThrow(/type is not allowed/);
    expect(() => parseIpcLine('{"type":"exec"}', { allowedTypes: IPC_EVENT_TYPES })).toThrow(/type is not allowed/);
    expect(() => parseIpcLine('', { allowedTypes: IPC_EVENT_TYPES })).toThrow(/empty/);
    expect(() => encodeIpcMessage({ type: 'shell', payload: {} })).toThrow(/unsupported ipc message type/);
    expect(() => encodeIpcMessage(['start'])).toThrow(/must be an object/);
    const huge = 'x'.repeat(MAX_IPC_LINE_BYTES + 10);
    expect(() => parseIpcLine(`{"type":"message","message":"${huge}"}`, { allowedTypes: IPC_EVENT_TYPES }))
      .toThrow(/too large/);
  });

  it('never serializes a secret and redacts inbound text', () => {
    expect(() => encodeIpcMessage({ type: 'message', message: `key ${API_KEY}` }, [API_KEY]))
      .toThrow(/refusing to serialize secret/);
    const parsed = parseIpcLine(JSON.stringify({ type: 'message', message: `leak ${API_KEY}` }), {
      allowedTypes: IPC_EVENT_TYPES,
      extraSecrets: [API_KEY],
    });
    expect(parsed.message).not.toContain(API_KEY);
    expect(parsed.message).toContain('[REDACTED]');
  });

  it('splits newline framed chunks and drops unbounded frames', () => {
    const buffer = createLineBuffer({ maxLineBytes: 64 });
    expect(buffer.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(buffer.push('2}\n')).toEqual(['{"b":2}']);
    buffer.push('y'.repeat(200));
    expect(buffer.overflowCount).toBe(1);
    expect(buffer.push('\n')).toEqual([]);
  });
});

describe('WSL spawn arguments and environment', () => {
  it('pins the linux working directory and never passes the key in argv', () => {
    const args = buildWslNodeArgs({ distro: 'Ubuntu', runtimeDir: RUNTIME_DIR, entrypoint: ENTRYPOINT });
    expect(args).toEqual(['-d', 'Ubuntu', '--cd', RUNTIME_DIR, '-e', 'node', ENTRYPOINT]);
    expect(args.join(' ')).not.toContain(API_KEY);
    const health = buildWslNodeArgs({ distro: 'Ubuntu', runtimeDir: RUNTIME_DIR, entrypoint: ENTRYPOINT, health: true });
    expect(health[health.length - 1]).toBe('--health');
    expect(() => buildWslNodeArgs({ distro: 'a;b', runtimeDir: RUNTIME_DIR, entrypoint: ENTRYPOINT }))
      .toThrow(/invalid WSL distribution/);
    expect(() => buildWslNodeArgs({ distro: 'Ubuntu', runtimeDir: 'relative', entrypoint: ENTRYPOINT }))
      .toThrow(/unsafe runtime directory/);
  });

  it('bridges the key through WSLENV only', () => {
    const env = buildWslSpawnEnv({ apiKey: API_KEY, baseEnv: { PATH: 'p', WSLENV: 'FOO/u' } });
    expect(env.CURSOR_API_KEY).toBe(API_KEY);
    expect(env.WSLENV).toBe('FOO/u:CURSOR_API_KEY/u');
    const without = buildWslSpawnEnv({ apiKey: '', baseEnv: { CURSOR_API_KEY: API_KEY } });
    expect(without.CURSOR_API_KEY).toBeUndefined();
  });

  it('resolves wsl.exe from SystemRoot', () => {
    expect(resolveWslExecutable({ SystemRoot: 'C:\\Windows' })).toBe(path.join('C:\\Windows', 'System32', 'wsl.exe'));
    expect(resolveWslExecutable({})).toBe('wsl.exe');
  });
});

describe('runtime readiness', () => {
  it('reports READY for a prepared linux-native runtime', async () => {
    const { runtime, spawnSync } = runtimeWithFakes();
    const health = await runtime.probeHealth();
    expect(health.ok).toBe(true);
    expect(health.details.sdkVersion).toBe(CURSOR_SDK_PINNED_VERSION);
    expect(health.details.platformPackage).toBe('@cursor/sdk-linux-x64');
    expect(health.details.sandboxEnabled).toBe(true);
    const flat = JSON.stringify(spawnSync.calls);
    expect(flat).not.toContain(API_KEY);
    expect(flat).toContain('--health');
  });

  it('never installs during a readiness probe', async () => {
    const { runtime, spawnSync } = runtimeWithFakes({ installed: false });
    const health = await runtime.probeHealth();
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/not prepared/);
    expect(health.reason).toMatch(/setup:wsl-agent/);
    expect(JSON.stringify(spawnSync.calls)).not.toContain('npm install');
  });

  it('fails closed on version, platform package and prefix drift', async () => {
    const wrongVersion = await runtimeWithFakes({ health: healthReport({ sdkVersion: '1.0.27' }) })
      .runtime.probeHealth();
    expect(wrongVersion.ok).toBe(false);
    expect(wrongVersion.reason).toMatch(/1\.0\.28 is required/);

    const noPlatform = await runtimeWithFakes({ health: healthReport({ platformPackagePresent: false }) })
      .runtime.probeHealth();
    expect(noPlatform.ok).toBe(false);
    expect(noPlatform.reason).toMatch(/platform package/);

    const escaped = await runtimeWithFakes({
      health: healthReport({ sdkPath: '/mnt/c/Users/shibe/VisionLandingConsole/node_modules/@cursor/sdk/index.js' }),
    }).runtime.probeHealth();
    expect(escaped.ok).toBe(false);
    expect(escaped.reason).toMatch(/outside its Linux prefix/);

    const oldNode = evaluateRuntimeHealth(healthReport({ node: '18.20.0' }), { runtimeDir: RUNTIME_DIR });
    expect(oldNode.ok).toBe(false);
    expect(oldNode.reason).toMatch(/Node 22/);
  });

  it('retries WSL cold-start timeouts when contacting the distro home', async () => {
    const { runtime, spawnSync } = runtimeWithFakes({ homeFailures: 1 });
    const health = await runtime.probeHealth();
    expect(health.ok).toBe(true);
    const homeCalls = spawnSync.calls.filter((c) => c.args.join(' ').includes('printf %s "$HOME"'));
    expect(homeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a public reason when WSL itself is missing', async () => {
    const { runtime } = runtimeWithFakes({
      overrides: { '--list --verbose': { status: 1, error: new Error('ENOENT'), stdout: '', stderr: '' } },
    });
    const health = await runtime.probeHealth();
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/WSL is not available/);
  });

  it('refuses to run the bridge off Windows', async () => {
    const runtime = createWslCursorAgentRuntime({ platform: 'linux', spawnSync: createFakeWslSync() });
    const health = await runtime.probeHealth();
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/requires a Windows host/);
  });

  it('does not leak host paths in unavailable reasons', async () => {
    const { runtime } = runtimeWithFakes({ installed: false });
    const health = await runtime.probeHealth();
    expect(health.reason).not.toContain('/home/tester');
    expect(health.reason).not.toContain('/mnt/c');
  });
});

describe('runtime process supervision', () => {
  it('waits for hello, frames events and rejects malformed protocol lines', async () => {
    const { runtime, children } = runtimeWithFakes();
    const sessionPromise = runtime.spawnSession({ apiKey: API_KEY });
    await new Promise((r) => setImmediate(r));
    const child = children[0];
    child.emitLine({ type: 'hello', node: '22.23.2', sdkVersion: CURSOR_SDK_PINNED_VERSION });
    const handle = await sessionPromise;

    expect(child.spawnArgs).toContain('--cd');
    expect(child.spawnEnv.CURSOR_API_KEY).toBe(API_KEY);
    expect(child.spawnArgs.join(' ')).not.toContain(API_KEY);

    const events = [];
    handle.onEvent((ev) => events.push(ev));
    child.emitLine('ExperimentalWarning: SQLite is experimental');
    child.emitLine({ type: 'started', sessionId: 'agent-1' });
    child.emitLine({ type: 'exec', command: 'rm -rf /' });
    await new Promise((r) => setImmediate(r));

    expect(events.map((e) => e.type)).toEqual(['started', 'error']);
    expect(events[1].message).toMatch(/malformed protocol message/);
    expect(() => handle.send({ type: 'shell' })).toThrow(/unsupported runtime command/);
  });

  it('resolves waitFor from history when the event arrives before registration', async () => {
    const { runtime, children } = runtimeWithFakes();
    const sessionPromise = runtime.spawnSession({ apiKey: API_KEY });
    await new Promise((r) => setImmediate(r));
    const child = children[0];
    child.emitLine({ type: 'hello', node: '22.23.2', sdkVersion: CURSOR_SDK_PINNED_VERSION });
    const handle = await sessionPromise;

    child.emitLine({ type: 'started', sessionId: 'agent-early' });
    await new Promise((r) => setImmediate(r));
    // Event already in history — waitFor must not hang.
    const started = await handle.waitFor((ev) => ev?.type === 'started', 200);
    expect(started.sessionId).toBe('agent-early');
  });

  it('does not miss an event that races between history scan and waiter registration', async () => {
    const { runtime, children } = runtimeWithFakes();
    const sessionPromise = runtime.spawnSession({ apiKey: API_KEY });
    await new Promise((r) => setImmediate(r));
    children[0].emitLine({ type: 'hello' });
    const handle = await sessionPromise;

    const waiting = handle.waitFor((ev) => ev?.type === 'message', 500);
    children[0].emitLine({ type: 'message', message: 'raced' });
    const ev = await waiting;
    expect(ev.message).toBe('raced');
  });

  it('rejects a session when the runtime never says hello', async () => {
    const { runtime, children } = runtimeWithFakes();
    const promise = runtime.spawnSession({ apiKey: API_KEY }).catch((err) => err);
    await new Promise((r) => setImmediate(r));
    const err = await promise;
    expect(String(err.message)).toMatch(/Development agent unavailable/);
    expect(children[0].killed).toBe(true);
  }, 10_000);

  it('surfaces runtime exit to waiters and redacts stderr', async () => {
    const { runtime, children } = runtimeWithFakes();
    const sessionPromise = runtime.spawnSession({ apiKey: API_KEY });
    await new Promise((r) => setImmediate(r));
    const child = children[0];
    child.emitLine({ type: 'hello' });
    const handle = await sessionPromise;

    const exits = [];
    handle.onExit((info) => exits.push(info));
    child.stderr.write(`boom with ${API_KEY}\n`);
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 9, null);
    await new Promise((r) => setImmediate(r));

    expect(exits[0].code).toBe(9);
    expect(exits[0].stderr.join(' ')).not.toContain(API_KEY);
    expect(exits[0].stderr.join(' ')).toContain('[REDACTED]');
    expect(() => handle.send({ type: 'status' })).toThrow(/exited/);
  });
});

describe('WSL supervisor sessions', () => {
  let repoRoot;
  let registryPath;

  beforeEach(() => {
    repoRoot = makeRepo();
    registryPath = path.join(repoRoot, 'var', 'development', 'agent-registry.json');
  });
  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function supervisorWith(runtime) {
    return createWslCursorAgentSupervisor({
      repoRoot,
      apiKey: API_KEY,
      model: 'composer-2.5',
      runtime,
      registryPath,
      logStore: createCursorAgentLogStore({ repoRoot }),
    });
  }

  it('starts a session, persists bounded state and keeps the key out of disk', async () => {
    const runtime = createFakeRuntime({ repoRoot, onCommand: agentScript });
    const supervisor = supervisorWith(runtime);
    const snapshot = await supervisor.startSession({ id: 'dev-1', title: 'demo' }, approvedWorktree());

    expect(snapshot.provider).toBe('cursor-sdk');
    expect(snapshot.session_id).toBe('agent-c910-1');
    expect(snapshot.branch).toBe('development/tasks/dev-1');

    const startCommand = runtime.handles[0].sent.find((m) => m.type === 'start');
    expect(startCommand.payload.worktree.linuxPath.startsWith('/mnt/')).toBe(true);
    expect(JSON.stringify(startCommand)).not.toContain(API_KEY);

    await new Promise((r) => setTimeout(r, 20));
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const entry = registry['agent-c910-1'];
    expect(entry.taskId).toBe('dev-1');
    expect(entry.branch).toBe('development/tasks/dev-1');
    expect(entry.worktreeId).toBe('.worktrees/dev-1');
    expect(entry.runId).toBe('run-c910-1');
    expect(entry.provider).toBe('cursor-sdk');
    expect(entry.lastState).toBe('RUNNING');
    expect(entry.updatedAt).toBeTruthy();

    const raw = fs.readFileSync(registryPath, 'utf8');
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toMatch(/CURSOR_API_KEY/i);
    const logRaw = fs.readFileSync(path.join(repoRoot, 'var', 'development', 'agent-logs', 'agent-c910-1.log'), 'utf8');
    expect(logRaw).not.toContain(API_KEY);
  });

  it('refuses to start when the runtime is not ready', async () => {
    const runtime = createFakeRuntime({
      repoRoot,
      health: { ok: false, reason: 'Development agent unavailable: Linux Cursor runtime is not prepared in WSL' },
    });
    const supervisor = supervisorWith(runtime);
    await expect(supervisor.startSession({ id: 'dev-1' }, approvedWorktree())).rejects.toThrow(/not prepared/);
    expect(runtime.spawnCount).toBe(0);
  });

  it('redacts secrets that leak through runtime messages', async () => {
    const runtime = createFakeRuntime({
      repoRoot,
      onCommand: (handle, message) => {
        if (message.type !== 'start') return;
        handle.emit({ type: 'started', sessionId: 'agent-c910-1' });
        handle.emit({ type: 'message', message: `used ${API_KEY} in shell` });
      },
    });
    const supervisor = supervisorWith(runtime);
    await supervisor.startSession({ id: 'dev-1' }, approvedWorktree());
    await new Promise((r) => setTimeout(r, 20));
    const snapshot = await supervisor.getSessionSnapshot('agent-c910-1');
    expect(snapshot.last_message).not.toContain(API_KEY);
    expect(fs.readFileSync(registryPath, 'utf8')).not.toContain(API_KEY);
  });

  it('maps a runtime crash to FAILED with a public reason and does not respawn', async () => {
    const runtime = createFakeRuntime({ repoRoot, onCommand: agentScript });
    const supervisor = supervisorWith(runtime);
    await supervisor.startSession({ id: 'dev-1' }, approvedWorktree());
    runtime.handles[0].exit(9, [`crash near /home/tester/.airvix with ${API_KEY}`]);

    const snapshot = await supervisor.getSessionSnapshot('agent-c910-1');
    expect(snapshot.state).toBe('FAILED');
    expect(snapshot.error).toMatch(/Development agent unavailable/);
    expect(snapshot.error).not.toContain(API_KEY);
    expect(runtime.spawnCount).toBe(1);
  });

  it('cancels through the runtime and reports NOT_SUPPORTED when unavailable', async () => {
    const runtime = createFakeRuntime({ repoRoot, onCommand: agentScript });
    const supervisor = supervisorWith(runtime);
    await supervisor.startSession({ id: 'dev-1' }, approvedWorktree());
    const cancelled = await supervisor.cancelSession('agent-c910-1');
    expect(cancelled.state).toBe('CANCELLED');
    expect(runtime.handles[0].sent.some((m) => m.type === 'cancel')).toBe(true);
    expect(runtime.handles[0].closed).toBe(true);

    const unsupportedRuntime = createFakeRuntime({
      repoRoot,
      onCommand: (handle, message) => {
        if (message.type === 'start') {
          handle.emit({ type: 'started', sessionId: 'agent-c910-2' });
          return;
        }
        if (message.type === 'cancel') handle.emit({ type: 'unsupported', operation: 'cancel' });
      },
    });
    const second = createWslCursorAgentSupervisor({
      repoRoot,
      apiKey: API_KEY,
      runtime: unsupportedRuntime,
      registryPath: path.join(repoRoot, 'var', 'development', 'agent-registry-2.json'),
      logStore: createCursorAgentLogStore({ repoRoot }),
    });
    await second.startSession({ id: 'dev-1' }, approvedWorktree());
    await expect(second.cancelSession('agent-c910-2')).rejects.toThrow(/NOT_SUPPORTED/);
  });

  it('resumes a persisted session after a host restart', async () => {
    const first = supervisorWith(createFakeRuntime({ repoRoot, onCommand: agentScript }));
    await first.startSession({ id: 'dev-1' }, approvedWorktree());
    await new Promise((r) => setTimeout(r, 20));

    const resumedRuntime = createFakeRuntime({ repoRoot, onCommand: agentScript });
    const second = supervisorWith(resumedRuntime);
    const snapshot = await second.getSessionSnapshot('agent-c910-1');

    expect(snapshot.session_id).toBe('agent-c910-1');
    expect(snapshot.branch).toBe('development/tasks/dev-1');
    const resumeCommand = resumedRuntime.handles[0].sent.find((m) => m.type === 'resume');
    expect(resumeCommand.payload.sessionId).toBe('agent-c910-1');
    expect(resumeCommand.payload.runId).toBe('run-c910-1');
    expect(resumeCommand.payload.worktree.linuxPath.startsWith('/mnt/')).toBe(true);
  });

  it('reports truthfully when a resumed worktree no longer exists', async () => {
    const first = supervisorWith(createFakeRuntime({ repoRoot, onCommand: agentScript }));
    await first.startSession({ id: 'dev-1' }, approvedWorktree());
    await new Promise((r) => setTimeout(r, 20));
    fs.rmSync(path.join(repoRoot, '.worktrees', 'dev-1'), { recursive: true, force: true });

    const runtime = createFakeRuntime({ repoRoot, onCommand: agentScript });
    const second = supervisorWith(runtime);
    await expect(second.getSessionSnapshot('agent-c910-1')).rejects.toThrow(/worktree no longer exists/);
    expect(runtime.spawnCount).toBe(0);
  });

  it('does not resume unknown sessions', async () => {
    const supervisor = supervisorWith(createFakeRuntime({ repoRoot }));
    await expect(supervisor.getSessionSnapshot('agent-does-not-exist')).rejects.toThrow(/not found/);
  });

  it('isolates two concurrent sessions and keeps registries/logs separate', async () => {
    fs.mkdirSync(path.join(repoRoot, '.worktrees', 'dev-2'), { recursive: true });
    let seq = 0;
    const runtime = createFakeRuntime({
      repoRoot,
      onCommand: (handle, message) => {
        if (message.type !== 'start') return;
        seq += 1;
        const id = `agent-c910-concurrent-${seq}`;
        handle.emit({ type: 'started', sessionId: id });
        handle.emit({ type: 'state', state: 'RUNNING', runId: `run-${seq}` });
        handle.emit({ type: 'message', message: `session ${id}` });
        if (seq === 2) {
          handle.emit({ type: 'error', message: 'simulated agent failure' });
          handle.emit({ type: 'finished', state: 'FAILED', runId: `run-${seq}` });
        }
      },
    });
    const supervisor = supervisorWith(runtime);
    const [a, b] = await Promise.all([
      supervisor.startSession({ id: 'dev-1', title: 'A' }, approvedWorktree('dev-1')),
      supervisor.startSession({ id: 'dev-2', title: 'B' }, approvedWorktree('dev-2')),
    ]);
    expect(a.session_id).not.toBe(b.session_id);
    expect(runtime.spawnCount).toBe(2);
    expect(runtime.handles).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 30));
    const snapA = await supervisor.getSessionSnapshot(a.session_id);
    const snapB = await supervisor.getSessionSnapshot(b.session_id);
    expect(snapA.worktree).toBe('.worktrees/dev-1');
    expect(snapB.worktree).toBe('.worktrees/dev-2');
    expect(snapA.last_message).not.toContain(snapB.session_id);
    expect(snapB.state).toBe('FAILED');
    expect(snapA.state).not.toBe('FAILED');

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(Object.keys(registry).sort()).toEqual([a.session_id, b.session_id].sort());
    expect(registry[a.session_id].worktreeId).toBe('.worktrees/dev-1');
    expect(registry[b.session_id].worktreeId).toBe('.worktrees/dev-2');

    const logA = path.join(repoRoot, 'var', 'development', 'agent-logs', `${a.session_id}.log`);
    const logB = path.join(repoRoot, 'var', 'development', 'agent-logs', `${b.session_id}.log`);
    expect(fs.existsSync(logA)).toBe(true);
    expect(fs.existsSync(logB)).toBe(true);
    expect(fs.readFileSync(logA, 'utf8')).not.toContain(b.session_id);
  });

  it('completes the happy path start → running → finished', async () => {
    const runtime = createFakeRuntime({
      repoRoot,
      onCommand: (handle, message) => {
        if (message.type !== 'start') return;
        handle.emit({ type: 'started', sessionId: 'agent-c910-finish' });
        handle.emit({ type: 'state', state: 'RUNNING', runId: 'run-finish' });
        handle.emit({ type: 'message', message: 'done' });
        handle.emit({ type: 'finished', state: 'SUCCEEDED', runId: 'run-finish' });
      },
    });
    const supervisor = supervisorWith(runtime);
    await supervisor.startSession({ id: 'dev-1' }, approvedWorktree());
    await new Promise((r) => setTimeout(r, 30));
    const snap = await supervisor.getSessionSnapshot('agent-c910-finish');
    expect(snap.state).toBe('SUCCEEDED');
    expect(runtime.spawnCount).toBe(1);
  });

  it('does not restart after a runtime crash (no infinite loop)', async () => {
    const runtime = createFakeRuntime({ repoRoot, onCommand: agentScript });
    const supervisor = supervisorWith(runtime);
    await supervisor.startSession({ id: 'dev-1' }, approvedWorktree());
    runtime.handles[0].exit(1, ['crash']);
    await supervisor.getSessionSnapshot('agent-c910-1');
    await expect(supervisor.sendInstruction('agent-c910-1', 'again')).rejects.toThrow(/unavailable|exited/i);
    expect(runtime.spawnCount).toBe(1);
  });
});

describe('tool policy enforcement', () => {
  it('does not allow write, webSearch, mcp, or task in the approved set', () => {
    expect(CURSOR_AGENT_ALLOWED_TOOLS).not.toContain('write');
    expect(CURSOR_AGENT_ALLOWED_TOOLS).not.toContain('webSearch');
    expect(CURSOR_AGENT_ALLOWED_TOOLS).not.toContain('mcp');
    expect(CURSOR_AGENT_ALLOWED_TOOLS).not.toContain('task');
    expect(CURSOR_AGENT_ALLOWED_TOOLS).not.toContain('delete');
    expect([...CURSOR_AGENT_ALLOWED_TOOLS]).toEqual(['read', 'grep', 'glob', 'ls', 'edit', 'shell']);
  });
});

describe('secret boundary on spawn argv', () => {
  it('never places the api key into wsl argv', async () => {
    const { runtime, children } = runtimeWithFakes();
    const sessionPromise = runtime.spawnSession({ apiKey: API_KEY });
    await new Promise((r) => setImmediate(r));
    children[0].emitLine({ type: 'hello' });
    await sessionPromise;
    const argvDump = children[0].spawnArgs.join(' ');
    expect(argvDump).not.toContain(API_KEY);
    expect(argvDump).not.toMatch(/CURSOR_API_KEY/i);
    expect(children[0].spawnEnv.WSLENV).toMatch(/CURSOR_API_KEY\/u/);
  });
});

describe('linux runtime entrypoint contract', () => {
  const entrypointSource = fs.readFileSync(
    path.resolve('lib/wsl-runtime/cursor-agent-entrypoint.mjs'),
    'utf8',
  );

  it('owns the tool policy and keeps it in sync with the shared policy module', () => {
    const match = /const ALLOWED_TOOLS = \[([^\]]+)\]/.exec(entrypointSource);
    expect(match).toBeTruthy();
    const tools = match[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    expect(tools).toEqual([...CURSOR_AGENT_ALLOWED_TOOLS]);
  });

  it('hardcodes sandbox and empty setting sources', () => {
    expect(entrypointSource).toContain('sandboxOptions: { enabled: true }');
    expect(entrypointSource).toContain('settingSources: []');
  });

  it('imports nothing from the windows repository', () => {
    const imports = [...entrypointSource.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['fs', 'path', 'readline', 'url']);
    expect(entrypointSource).toContain("import.meta.resolve('@cursor/sdk')");
    expect(entrypointSource).toContain('escaped the Linux runtime prefix');
  });

  it('reads the api key from the environment only', () => {
    expect(entrypointSource).toContain('process.env.CURSOR_API_KEY');
    expect(entrypointSource).not.toMatch(/payload\??\.\s*apiKey/);
  });
});
