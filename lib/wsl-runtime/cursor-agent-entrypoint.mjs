/**
 * Linux-native Cursor agent runtime for Vision Landing Console.
 *
 * This file is staged into the WSL-local runtime prefix (see
 * lib/wsl-cursor-runtime-spec.mjs) and executed by Linux Node inside WSL. It is
 * deliberately dependency-free: the only module it imports beyond Node builtins
 * is `@cursor/sdk`, which must resolve from the runtime prefix's own
 * node_modules. Importing helpers from the Windows repository would let Node
 * walk up a /mnt/c path and load the Windows SDK install, whose sandbox helper
 * does not support sandboxing (C9.9-W).
 *
 * Protocol: newline-delimited JSON on stdin (commands) and stdout (events).
 * Nothing else may be written to stdout.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const PINNED_SDK_VERSION = '1.0.28';
const LINUX_PLATFORM_PACKAGE = '@cursor/sdk-linux-x64';

/**
 * Tool policy is owned by this file so the Windows side cannot widen it over
 * IPC. Must stay in sync with lib/cursor-agent-tool-policy.mjs (asserted by
 * tests/wsl-cursor-agent-runtime.test.mjs).
 */
const ALLOWED_TOOLS = ['read', 'grep', 'glob', 'ls', 'edit', 'shell'];
const COMMAND_TYPES = new Set(['start', 'resume', 'send', 'cancel', 'status', 'dispose']);
const MAX_LINE_BYTES = 256 * 1024;
const MODEL_ID_RE = /^[A-Za-z0-9._-]+$/;
const SECRET_RE = /cursor_[A-Za-z0-9_-]{16,}/g;

function redact(text) {
  let out = String(text ?? '');
  const key = String(process.env.CURSOR_API_KEY || '');
  if (key.length >= 8) out = out.split(key).join('[REDACTED]');
  return out.replace(SECRET_RE, '[REDACTED]').replace(/CURSOR_API_KEY[=:\s]+\S+/gi, 'CURSOR_API_KEY=[REDACTED]');
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitError(message) {
  emit({ type: 'error', message: redact(message).slice(0, 600) });
}

function sdkInfo() {
  const sdkPkg = path.join(RUNTIME_DIR, 'node_modules', '@cursor', 'sdk', 'package.json');
  const platformDir = path.join(RUNTIME_DIR, 'node_modules', ...LINUX_PLATFORM_PACKAGE.split('/'));
  if (!fs.existsSync(sdkPkg)) {
    return { ok: false, reason: 'Linux @cursor/sdk is not installed in the WSL runtime' };
  }
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(sdkPkg, 'utf8')).version || null;
  } catch {
    return { ok: false, reason: 'Linux @cursor/sdk install is unreadable' };
  }
  return {
    ok: true,
    version,
    platformPackagePresent: fs.existsSync(platformDir),
  };
}

async function loadSdk() {
  const resolved = import.meta.resolve('@cursor/sdk');
  const resolvedPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
  if (!resolvedPath.startsWith(`${RUNTIME_DIR}${path.sep}`)) {
    throw new Error('SDK resolution escaped the Linux runtime prefix');
  }
  const mod = await import(resolved);
  if (!mod?.Agent) throw new Error('Linux @cursor/sdk Agent export missing');
  return { mod, resolvedPath };
}

function mapRunStatus(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'finished') return 'SUCCEEDED';
  if (value === 'error') return 'FAILED';
  if (value === 'cancelled') return 'CANCELLED';
  if (value === 'running') return 'RUNNING';
  return 'QUEUED';
}

function assertWorktree(linuxPath) {
  const value = String(linuxPath || '');
  if (!value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error('invalid worktree path');
  }
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
    throw new Error('worktree directory is missing in WSL');
  }
  return value;
}

function assertModel(model) {
  const value = String(model || '').trim();
  if (!MODEL_ID_RE.test(value)) throw new Error('invalid model id');
  return value;
}

function agentOptions(cwd, model) {
  const apiKey = String(process.env.CURSOR_API_KEY || '').trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is not present in the WSL runtime environment');
  return {
    apiKey,
    model: { id: model },
    tools: [...ALLOWED_TOOLS],
    local: {
      cwd,
      settingSources: [],
      sandboxOptions: { enabled: true },
    },
  };
}

function assistantText(event) {
  if (!event || event.type !== 'assistant') return '';
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('');
}

async function runHealth() {
  const info = sdkInfo();
  if (!info.ok) {
    emit({ type: 'health', ok: false, reason: info.reason, node: process.versions.node });
    return;
  }
  let resolvedPath = null;
  try {
    resolvedPath = (await loadSdk()).resolvedPath;
  } catch (err) {
    emit({ type: 'health', ok: false, reason: redact(String(err?.message || err)), node: process.versions.node });
    return;
  }
  emit({
    type: 'health',
    ok: true,
    node: process.versions.node,
    sdkVersion: info.version,
    sdkPath: resolvedPath,
    platformPackage: LINUX_PLATFORM_PACKAGE,
    platformPackagePresent: info.platformPackagePresent,
    pinnedSdkVersion: PINNED_SDK_VERSION,
    sandboxEnabled: true,
    settingSourceCount: 0,
    tools: [...ALLOWED_TOOLS],
    runtimeDir: RUNTIME_DIR,
  });
}

function createSession() {
  const state = {
    sdk: null,
    agent: null,
    run: null,
    sessionId: null,
    runId: null,
    cwd: null,
    model: null,
    lastState: 'QUEUED',
    watching: null,
    disposed: false,
  };

  async function sdk() {
    if (!state.sdk) state.sdk = await loadSdk();
    return state.sdk.mod;
  }

  function watchRun(run) {
    state.run = run;
    state.runId = run.id;
    state.lastState = 'RUNNING';
    emit({ type: 'state', state: 'RUNNING', runId: run.id });
    state.watching = (async () => {
      try {
        for await (const event of run.stream()) {
          const text = assistantText(event);
          if (text) emit({ type: 'message', message: redact(text).slice(-2000) });
        }
      } catch (err) {
        emitError(`agent stream failed: ${String(err?.message || err)}`);
      }
      try {
        const result = await run.wait();
        const mapped = mapRunStatus(result?.status || run.status);
        state.lastState = mapped;
        const errorText = result?.error?.message || (typeof result?.error === 'string' ? result.error : null);
        emit({
          type: 'finished',
          state: mapped,
          runId: run.id,
          message: result?.result ? redact(String(result.result)).slice(-2000) : null,
          error: errorText ? redact(String(errorText)).slice(0, 600) : null,
        });
      } catch (err) {
        state.lastState = 'FAILED';
        emitError(`agent run failed: ${String(err?.message || err)}`);
      }
    })();
  }

  async function start(payload) {
    if (state.agent) throw new Error('session already started');
    const cwd = assertWorktree(payload?.worktree?.linuxPath);
    const model = assertModel(payload?.model);
    const prompt = String(payload?.prompt || '').trim();
    if (!prompt) throw new Error('prompt required');
    const { Agent } = await sdk();
    state.agent = await Agent.create(agentOptions(cwd, model));
    state.cwd = cwd;
    state.model = model;
    state.sessionId = state.agent.agentId;
    emit({ type: 'started', sessionId: state.sessionId, sdkVersion: PINNED_SDK_VERSION });
    watchRun(await state.agent.send(prompt));
  }

  async function resume(payload) {
    const cwd = assertWorktree(payload?.worktree?.linuxPath || payload?.linuxPath);
    const model = assertModel(payload?.model);
    const sessionId = String(payload?.sessionId || '').trim();
    if (!sessionId) throw new Error('sessionId required');
    const { Agent } = await sdk();
    state.agent = await Agent.resume(sessionId, agentOptions(cwd, model));
    state.cwd = cwd;
    state.model = model;
    state.sessionId = state.agent.agentId || sessionId;
    emit({ type: 'started', sessionId: state.sessionId, resumed: true });

    let run = null;
    const runId = String(payload?.runId || '').trim();
    if (runId) {
      try {
        run = await Agent.getRun(runId, { runtime: 'local', cwd });
      } catch {
        run = null;
      }
    }
    if (!run) {
      try {
        const listed = await Agent.listRuns(state.sessionId, { runtime: 'local', cwd, limit: 1 });
        run = listed?.items?.[0] || null;
      } catch {
        run = null;
      }
    }
    if (!run) {
      emit({ type: 'state', state: state.lastState, runId: null, recovered: false });
      return;
    }
    const mapped = mapRunStatus(run.status);
    if (mapped === 'RUNNING') {
      watchRun(run);
      return;
    }
    state.run = run;
    state.runId = run.id;
    state.lastState = mapped;
    emit({ type: 'finished', state: mapped, runId: run.id, message: null, error: null });
  }

  async function send(payload) {
    if (!state.agent) throw new Error('session is not started');
    const instruction = String(payload?.instruction || '').trim();
    if (!instruction) throw new Error('instruction required');
    watchRun(await state.agent.send(instruction));
  }

  async function cancel() {
    if (!state.run || typeof state.run.cancel !== 'function') {
      emit({ type: 'unsupported', operation: 'cancel' });
      return;
    }
    if (typeof state.run.supports === 'function' && !state.run.supports('cancel')) {
      emit({ type: 'unsupported', operation: 'cancel' });
      return;
    }
    await state.run.cancel();
    state.lastState = 'CANCELLED';
    emit({ type: 'cancelled', runId: state.runId });
  }

  async function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    try {
      if (state.agent?.close) await state.agent.close();
      else if (state.agent?.[Symbol.asyncDispose]) await state.agent[Symbol.asyncDispose]();
    } catch {
      /* ignore */
    }
    emit({ type: 'ack', operation: 'dispose' });
  }

  return {
    async handle(message) {
      switch (message.type) {
        case 'start':
          await start(message.payload);
          return;
        case 'resume':
          await resume(message.payload);
          return;
        case 'send':
          await send(message.payload);
          return;
        case 'cancel':
          await cancel();
          return;
        case 'status':
          emit({ type: 'state', state: state.lastState, runId: state.runId, sessionId: state.sessionId });
          return;
        case 'dispose':
          await dispose();
          process.exitCode = 0;
          process.stdin.pause();
          return;
        default:
          throw new Error('unsupported command');
      }
    },
    dispose,
  };
}

function parseCommand(line) {
  const raw = String(line || '').trim();
  if (!raw) throw new Error('empty command');
  if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) throw new Error('command too large');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('command is not json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('command must be an object');
  if (typeof parsed.type !== 'string' || !COMMAND_TYPES.has(parsed.type)) throw new Error('command type is not allowed');
  if (parsed.payload != null && (typeof parsed.payload !== 'object' || Array.isArray(parsed.payload))) {
    throw new Error('command payload must be an object');
  }
  return parsed;
}

async function runSession() {
  const info = sdkInfo();
  if (!info.ok) {
    emitError(info.reason);
    process.exitCode = 1;
    return;
  }
  emit({ type: 'hello', node: process.versions.node, sdkVersion: info.version, pid: process.pid });

  const session = createSession();
  let chain = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    chain = chain.then(async () => {
      let command;
      try {
        command = parseCommand(line);
      } catch (err) {
        emitError(`malformed command: ${String(err?.message || err)}`);
        return;
      }
      try {
        await session.handle(command);
      } catch (err) {
        emitError(String(err?.message || err));
      }
    });
  });

  await new Promise((resolve) => rl.on('close', resolve));
  await chain.catch(() => {});
  await session.dispose();
}

async function main() {
  if (process.argv.includes('--health')) {
    await runHealth();
    return;
  }
  await runSession();
}

main().catch((err) => {
  emitError(String(err?.message || err));
  process.exitCode = 1;
});
