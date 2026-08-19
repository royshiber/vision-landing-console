import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createDevelopmentWorktreeManager } from '../lib/development-worktree-manager.mjs';

function run(cmd, args, cwd) {
  const out = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(String(out.stderr || out.stdout || 'cmd failed'));
  return String(out.stdout || '').trim();
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-worktree-'));
  run('git', ['init'], root);
  run('git', ['config', 'user.email', 'test@example.com'], root);
  run('git', ['config', 'user.name', 'test'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n', 'utf8');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);
  return root;
}

describe('development-worktree-manager', () => {
  let repoRoot;
  let m;
  beforeEach(() => {
    repoRoot = initRepo();
    m = createDevelopmentWorktreeManager({ repoRoot });
  });

  it('creates and reports worktree status', () => {
    const created = m.create('dev-task-1');
    expect(created.branch).toBe('development/tasks/dev-task-1');
    const status = m.status('dev-task-1');
    expect(status.exists).toBe(true);
    expect(status.clean).toBe(true);
  });

  it('rejects duplicate create', () => {
    m.create('dev-task-2');
    expect(() => m.create('dev-task-2')).toThrow(/already exists/);
  });

  it('detects dirty worktree', () => {
    const created = m.create('dev-task-3');
    const abs = path.join(repoRoot, created.worktree_id);
    fs.writeFileSync(path.join(abs, 'x.txt'), 'dirty\n', 'utf8');
    const s = m.status('dev-task-3');
    expect(s.clean).toBe(false);
    expect(s.changed_files).toBeGreaterThan(0);
  });

  it('removes clean worktree', () => {
    m.create('dev-task-4');
    const removed = m.remove('dev-task-4');
    expect(removed.removed).toBe(true);
    expect(m.status('dev-task-4').exists).toBe(false);
  });

  it('blocks invalid task id', () => {
    expect(() => m.create('///')).toThrow(/invalid task id/);
  });

  it('cannot escape approved root', () => {
    expect(() => m.buildPaths('../../etc/passwd')).not.toThrow();
    const p = m.buildPaths('../../etc/passwd');
    expect(p.worktree_id.startsWith('.worktrees/')).toBe(true);
  });
});
