import fs from 'fs';
import path from 'path';

const FORBIDDEN_BRANCHES = new Set(['master', 'main']);

export function resolveApprovedWorktree(repoRoot, worktree) {
  const root = path.resolve(String(repoRoot || process.cwd()));
  const branch = String(worktree?.branch || '').trim();
  const worktreeId = String(worktree?.worktree_id || '').trim();

  if (!branch.startsWith('development/tasks/')) {
    throw new Error('unsafe agent branch');
  }
  const branchTail = branch.slice('development/tasks/'.length);
  if (!branchTail || FORBIDDEN_BRANCHES.has(branchTail) || FORBIDDEN_BRANCHES.has(branch)) {
    throw new Error('unsafe agent branch');
  }
  if (!worktreeId.startsWith('.worktrees/')) {
    throw new Error('unsafe agent worktree');
  }
  const rel = worktreeId.slice('.worktrees/'.length);
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('/')) {
    throw new Error('unsafe agent worktree');
  }

  const absWorktree = path.resolve(root, worktreeId);
  const relToRoot = path.relative(root, absWorktree);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error('worktree path escape blocked');
  }
  if (!fs.existsSync(absWorktree)) {
    throw new Error('worktree required before starting agent');
  }

  return {
    branch,
    worktree_id: worktreeId,
    absWorktree,
    base_commit: worktree?.base_commit ?? null,
  };
}
