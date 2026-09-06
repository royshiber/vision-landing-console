import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  MockCodingAgentProvider,
  UnavailableCodingAgentProvider,
  createCodingAgentProvider,
} from '../lib/coding-agent-provider.mjs';
import { CursorSdkCodingAgentProvider, resetCursorSdkProviderCacheForTests } from '../lib/cursor-sdk-coding-agent-provider.mjs';
import { createMockCursorSdkAdapter } from '../lib/cursor-sdk-adapter.mjs';
import { createCursorAgentSupervisor } from '../lib/cursor-agent-supervisor.mjs';
import { buildCursorTaskPrompt } from '../lib/cursor-task-prompt.mjs';
import { resolveApprovedWorktree } from '../lib/cursor-agent-worktree-guard.mjs';
import { buildCursorAgentLocalOptions, buildCursorAgentOptions, describeCursorAgentToolPolicy } from '../lib/cursor-agent-tool-policy.mjs';
import { createCursorAgentLogStore, AGENT_LOG_MAX_BYTES } from '../lib/cursor-agent-log-store.mjs';
import { mapRunStatusToVlc } from '../lib/cursor-agent-supervisor.mjs';

function runGit(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(String(out.stderr || out.stdout || 'git failed'));
}

function initRepo(root) {
  runGit(['init'], root);
  runGit(['config', 'user.email', 'test@example.com'], root);
  runGit(['config', 'user.name', 'test'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'repo\n', 'utf8');
  runGit(['add', '.'], root);
  runGit(['commit', '-m', 'init'], root);
}

function createWorktree(repoRoot, slug) {
  const branch = `development/tasks/${slug}`;
  const wtRoot = path.join(repoRoot, '.worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  const abs = path.join(wtRoot, slug);
  runGit(['worktree', 'add', '-b', branch, abs, 'HEAD'], repoRoot);
  return { branch, worktree_id: `.worktrees/${slug}`, absWorktree: abs };
}

describe('coding-agent-provider selection', () => {
  afterEach(() => {
    resetCursorSdkProviderCacheForTests();
  });

  it('defaults to unavailable when provider env is unset', () => {
    const p = createCodingAgentProvider({});
    expect(p).toBeInstanceOf(UnavailableCodingAgentProvider);
    expect(p.providerName).toBe('unavailable');
  });

  it('returns unavailable for unknown provider', () => {
    const p = createCodingAgentProvider({ DEVELOPMENT_AGENT_PROVIDER: 'real-cursor' });
    expect(p).toBeInstanceOf(UnavailableCodingAgentProvider);
  });

  it('returns unavailable for cursor-sdk without API key', () => {
    const p = createCodingAgentProvider({ DEVELOPMENT_AGENT_PROVIDER: 'cursor-sdk' });
    expect(p).toBeInstanceOf(UnavailableCodingAgentProvider);
  });

  it('returns CursorSdkCodingAgentProvider when cursor-sdk and API key present', () => {
    const p = createCodingAgentProvider({
      DEVELOPMENT_AGENT_PROVIDER: 'cursor-sdk',
      CURSOR_API_KEY: 'cursor_test_key',
    });
    expect(p).toBeInstanceOf(CursorSdkCodingAgentProvider);
    expect(p.providerName).toBe('cursor-sdk');
  });

  it('mock scenarios still work', async () => {
    const p = createCodingAgentProvider({
      DEVELOPMENT_AGENT_PROVIDER: 'mock',
      DEVELOPMENT_AGENT_MOCK_SCENARIO: 'healthy',
    });
    expect(p).toBeInstanceOf(MockCodingAgentProvider);
    const s = await p.createSession({ id: 'dev-1' }, { branch: 'development/tasks/dev-1', worktree_id: '.worktrees/dev-1' });
    expect(s.session_id).toBeTruthy();
  });
});

describe('cursor task prompt and worktree guard', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-c98-prompt-'));
    initRepo(repoRoot);
  });

  it('builds structured prompt with constraints', () => {
    const prompt = buildCursorTaskPrompt(
      {
        id: 'task-1',
        title: 'Add card',
        description: 'Need card',
        notes: 'none',
        taxonomy: 'FEATURE',
        target_area: 'UI',
        priority: 'HIGH',
      },
      { branch: 'development/tasks/task-1', worktree_id: '.worktrees/task-1', base_commit: 'abc123' },
    );
    expect(prompt).toContain('Task ID: task-1');
    expect(prompt).toContain('Taxonomy: FEATURE');
    expect(prompt).toContain('development/tasks/task-1');
    expect(prompt).toContain('.worktrees/task-1');
    expect(prompt).toContain('Do not modify master');
    expect(prompt).toContain('Do not deploy');
  });

  it('rejects unsafe branch and worktree paths', () => {
    expect(() => resolveApprovedWorktree(repoRoot, {
      branch: 'master',
      worktree_id: '.worktrees/x',
    })).toThrow(/unsafe agent branch/);

    expect(() => resolveApprovedWorktree(repoRoot, {
      branch: 'development/tasks/x',
      worktree_id: '../escape',
    })).toThrow(/unsafe agent worktree/);
  });

  it('resolves approved absolute worktree server-side', () => {
    const wt = createWorktree(repoRoot, 'task-safe');
    const resolved = resolveApprovedWorktree(repoRoot, {
      branch: wt.branch,
      worktree_id: wt.worktree_id,
    });
    expect(resolved.absWorktree).toBe(wt.absWorktree);
    expect(fs.existsSync(resolved.absWorktree)).toBe(true);
  });
});

describe('cursor agent tool policy', () => {
  it('enables sandbox and documents shell requirement explicitly', () => {
    const policy = describeCursorAgentToolPolicy();
    expect(policy.sandboxEnabled).toBe(true);
    expect(policy.shellPolicy).toContain('sandbox-constrained');
    expect(policy.allowedTools).toContain('shell');
    expect(policy.shellRequiredFor.length).toBeGreaterThan(0);

    const local = buildCursorAgentLocalOptions('/tmp/worktree');
    expect(local.sandboxOptions.enabled).toBe(true);
    expect(local.settingSources).toEqual([]);

    // tools must be top-level: AgentOptions.tools is what the SDK reads.
    const options = buildCursorAgentOptions({ cwd: '/tmp/worktree', model: 'composer-2.5', apiKey: 'cursor_test_key' });
    expect(options.local.sandboxOptions.enabled).toBe(true);
    expect(options.tools).toContain('read');
    expect(options.tools).toContain('shell');
  });
});

describe('CursorSdkCodingAgentProvider with mock SDK', () => {
  let repoRoot;
  let provider;
  let supervisor;
  let mockAdapter;

  beforeEach(() => {
    resetCursorSdkProviderCacheForTests();
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-c98-sdk-'));
    initRepo(repoRoot);
    mockAdapter = createMockCursorSdkAdapter();
    supervisor = createCursorAgentSupervisor({
      repoRoot,
      apiKey: 'cursor_test_key',
      adapter: mockAdapter,
      registryPath: path.join(repoRoot, 'var', 'development', 'agent-registry.json'),
    });
    provider = new CursorSdkCodingAgentProvider({
      apiKey: 'cursor_test_key',
      repoRoot,
      supervisor,
    });
  });

  it('creates session bound to worktree and completes successfully', async () => {
    const wt = createWorktree(repoRoot, 'dev-success');
    const started = await provider.createSession(
      { id: 'dev-success', title: 'T', description: 'D', target_area: 'UI', priority: 'NORMAL' },
      { branch: wt.branch, worktree_id: wt.worktree_id },
    );
    expect(started.provider).toBe('cursor-sdk');
    expect(started.session_id).toMatch(/^agent-mock-/);
    expect(started.branch).toBe(wt.branch);
    expect(started.worktree).toBe(wt.worktree_id);
    expect(started.log_ref).toContain('var/development/agent-logs/');

    await new Promise((r) => setTimeout(r, 30));
    const done = await provider.getSession(started.session_id);
    expect(done.state).toBe('SUCCEEDED');
    expect(done.progress).toBe(null);
    expect(String(done.last_message || '')).toBeTruthy();
  });

  it('maps SDK failure to FAILED', async () => {
    const adapter = createMockCursorSdkAdapter({ failRun: true });
    const failSupervisor = createCursorAgentSupervisor({
      repoRoot,
      apiKey: 'cursor_test_key',
      adapter,
      registryPath: path.join(repoRoot, 'var', 'development', 'agent-registry-fail.json'),
    });
    const failProvider = new CursorSdkCodingAgentProvider({
      apiKey: 'cursor_test_key',
      repoRoot,
      supervisor: failSupervisor,
    });
    const wt = createWorktree(repoRoot, 'dev-fail');
    const started = await failProvider.createSession(
      { id: 'dev-fail', title: 'T', description: 'D' },
      { branch: wt.branch, worktree_id: wt.worktree_id },
    );
    await new Promise((r) => setTimeout(r, 30));
    const done = await failProvider.getSession(started.session_id);
    expect(done.state).toBe('FAILED');
  });

  it('supports cancellation when run supports cancel', async () => {
    const wt = createWorktree(repoRoot, 'dev-cancel');
    const started = await provider.createSession(
      { id: 'dev-cancel', title: 'T', description: 'D' },
      { branch: wt.branch, worktree_id: wt.worktree_id },
    );
    const cancelled = await provider.cancelSession(started.session_id);
    expect(cancelled.state).toBe('CANCELLED');
  });

  it('resumes session after supervisor restart from registry', async () => {
    const wt = createWorktree(repoRoot, 'dev-resume');
    const started = await provider.createSession(
      { id: 'dev-resume', title: 'T', description: 'D' },
      { branch: wt.branch, worktree_id: wt.worktree_id },
    );
    await new Promise((r) => setTimeout(r, 30));
    const adapter2 = createMockCursorSdkAdapter();
    for (const [id, run] of mockAdapter.runs) adapter2.runs.set(id, run);
    for (const [id, agent] of mockAdapter.agents) adapter2.agents.set(id, agent);
    const resumedSupervisor = createCursorAgentSupervisor({
      repoRoot,
      apiKey: 'cursor_test_key',
      adapter: adapter2,
      registryPath: path.join(repoRoot, 'var', 'development', 'agent-registry.json'),
    });
    const resumedProvider = new CursorSdkCodingAgentProvider({
      apiKey: 'cursor_test_key',
      repoRoot,
      supervisor: resumedSupervisor,
    });
    const snapshot = await resumedProvider.getSession(started.session_id);
    expect(snapshot.session_id).toBe(started.session_id);
    expect(['SUCCEEDED', 'RUNNING', 'QUEUED']).toContain(snapshot.state);
  });

  it('does not store API keys in session snapshots', async () => {
    const wt = createWorktree(repoRoot, 'dev-secret');
    const started = await provider.createSession(
      { id: 'dev-secret', title: 'T', description: 'D' },
      { branch: wt.branch, worktree_id: wt.worktree_id },
    );
    const raw = JSON.stringify(started);
    expect(raw).not.toContain('cursor_test_key');
    expect(raw).not.toMatch(/CURSOR_API_KEY/i);
  });
});

describe('cursor agent bounded logs', () => {
  it('caps log file size and prunes old logs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-c98-logs-'));
    const store = createCursorAgentLogStore({
      repoRoot: root,
      maxBytes: 128,
      maxFiles: 2,
    });
    store.append('s1', 'a'.repeat(200));
    const excerpt = store.readExcerpt('s1');
    expect(excerpt.length).toBeLessThanOrEqual(128);
    store.append('s2', 'b'.repeat(20));
    store.append('s3', 'c'.repeat(20));
    const files = fs.readdirSync(store.logDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBeLessThanOrEqual(2);
    expect(AGENT_LOG_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe('SDK status mapping', () => {
  it('maps run statuses to VLC agent states', () => {
    expect(mapRunStatusToVlc('finished')).toBe('SUCCEEDED');
    expect(mapRunStatusToVlc('error')).toBe('FAILED');
    expect(mapRunStatusToVlc('cancelled')).toBe('CANCELLED');
    expect(mapRunStatusToVlc('running')).toBe('RUNNING');
  });
});

describe('cursor-sdk live smoke', () => {
  it('runs optional live integration when RUN_CURSOR_SDK_LIVE_TEST=1', async () => {
    if (process.env.RUN_CURSOR_SDK_LIVE_TEST !== '1') return;
    const apiKey = String(process.env.CURSOR_API_KEY || '').trim();
    if (!apiKey) throw new Error('CURSOR_API_KEY required for live smoke test');

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-c98-live-'));
    initRepo(repoRoot);
    const wt = createWorktree(repoRoot, 'live-smoke');
    const { loadDefaultCursorSdkAdapter } = await import('../lib/cursor-sdk-adapter.mjs');
    const adapter = await loadDefaultCursorSdkAdapter();
    const supervisor = createCursorAgentSupervisor({
      repoRoot,
      apiKey,
      adapter,
      model: process.env.CURSOR_AGENT_MODEL || 'composer-2.5',
      registryPath: path.join(repoRoot, 'var', 'development', 'agent-registry.json'),
    });
    const provider = new CursorSdkCodingAgentProvider({ apiKey, repoRoot, supervisor, adapter });
    const started = await provider.createSession(
      {
        id: 'live-smoke',
        title: 'Smoke',
        description: 'List README.md and summarize in one sentence.',
        target_area: 'OTHER',
        priority: 'LOW',
      },
      { branch: wt.branch, worktree_id: wt.worktree_id },
    );
    expect(started.session_id).toMatch(/^agent-/);

    let final = started;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      final = await provider.getSession(started.session_id);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(final.state)) break;
    }
    expect(['SUCCEEDED', 'FAILED', 'CANCELLED']).toContain(final.state);
  }, 300000);
});
