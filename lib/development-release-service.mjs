import { evaluateDeployOutcome } from './companion-release-mgmt.mjs';

export function createDevelopmentReleaseService({ store, worktreeManager, releaseBuilder, deployRelease }) {
  if (!store) throw new Error('store required');
  if (!worktreeManager) throw new Error('worktreeManager required');
  if (!releaseBuilder) throw new Error('releaseBuilder required');

  function approveForRelease(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const wt = worktreeManager.status(task.id);
    if (!wt.exists) throw new Error('worktree missing');
    if (task.agent?.state !== 'SUCCEEDED') throw new Error('agent state must be SUCCEEDED');
    if (task.tests?.state !== 'PASSED') throw new Error('latest approved test run is not passed');
    return store.approveForRelease(task.id);
  }

  function createRelease(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const wt = worktreeManager.status(task.id);
    store.startReleaseBuild(task.id);
    try {
      const built = releaseBuilder.buildFromTask(task, wt, { mock: false });
      return store.completeReleaseBuild(task.id, built);
    } catch (err) {
      store.completeReleaseBuild(task.id, { state: 'FAILED', error: String(err?.message || 'release build failed') });
      throw err;
    }
  }

  async function deployReleaseForTask(taskId) {
    const task = store.getById(taskId);
    if (!task) throw new Error('task not found');
    const releaseId = String(task.release?.release_id || '').trim();
    if (!releaseId) throw new Error('task has no release_id');
    if (task.release?.state !== 'READY') throw new Error('release is not READY');
    if (typeof deployRelease !== 'function') throw new Error('deploy unavailable');
    store.recordEvent(task.id, 'deploy_requested', { release_id: releaseId }, { release_id: releaseId });
    const wire = await deployRelease(releaseId);
    const outcome = evaluateDeployOutcome(wire, releaseId);
    if (outcome.ok) {
      return store.recordDeployResult(task.id, {
        state: outcome.state,
        result: 'success',
        running_version: outcome.runningVersion,
      });
    }
    if (outcome.state === 'ROLLED_BACK') {
      return store.recordDeployResult(task.id, {
        state: outcome.state,
        result: 'rolled_back',
        running_version: outcome.runningVersion,
      });
    }
    return store.recordDeployResult(task.id, {
      state: outcome.state,
      result: 'failed',
      running_version: outcome.runningVersion,
    });
  }

  return {
    approveForRelease,
    createRelease,
    deployReleaseForTask,
  };
}
