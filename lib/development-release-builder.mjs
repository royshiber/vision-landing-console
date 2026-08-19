import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

function runGit(repoRoot, args, cwd = repoRoot) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(String(out.stderr || out.stdout || 'git command failed').trim());
  }
  return String(out.stdout || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return hash.digest('hex');
}

export function createDevelopmentReleaseBuilder(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const releaseRoot = path.resolve(repoRoot, 'var', 'development', 'releases');
  fs.mkdirSync(releaseRoot, { recursive: true });

  function buildFromTask(task, worktreeMeta, ctx = {}) {
    if (!task) throw new Error('task required');
    if (task.status !== 'READY_FOR_RELEASE') throw new Error('task is not ready for release');
    if (!worktreeMeta?.exists) throw new Error('worktree missing');
    if (worktreeMeta.clean !== true) throw new Error('worktree is dirty');
    if (!String(worktreeMeta.branch || '').startsWith('development/tasks/')) throw new Error('unsafe release branch');
    if (task.tests?.state !== 'PASSED') throw new Error('latest approved test run is not passed');
    if (task.agent?.state !== 'SUCCEEDED') throw new Error('agent is not succeeded');

    const sourceCommit = runGit(repoRoot, ['-C', path.resolve(repoRoot, worktreeMeta.worktree_id), 'rev-parse', 'HEAD']);
    const stamp = Date.now().toString(36);
    const version = `dev-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${stamp}`;
    const releaseId = `devrel-${task.id}-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const artifactName = `${releaseId}.tar`;
    const artifactAbs = path.resolve(releaseRoot, artifactName);
    runGit(repoRoot, ['archive', '--format=tar', '--output', artifactAbs, sourceCommit], repoRoot);
    const stat = fs.statSync(artifactAbs);
    const artifactSha = sha256File(artifactAbs);

    return {
      state: 'READY',
      release_id: releaseId,
      version,
      artifact_sha256: artifactSha,
      artifact_size: stat.size,
      source_commit: sourceCommit,
      task_id: task.id,
      created_at: nowIso(),
      error: null,
      mock: ctx.mock === true,
    };
  }

  return {
    repoRoot,
    releaseRoot,
    buildFromTask,
  };
}
