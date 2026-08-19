import path from 'path';

export function createDevelopmentTestingService({ store, worktreeManager, testingProvider }) {
  if (!store) throw new Error('store required');
  if (!worktreeManager) throw new Error('worktreeManager required');
  if (!testingProvider) throw new Error('testingProvider required');

  function createWorktree(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    try {
      const created = worktreeManager.create(task.id);
      return store.setWorktree(task.id, created);
    } catch (err) {
      store.patch(task.id, { status: 'FAILED' });
      store.recordEvent(task.id, 'worktree_create_failed', null, { error: String(err?.message || 'worktree create failed') });
      throw err;
    }
  }

  function getWorktreeStatus(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const meta = worktreeManager.status(task.id);
    if (meta.exists) {
      store.setWorktreeStatus(task.id, meta);
    }
    return meta;
  }

  function removeWorktree(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const removed = worktreeManager.remove(task.id);
    if (removed.removed) store.clearWorktree(task.id);
    return removed;
  }

  async function runTests(taskId, profile) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const meta = worktreeManager.status(task.id);
    if (!meta.exists) throw new Error('worktree required');
    if ((task.agent?.state || 'NOT_STARTED') !== 'SUCCEEDED') {
      throw new Error('agent must succeed before running tests');
    }
    const absWorktree = path.resolve(worktreeManager.repoRoot, meta.worktree_id);
    const run = await testingProvider.runApprovedSuite(task.id, {
      profile,
      worktreeAbsPath: absWorktree,
    });
    store.startTests(task.id, run);
    return run;
  }

  async function getTests(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const runId = task.tests?.run_id;
    if (!runId) return task.tests || { state: 'NOT_STARTED' };
    const run = await testingProvider.getRun(runId);
    if (run.state === 'PASSED' || run.state === 'FAILED' || run.state === 'CANCELLED') {
      store.completeTests(task.id, run);
      return store.getById(task.id).tests;
    }
    return task.tests;
  }

  async function cancelTests(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const runId = task.tests?.run_id;
    if (!runId) throw new Error('test run not started');
    store.markTestCancelRequested(task.id);
    const run = await testingProvider.cancelRun(runId);
    store.completeTests(task.id, run);
    return store.getById(task.id).tests;
  }

  return {
    createWorktree,
    getWorktreeStatus,
    removeWorktree,
    runTests,
    getTests,
    cancelTests,
  };
}
