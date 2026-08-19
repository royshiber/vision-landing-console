import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { MockTestingProvider, LocalTestingProvider, createTestingProvider } from '../lib/testing-provider.mjs';
import { createDevelopmentWorktreeManager } from '../lib/development-worktree-manager.mjs';

function run(cmd, args, cwd) {
  const out = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(String(out.stderr || out.stdout || 'cmd failed'));
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-testprov-'));
  run('git', ['init'], root);
  run('git', ['config', 'user.email', 'test@example.com'], root);
  run('git', ['config', 'user.name', 'test'], root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 't', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} }, null, 2), 'utf8');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);
  return root;
}

describe('testing-provider', () => {
  let repoRoot;
  let wt;
  beforeEach(() => {
    repoRoot = initRepo();
    wt = createDevelopmentWorktreeManager({ repoRoot }).create('dev-tp-1');
  });

  it('validates profile', async () => {
    const p = new MockTestingProvider({ scenario: 'healthy' });
    await expect(p.runApprovedSuite('dev', { profile: 'HACK' })).rejects.toThrow(/invalid testing profile/);
  });

  it('mock healthy passes', async () => {
    const p = new MockTestingProvider({ scenario: 'healthy' });
    const runInfo = await p.runApprovedSuite('dev', { profile: 'DEVELOPMENT' });
    await new Promise((r) => setTimeout(r, 1100));
    const run = await p.getRun(runInfo.run_id);
    expect(run.state).toBe('PASSED');
  });

  it('mock degraded fails', async () => {
    const p = new MockTestingProvider({ scenario: 'degraded' });
    const runInfo = await p.runApprovedSuite('dev', { profile: 'DEVELOPMENT' });
    await new Promise((r) => setTimeout(r, 1100));
    const run = await p.getRun(runInfo.run_id);
    expect(run.state).toBe('FAILED');
  });

  it('mock disconnected unavailable', async () => {
    const p = createTestingProvider({ DEVELOPMENT_TESTING_PROVIDER: 'disconnected' });
    await expect(p.runApprovedSuite('dev', { profile: 'DEVELOPMENT' })).rejects.toThrow(/unavailable/i);
  });

  it('local provider writes bounded log reference', async () => {
    const p = new LocalTestingProvider({ repoRoot });
    const abs = path.join(repoRoot, wt.worktree_id);
    const runInfo = await p.runApprovedSuite('dev', { profile: 'CONSOLE_FULL', worktreeAbsPath: abs });
    await new Promise((r) => setTimeout(r, 1000));
    const run = await p.getRun(runInfo.run_id);
    expect(['RUNNING', 'PASSED', 'FAILED']).toContain(run.state);
    if (run.log_ref) {
      const logPath = path.join(repoRoot, run.log_ref);
      if (fs.existsSync(logPath)) expect(fs.readFileSync(logPath, 'utf8').length).toBeLessThanOrEqual(16000);
    }
  });

  it('supports cancellation', async () => {
    const p = new MockTestingProvider({ scenario: 'healthy' });
    const run = await p.runApprovedSuite('dev', { profile: 'DEVELOPMENT' });
    const c = await p.cancelRun(run.run_id);
    expect(c.state).toBe('CANCELLED');
  });
});
