import fs from 'fs';
import path from 'path';
import { buildCursorTaskPrompt } from './cursor-task-prompt.mjs';
import { buildCursorAgentOptions } from './cursor-agent-tool-policy.mjs';
import { resolveApprovedWorktree } from './cursor-agent-worktree-guard.mjs';
import { createCursorAgentLogStore } from './cursor-agent-log-store.mjs';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function nowIso() {
  return new Date().toISOString();
}

function mapRunStatusToVlc(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'finished') return 'SUCCEEDED';
  if (s === 'error') return 'FAILED';
  if (s === 'cancelled') return 'CANCELLED';
  if (s === 'running') return 'RUNNING';
  return 'QUEUED';
}

function extractAssistantText(event) {
  if (!event || event.type !== 'assistant') return '';
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text)
    .join('');
}

export function createCursorAgentSupervisor(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const apiKey = String(opts.apiKey || '').trim();
  const modelId = String(opts.model || opts.modelId || 'composer-2.5').trim();
  const adapter = opts.adapter;
  if (!adapter) throw new Error('Cursor SDK adapter required');
  if (!apiKey) throw new Error('CURSOR_API_KEY required');

  const logStore = opts.logStore || createCursorAgentLogStore({ repoRoot });
  const registryPath = path.resolve(
    opts.registryPath || path.join(repoRoot, 'var', 'development', 'agent-registry.json'),
  );
  const sessions = new Map();

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
    fs.writeFileSync(registryPath, JSON.stringify(next, null, 2), 'utf8');
  }

  function persistRegistryEntry(sessionId, entry) {
    const all = readRegistry();
    all[sessionId] = entry;
    writeRegistry(all);
  }

  function removeRegistryEntry(sessionId) {
    const all = readRegistry();
    delete all[sessionId];
    writeRegistry(all);
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

  async function buildAgentOptions(absWorktree) {
    return buildCursorAgentOptions({ cwd: absWorktree, model: modelId, apiKey });
  }

  async function consumeStream(rec, run) {
    rec.state = 'RUNNING';
    rec.updatedAt = nowIso();
    try {
      for await (const event of run.stream()) {
        const text = extractAssistantText(event);
        if (text) {
          rec.lastMessage = text.slice(-500);
          const logged = logStore.append(rec.sessionId, text);
          rec.logRef = logged.log_ref;
          rec.outputExcerpt = logStore.readExcerpt(rec.sessionId);
        }
        rec.updatedAt = nowIso();
      }
    } catch (err) {
      if (rec.state !== 'CANCELLED') {
        rec.state = 'FAILED';
        rec.error = String(err?.message || err);
        rec.lastMessage = rec.error;
      }
    }
  }

  async function finalizeRun(rec, run) {
    try {
      const result = await run.wait();
      const mapped = mapRunStatusToVlc(result?.status || run.status);
      rec.state = mapped;
      rec.updatedAt = nowIso();
      if (mapped === 'FAILED') {
        rec.error = String(result?.error || 'Agent run failed');
        rec.lastMessage = rec.error;
      } else if (mapped === 'SUCCEEDED') {
        rec.lastMessage = String(result?.result || rec.lastMessage || 'Agent completed');
        rec.error = null;
      } else if (mapped === 'CANCELLED') {
        rec.lastMessage = rec.lastMessage || 'Session cancelled';
        rec.error = null;
      }
      rec.outputExcerpt = logStore.readExcerpt(rec.sessionId);
    } catch (err) {
      if (rec.state !== 'CANCELLED') {
        rec.state = 'FAILED';
        rec.error = String(err?.message || err);
        rec.lastMessage = rec.error;
      }
    } finally {
      persistRegistryEntry(rec.sessionId, {
        taskId: rec.taskId,
        sessionId: rec.sessionId,
        runId: rec.runId,
        branch: rec.branch,
        worktreeId: rec.worktreeId,
        absWorktree: rec.absWorktree,
        state: rec.state,
        updatedAt: rec.updatedAt,
      });
      if (TERMINAL.has(rec.state)) {
        await cleanupSession(rec.sessionId, { keepRegistry: true });
      }
    }
  }

  async function attachRunLoop(rec, run) {
    rec.run = run;
    rec.runId = run.id;
    rec.state = 'QUEUED';
    rec.updatedAt = nowIso();
    persistRegistryEntry(rec.sessionId, {
      taskId: rec.taskId,
      sessionId: rec.sessionId,
      runId: rec.runId,
      branch: rec.branch,
      worktreeId: rec.worktreeId,
      absWorktree: rec.absWorktree,
      state: rec.state,
      updatedAt: rec.updatedAt,
    });
    sessions.set(rec.sessionId, rec);
    rec.background = (async () => {
      await consumeStream(rec, run);
      if (rec.state === 'RUNNING') await finalizeRun(rec, run);
    })();
  }

  async function startSession(task, worktree) {
    const ctx = resolveApprovedWorktree(repoRoot, worktree);
    const prompt = buildCursorTaskPrompt(task, ctx);
    const agent = await adapter.createAgent(await buildAgentOptions(ctx.absWorktree));
    const run = await agent.send(prompt);
    const rec = {
      taskId: String(task?.id || ''),
      sessionId: agent.agentId,
      branch: ctx.branch,
      worktreeId: ctx.worktree_id,
      absWorktree: ctx.absWorktree,
      agent,
      run,
      runId: null,
      state: 'QUEUED',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      lastMessage: 'Session created',
      progress: null,
      error: null,
      logRef: logStore.logRefFor(agent.agentId),
      outputExcerpt: null,
      background: null,
    };
    await attachRunLoop(rec, run);
    return snapshotFromRecord(rec);
  }

  async function hydrateSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('Agent session not found');
    if (sessions.has(id)) return sessions.get(id);

    const reg = readRegistry()[id];
    if (!reg?.absWorktree) throw new Error('Agent session not found');

    let agent;
    try {
      agent = await adapter.resumeAgent(id, await buildAgentOptions(reg.absWorktree));
    } catch (err) {
      throw new Error(`Agent resume unavailable: ${String(err?.message || err)}`);
    }

    let run = null;
    if (reg.runId) {
      try {
        run = await adapter.getRun(reg.runId, { runtime: 'local', agentId: id, apiKey });
      } catch {
        run = null;
      }
    }
    if (!run) {
      const listed = await adapter.listRuns(id, { runtime: 'local', apiKey, limit: 1 });
      run = listed?.items?.[0] || null;
    }

    const rec = {
      taskId: reg.taskId || '',
      sessionId: id,
      branch: reg.branch,
      worktreeId: reg.worktreeId,
      absWorktree: reg.absWorktree,
      agent,
      run,
      runId: run?.id || reg.runId || null,
      state: mapRunStatusToVlc(run?.status || reg.state || 'RUNNING'),
      startedAt: reg.startedAt || reg.updatedAt || nowIso(),
      updatedAt: reg.updatedAt || nowIso(),
      lastMessage: reg.lastMessage || 'Session resumed',
      progress: null,
      error: reg.error || null,
      logRef: logStore.logRefFor(id),
      outputExcerpt: logStore.readExcerpt(id),
      background: null,
      resumed: true,
    };

    if (run && rec.state === 'RUNNING') {
      await attachRunLoop(rec, run);
    } else {
      sessions.set(id, rec);
    }
    return rec;
  }

  async function getSessionSnapshot(sessionId) {
    let rec = sessions.get(String(sessionId || ''));
    if (!rec) rec = await hydrateSession(sessionId);
    if (rec.background) {
      await Promise.race([
        rec.background.catch(() => {}),
        new Promise((r) => setTimeout(r, 0)),
      ]);
    }
    if (rec.run?.status) {
      const mapped = mapRunStatusToVlc(rec.run.status);
      if (mapped !== rec.state && !TERMINAL.has(rec.state)) rec.state = mapped;
    }
    rec.updatedAt = nowIso();
    rec.outputExcerpt = logStore.readExcerpt(rec.sessionId);
    return snapshotFromRecord(rec);
  }

  async function cancelSession(sessionId) {
    let rec = sessions.get(String(sessionId || ''));
    if (!rec) rec = await hydrateSession(sessionId);
    if (!rec.run) throw new Error('NOT_SUPPORTED');
    if (!rec.run.supports?.('cancel')) throw new Error('NOT_SUPPORTED');
    await rec.run.cancel();
    rec.state = 'CANCELLED';
    rec.updatedAt = nowIso();
    rec.lastMessage = 'Session cancelled';
    rec.error = null;
    persistRegistryEntry(rec.sessionId, {
      taskId: rec.taskId,
      sessionId: rec.sessionId,
      runId: rec.runId,
      branch: rec.branch,
      worktreeId: rec.worktreeId,
      absWorktree: rec.absWorktree,
      state: rec.state,
      updatedAt: rec.updatedAt,
    });
    await cleanupSession(rec.sessionId, { keepRegistry: true });
    return snapshotFromRecord(rec);
  }

  async function sendInstruction(sessionId, instruction) {
    const rec = sessions.get(String(sessionId || '')) || await hydrateSession(sessionId);
    const text = String(instruction || '').trim();
    if (!text) throw new Error('instruction required');
    const run = await rec.agent.send(text);
    rec.run = run;
    rec.runId = run.id;
    rec.state = 'RUNNING';
    rec.lastMessage = text.slice(0, 500);
    rec.updatedAt = nowIso();
    await attachRunLoop(rec, run);
    return snapshotFromRecord(rec);
  }

  async function cleanupSession(sessionId, opts2 = {}) {
    const rec = sessions.get(sessionId);
    if (!rec) return;
    try {
      if (rec.agent?.close) await rec.agent.close();
      else if (rec.agent?.[Symbol.asyncDispose]) await rec.agent[Symbol.asyncDispose]();
    } catch { /* ignore */ }
    sessions.delete(sessionId);
    if (!opts2.keepRegistry) removeRegistryEntry(sessionId);
  }

  return {
    startSession,
    getSessionSnapshot,
    cancelSession,
    sendInstruction,
    cleanupSession,
    logStore,
    registryPath,
    _sessions: sessions,
  };
}

export { mapRunStatusToVlc };
