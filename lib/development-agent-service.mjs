import { DEV_AGENT_STATES } from './development-task-store.mjs';

function normalizeAgentState(state) {
  const s = String(state || '').trim().toUpperCase();
  return DEV_AGENT_STATES.includes(s) ? s : 'WAITING';
}

export function createDevelopmentAgentService({ store, provider, worktreeManager }) {
  if (!store) throw new Error('store required');
  if (!provider) throw new Error('provider required');

  async function startTaskAgent(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    if (task.agent?.state && !['NOT_STARTED', 'FAILED', 'CANCELLED'].includes(task.agent.state)) {
      throw new Error(`agent already active: ${task.agent.state}`);
    }
    if (!worktreeManager) throw new Error('worktree manager required');
    const wt = worktreeManager.status(task.id);
    if (!wt.exists) throw new Error('worktree required before starting agent');
    if (!wt.branch.startsWith('development/tasks/')) throw new Error('unsafe agent branch target');
    const session = await provider.createSession({
      id: task.id,
      title: task.title,
      description: task.description,
      notes: task.notes,
      target_area: task.target_area,
      priority: task.priority,
      repository_context: { repo: 'current', branch: wt.branch, worktree_id: wt.worktree_id },
      worktree: {
        branch: wt.branch,
        worktree_id: wt.worktree_id,
        base_commit: wt.base_commit,
      },
    }, {
      branch: wt.branch,
      worktree_id: wt.worktree_id,
      base_commit: wt.base_commit,
    });
    const started = store.startAgent(task.id, {
      provider: session.provider || provider.providerName,
      session_id: session.session_id,
      branch: session.branch,
      worktree: session.worktree,
      last_message: session.last_message || 'Agent started',
      progress: session.progress ?? null,
      log_ref: session.log_ref ?? null,
      output_excerpt: session.output_excerpt ?? null,
    });
    return started;
  }

  async function getTaskAgent(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const sessionId = task.agent?.session_id;
    if (!sessionId) return task.agent || { state: 'NOT_STARTED' };
    const snapshot = await provider.getSession(sessionId);
    const nextState = normalizeAgentState(snapshot.state);
    const synced = store.syncAgent(task.id, {
      state: nextState,
      last_message: snapshot.last_message ?? task.agent?.last_message ?? null,
      progress: snapshot.progress ?? null,
      error: snapshot.error ?? null,
      log_ref: snapshot.log_ref ?? task.agent?.log_ref ?? null,
      output_excerpt: snapshot.output_excerpt ?? task.agent?.output_excerpt ?? null,
    });
    return synced.agent;
  }

  async function cancelTaskAgent(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const sessionId = task.agent?.session_id;
    if (!sessionId) throw new Error('agent not started');
    store.markAgentCancelRequested(task.id, 'Cancel requested by operator');
    let snapshot;
    try {
      snapshot = await provider.cancelSession(sessionId);
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('NOT_SUPPORTED')) {
        return { not_supported: true, task_state: task.status, agent_state: task.agent?.state || null };
      }
      throw err;
    }
    const synced = store.syncAgent(task.id, {
      state: normalizeAgentState(snapshot.state || 'CANCELLED'),
      last_message: snapshot.last_message || 'Session cancelled',
      progress: snapshot.progress ?? null,
      error: snapshot.error ?? null,
      log_ref: snapshot.log_ref ?? task.agent?.log_ref ?? null,
      output_excerpt: snapshot.output_excerpt ?? task.agent?.output_excerpt ?? null,
    });
    return synced.agent;
  }

  return {
    startTaskAgent,
    getTaskAgent,
    cancelTaskAgent,
  };
}
