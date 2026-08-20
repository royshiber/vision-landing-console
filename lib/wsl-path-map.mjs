import { resolveApprovedWorktree } from './cursor-agent-worktree-guard.mjs';

const WINDOWS_ABS_RE = /^([A-Za-z]):[\\/](.*)$/;
const SAFE_LINUX_PATH_RE = /^\/[A-Za-z0-9._+@\-/]*$/;
const MAX_PATH_LENGTH = 3000;

export function assertSafeLinuxPath(candidate, label = 'linux path') {
  const value = String(candidate ?? '');
  if (!value.startsWith('/')) throw new Error(`unsafe ${label}`);
  if (value.length > MAX_PATH_LENGTH) throw new Error(`unsafe ${label}`);
  if (!SAFE_LINUX_PATH_RE.test(value)) throw new Error(`unsafe ${label}`);
  if (value.split('/').some((segment) => segment === '..')) throw new Error(`unsafe ${label}`);
  return value;
}

export function windowsPathToWsl(absWindowsPath) {
  const raw = String(absWindowsPath ?? '');
  const match = WINDOWS_ABS_RE.exec(raw);
  if (!match) throw new Error('absolute windows path required');
  const drive = match[1].toLowerCase();
  const segments = match[2].split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('unsafe windows path');
  }
  return assertSafeLinuxPath(`/mnt/${drive}/${segments.join('/')}`, 'windows path mapping');
}

/**
 * Server-side only: resolves and validates the task worktree on Windows, then
 * maps it into the WSL mount namespace. Browser input never reaches this with a
 * path — only the branch/worktree identifiers the server already validated.
 */
export function mapApprovedWorktreeToWsl(repoRoot, worktree) {
  const ctx = resolveApprovedWorktree(repoRoot, worktree);
  return { ...ctx, linuxPath: windowsPathToWsl(ctx.absWorktree) };
}
