import fs from 'fs';
import path from 'path';
import { buildCursorTaskPrompt } from './cursor-task-prompt.mjs';
import { createCursorAgentLogStore } from './cursor-agent-log-store.mjs';
import { createWslCursorAgentRuntime } from './wsl-cursor-agent-runtime.mjs';
import { publicUnavailableReason, redactSecrets } from './wsl-cursor-secret.mjs';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const MAX_RESUME_ATTEMPTS = 1;
const PENDING_PREFIX = 'pending-';

function nowIso() {
  return new Date().toISOString();
}

function snapshotFromRecord(rec) {
  return {
    provider: 'cursor-sdk',
    session_id: rec.sessionId,
    state: rec.state,
    branch: rec.branch,
    worktree: rec.worktreeId,
    started_at: rec.startedAt,
    updated_at: rec.updatedAt,
    last_message: rec.lastMessage,
    progress: rec.progress ?? null,
    error: rec.error ?? null,
    log_ref: rec.logRef ?? null,
    output_excerpt: rec.outputExcerpt ?? null,
  };
}

export function createWslCursorAgentSupervisor(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const apiKey = String(opts.apiKey || '').trim();
  const modelId = String(opts.model || opts.modelId || 'composer-2.5').trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY required');
  if (!/^[A-Za-z0-9._-]+$/.test(modelId)) throw new Error('invalid model id');

  const runtime = opts.runtime || createWslCursorAgentRuntime({
    repoRoot,
    apiKey,
    distro: opts.distro,
    env: opts.env,
    spawn: opts.spawn,
    spawnSync: opts.spawnSync,
    wslExe: opts.wslExe,
    platform: opts.platform,
  });
  const logStore = opts.logStore || createCursorAgentLogStore({ repoRoot });
  const registryPath = path.resolve(
    opts.registryPath || path.join(repoRoot, 'var', 'development', 'agent-registry.json'),
  );
  const sessions = new Map();
  const secrets = [apiKey];

  function readRegistry() {
    if (!fs.existsSync(registryPath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeRegistry(next) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const dump = JSON.stringify(next, null, 2);
    if (dump.includes(apiKey) || /CURSOR_API_KEY/i.test(dump)) {
      throw new Error('refusing to persist secret');
    }
    fs.writeFileSync(registryPath, dump, 'utf8');
  }

  function persistRegistryEntry(rec) {
    const all = readRegistry();
    all[rec.sessionId] = {
      provider: 'cursor-sdk',
      taskId: rec.taskId,
      sessionId: rec.sessionId,
      runId: rec.runId,
      worktreeId: rec.worktreeId,
      branch: rec.branch,
      absWorktree: rec.absWorktree,
      linuxWorktree: rec.linuxWorktree,
      lastState: rec.state,
      lastMessage: rec.lastMessage ? redactSecrets(rec.lastMessage, secrets) : null,
      updatedAt: rec.updatedAt,
    };
    writeRegistry(all);
  }

  function applyEvent(rec, ev) {
    rec.updatedAt = nowIso();
    if (ev.type === 'started' && ev.sessionId) {
      rec.sessionId = ev.sessionId;
      rec.runId = ev.runId || rec.runId;
      rec.state = 'QUEUED';
      rec.lastMessage = rec.lastMessage || 'Session created';
    } else if (ev.type === 'state' && ev.state) {
      rec.state = String(ev.state).toUpperCase();
      rec.runId = ev.runId || rec.runId;
    } else if (ev.type === 'message' && ev.message) {
      const text = redactSecrets(String(ev.message), secrets).slice(-500);
      rec.lastMessage = text;
      const logged = logStore.append(rec.sessionId, text);
      rec.logRef = logged.log_ref;
      rec.outputExcerpt = logStore.readExcerpt(rec.sessionId);
    } else if (ev.type === 'finished') {
      rec.state = String(ev.state || 'SUCCEEDED').toUpperCase();
      rec.runId = ev.runId || rec.runId;
      if (rec.state === 'FAILED') rec.error = rec.error || rec.lastMessage || 'Agent run failed';
      if (rec.state === 'SUCCEEDED') rec.error = null;
    } else if (ev.type === 'cancelled') {
      rec.state = 'CANCELLED';
      rec.lastMessage = 'Session cancelled';
      rec.error = null;
    } else if (ev.type === 'unsupported') {
      rec.error = 'NOT_SUPPORTED';
    } else if (ev.type === 'error') {
      rec.state = rec.state === 'CANCELLED' ? rec.state : 'FAILED';
      rec.error = publicUnavailableReason(ev.message || 'WSL runtime error', secrets);
      rec.lastMessage = rec.error;
    }
    rec.outputExcerpt = logStore.readExcerpt(rec.sessionId);
    // A session only enters the registry once the runtime reported its real id.
    if (rec.sessionId && !rec.sessionId.startsWith(PENDING_PREFIX)) persistRegistryEntry(rec);
    if (TERMINAL.has(rec.state) && rec.handle && ev.type !== 'cancelled') {
      const handle = rec.handle;
      rec.handle = null;
      void Promise.resolve(handle.close()).catch(() => {});
    }
  }

  function bindHandle(rec, handle) {
    rec.handle = handle;
    handle.onEvent((ev) => applyEvent(rec, ev));
    handle.onExit(({ code, stderr }) => {
      if (TERMINAL.has(rec.state)) return;
      rec.state = 'FAILED';
      rec.updatedAt = nowIso();
      rec.error = publicUnavailableReason(
        code === 0 ? 'WSL runtime exited' : `WSL runtime exited (${code})`,
        secrets,
      );
      rec.lastMessage = rec.error;
      if (stderr?.length) logStore.append(rec.sessionId, redactSecrets(stderr.join('\n'), secrets));
      persistRegistryEntry(rec);
    });
  }

  async function startSession(task, worktree) {
    const health = await runtime.probeHealth();
    if (!health.ok) {
      throw new Error(health.reason || 'Development agent unavailable');
    }
    const mapped = runtime.mapWorktree(worktree);
    const prompt = buildCursorTaskPrompt(task, mapped);
    const handle = await runtime.spawnSession({ apiKey });
    const rec = {
      taskId: String(task?.id || ''),
      sessionId: `${PENDING_PREFIX}${Date.now().toString(36)}`,
      runId: null,
      branch: mapped.branch,
      worktreeId: mapped.worktree_id,
      absWorktree: mapped.absWorktree,
      linuxWorktree: mapped.linuxPath,
      state: 'QUEUED',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      lastMessage: 'Session created',
      progress: null,
      error: null,
      logRef: null,
      outputExcerpt: null,
      handle,
      resumeAttempts: 0,
    };
    bindHandle(rec, handle);
    handle.send({
      type: 'start',
      payload: {
        model: modelId,
        prompt,
        task: {
          id: String(task?.id || ''),
          title: String(task?.title || '').slice(0, 200),
        },
        worktree: {
          linuxPath: mapped.linuxPath,
          branch: mapped.branch,
          worktreeId: mapped.worktree_id,
        },
      },
    });
    const started = await handle.waitFor((ev) => ev?.type === 'started' || ev?.type === 'error', 45000);
    if (started.type === 'error') {
      await handle.close();
      throw new Error(publicUnavailableReason(started.message || 'WSL runtime failed to start', secrets));
    }
    rec.sessionId = started.sessionId;
    rec.runId = started.runId || rec.runId;
    rec.logRef = logStore.logRefFor(rec.sessionId);
    sessions.set(rec.sessionId, rec);
    persistRegistryEntry(rec);
    return snapshotFromRecord(rec);
  }

  async function reconnect(reg) {
    if (!reg?.sessionId) throw new Error('Agent session not found');
    if ((reg.resumeAttempts || 0) >= MAX_RESUME_ATTEMPTS && !sessions.has(reg.sessionId)) {
      throw new Error('Development agent unavailable: Agent resume unavailable');
    }
    if (!reg.absWorktree || !fs.existsSync(reg.absWorktree)) {
      throw new Error('Development agent unavailable: task worktree no longer exists');
    }
    const handle = await runtime.spawnSession({ apiKey });
    const rec = {
      taskId: reg.taskId || '',
      sessionId: reg.sessionId,
      runId: reg.runId || null,
      branch: reg.branch,
      worktreeId: reg.worktreeId,
      absWorktree: reg.absWorktree,
      linuxWorktree: reg.linuxWorktree,
      state: String(reg.lastState || reg.state || 'RUNNING').toUpperCase(),
      startedAt: reg.startedAt || reg.updatedAt || nowIso(),
      updatedAt: nowIso(),
      lastMessage: redactSecrets(reg.lastMessage || 'Session resumed', secrets),
      progress: null,
      error: null,
      logRef: logStore.logRefFor(reg.sessionId),
      outputExcerpt: logStore.readExcerpt(reg.sessionId),
      handle,
      resumeAttempts: (reg.resumeAttempts || 0) + 1,
    };
    bindHandle(rec, handle);
    handle.send({
      type: 'resume',
      payload: {
        sessionId: rec.sessionId,
        runId: rec.runId,
        model: modelId,
        linuxPath: rec.linuxWorktree,
        worktree: { linuxPath: rec.linuxWorktree, branch: rec.branch, worktreeId: rec.worktreeId },
      },
    });
    try {
      await handle.waitFor((ev) => ev?.type === 'started' || ev?.type === 'ack' || ev?.type === 'error', 30000);
    } catch (err) {
      rec.state = 'FAILED';
      rec.error = publicUnavailableReason(err?.message || 'Agent resume unavailable', secrets);
      rec.lastMessage = rec.error;
      persistRegistryEntry(rec);
      throw new Error(rec.error);
    }
    sessions.set(rec.sessionId, rec);
    persistRegistryEntry(rec);
    return rec;
  }

  async function hydrateSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('Agent session not found');
    if (sessions.has(id)) return sessions.get(id);
    const reg = readRegistry()[id];
    if (!reg) throw new Error('Agent session not found');
    const terminal = TERMINAL.has(String(reg.lastState || '').toUpperCase());
    if (terminal) {
      const rec = {
        taskId: reg.taskId || '',
        sessionId: id,
        runId: reg.runId || null,
        branch: reg.branch,
        worktreeId: reg.worktreeId,
        absWorktree: reg.absWorktree,
        linuxWorktree: reg.linuxWorktree,
        state: String(reg.lastState).toUpperCase(),
        startedAt: reg.startedAt || reg.updatedAt || nowIso(),
        updatedAt: reg.updatedAt || nowIso(),
        lastMessage: redactSecrets(reg.lastMessage || '', secrets),
        progress: null,
        error: null,
        logRef: logStore.logRefFor(id),
        outputExcerpt: logStore.readExcerpt(id),
        handle: null,
        resumeAttempts: MAX_RESUME_ATTEMPTS,
      };
      sessions.set(id, rec);
      return rec;
    }
    try {
      return await reconnect(reg);
    } catch (err) {
      throw new Error(publicUnavailableReason(err?.message || 'Agent resume unavailable', secrets));
    }
  }

  async function getSessionSnapshot(sessionId) {
    const rec = sessions.get(String(sessionId || '')) || await hydrateSession(sessionId);
    rec.outputExcerpt = logStore.readExcerpt(rec.sessionId);
    rec.updatedAt = nowIso();
    return snapshotFromRecord(rec);
  }

  async function cancelSession(sessionId) {
    const rec = sessions.get(String(sessionId || '')) || await hydrateSession(sessionId);
    const handle = rec.handle;
    if (!handle) throw new Error('NOT_SUPPORTED');
    handle.send({ type: 'cancel' });
    const ev = await handle.waitFor(
      (e) => e?.type === 'cancelled' || e?.type === 'unsupported' || e?.type === 'finished',
      15000,
    );
    if (ev.type === 'unsupported') throw new Error('NOT_SUPPORTED');
    rec.state = 'CANCELLED';
    rec.lastMessage = 'Session cancelled';
    rec.error = null;
    rec.updatedAt = nowIso();
    persistRegistryEntry(rec);
    rec.handle = null;
    await handle.close();
    return snapshotFromRecord(rec);
  }

  async function sendInstruction(sessionId, instruction) {
    const rec = sessions.get(String(sessionId || '')) || await hydrateSession(sessionId);
    const text = String(instruction || '').trim();
    if (!text) throw new Error('instruction required');
    if (!rec.handle) throw new Error('Development agent unavailable: WSL runtime exited');
    rec.handle.send({ type: 'send', payload: { instruction: text.slice(0, 8000) } });
    rec.state = 'RUNNING';
    rec.lastMessage = redactSecrets(text, secrets).slice(0, 500);
    rec.updatedAt = nowIso();
    persistRegistryEntry(rec);
    return snapshotFromRecord(rec);
  }

  async function cleanupSession(sessionId, extra = {}) {
    const rec = sessions.get(sessionId);
    if (!rec) return;
    try { await rec.handle?.close?.(); } catch { /* ignore */ }
    sessions.delete(sessionId);
    if (!extra.keepRegistry) {
      const all = readRegistry();
      delete all[sessionId];
      writeRegistry(all);
    }
  }

  async function probeHealth() {
    return runtime.probeHealth();
  }

  return {
    startSession,
    getSessionSnapshot,
    cancelSession,
    sendInstruction,
    cleanupSession,
    probeHealth,
    logStore,
    registryPath,
    _sessions: sessions,
    _runtime: runtime,
    maxResumeAttempts: MAX_RESUME_ATTEMPTS,
  };
}

export { MAX_RESUME_ATTEMPTS };
