import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function slugifyTaskId(taskId) {
  const slug = String(taskId || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) throw new Error('invalid task id');
  return slug;
}

function safeRunGit(repoRoot, args, cwd = repoRoot) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) {
    const stderr = String(out.stderr || '').trim();
    const stdout = String(out.stdout || '').trim();
    throw new Error(stderr || stdout || `git command failed: ${args.join(' ')}`);
  }
  return String(out.stdout || '').trim();
}

function ensureInside(base, candidate) {
  const rel = path.relative(base, candidate);
  if (!rel || rel === '.') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function createDevelopmentWorktreeManager(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const worktreeRoot = path.resolve(repoRoot, '.worktrees');

  function buildPaths(taskId) {
    const slug = slugifyTaskId(taskId);
    const branch = `development/tasks/${slug}`;
    if (branch === 'master' || branch === 'main') throw new Error('unsafe branch target');
    const absWorktree = path.resolve(worktreeRoot, slug);
    if (!ensureInside(worktreeRoot, absWorktree)) throw new Error('worktree path escape blocked');
    return {
      slug,
      branch,
      absWorktree,
      worktree_id: `.worktrees/${slug}`,
    };
  }

  function status(taskId) {
    const p = buildPaths(taskId);
    const exists = fs.existsSync(p.absWorktree);
    if (!exists) {
      return {
        exists: false,
        branch: p.branch,
        worktree_id: p.worktree_id,
        clean: null,
        changed_files: 0,
        base_commit: null,
      };
    }
    const base_commit = safeRunGit(repoRoot, ['rev-parse', p.branch]);
    const porcelain = safeRunGit(repoRoot, ['-C', p.absWorktree, 'status', '--porcelain']);
    const lines = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
    return {
      exists: true,
      branch: p.branch,
      worktree_id: p.worktree_id,
      clean: lines.length === 0,
      changed_files: lines.length,
      base_commit,
    };
  }

  function create(taskId) {
    const p = buildPaths(taskId);
    fs.mkdirSync(worktreeRoot, { recursive: true });
    if (fs.existsSync(p.absWorktree)) {
      throw new Error('worktree already exists');
    }
    const base_commit = safeRunGit(repoRoot, ['rev-parse', 'HEAD']);
    safeRunGit(repoRoot, ['worktree', 'add', '-b', p.branch, p.absWorktree, base_commit]);
    const snapshot = status(taskId);
    return {
      ...snapshot,
      created_at: new Date().toISOString(),
      base_commit,
    };
  }

  function remove(taskId) {
    const p = buildPaths(taskId);
    if (!fs.existsSync(p.absWorktree)) {
      return { removed: false, branch: p.branch, worktree_id: p.worktree_id };
    }
    const s = status(taskId);
    if (!s.clean) throw new Error('cannot remove dirty worktree');
    safeRunGit(repoRoot, ['worktree', 'remove', p.absWorktree]);
    try {
      safeRunGit(repoRoot, ['branch', '-D', p.branch]);
    } catch {
      // branch may already be absent
    }
    return { removed: true, branch: p.branch, worktree_id: p.worktree_id };
  }

  return {
    repoRoot,
    worktreeRoot,
    create,
    status,
    remove,
    buildPaths,
  };
}
