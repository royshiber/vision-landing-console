import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { registerDevelopmentTasksApi } from '../lib/routes/development-tasks-api.mjs';
import { createDevelopmentWorktreeManager } from '../lib/development-worktree-manager.mjs';
import { MockTestingProvider } from '../lib/testing-provider.mjs';
import { MockCodingAgentProvider } from '../lib/coding-agent-provider.mjs';
import { createDevelopmentReleaseBuilder } from '../lib/development-release-builder.mjs';

function devApiCtx(overrides = {}) {
  return {
    codingAgentProvider: new MockCodingAgentProvider({ scenario: 'healthy' }),
    testingProvider: new MockTestingProvider({ scenario: 'healthy' }),
    ...overrides,
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Poll until predicate; avoids fixed sleeps that flake under full-suite load. */
async function waitForJson(url, predicate, { timeoutMs = 8000, intervalMs = 75 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fetch(url).then((r) => r.json());
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForJson timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

describe('development tasks API', () => {
  let server;
  let base;
  let storePath;
  let repoRoot;
  let tempRoot;

  function run(cmd, args, cwd) {
    const out = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(String(out.stderr || out.stdout || 'cmd failed'));
  }

  function initRepo(root) {
    run('git', ['init'], root);
    run('git', ['config', 'user.email', 'test@example.com'], root);
    run('git', ['config', 'user.name', 'test'], root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2), 'utf8');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'repo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} }, null, 2), 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), 'repo\n', 'utf8');
    run('git', ['add', '.'], root);
    run('git', ['commit', '-m', 'init'], root);
  }

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-devapi-'));
    repoRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    initRepo(repoRoot);
    storePath = path.join(tempRoot, 'tasks.json');
    const app = express();
    app.use(express.json());
    registerDevelopmentTasksApi(app, devApiCtx({
      developmentTaskStorePath: storePath,
      worktreeManager: createDevelopmentWorktreeManager({ repoRoot }),
      releaseBuilder: createDevelopmentReleaseBuilder({ repoRoot }),
    }));
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (tempRoot) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        /* Windows may briefly hold git worktree handles */
      }
      tempRoot = null;
    }
  });

  it('creates and gets a task', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Add metrics card',
        description: 'Need metrics card for local diagnostics',
        target_area: 'UI',
        priority: 'HIGH',
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const got = await fetch(`${base}/api/development/tasks/${created.task.id}`).then((r) => r.json());
    expect(got.ok).toBe(true);
    expect(got.task.title).toBe('Add metrics card');
  });

  it('lists with status and target filters and sorting', async () => {
    const a = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A', description: 'A', target_area: 'UI', priority: 'NORMAL' }),
    }).then((r) => r.json());
    const b = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'B', description: 'B', target_area: 'API', priority: 'LOW' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${b.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'QUEUED' }),
    });
    const byStatus = await fetch(`${base}/api/development/tasks?status=QUEUED`).then((r) => r.json());
    expect(byStatus.tasks).toHaveLength(1);
    expect(byStatus.tasks[0].id).toBe(b.task.id);
    const byTarget = await fetch(`${base}/api/development/tasks?target=UI`).then((r) => r.json());
    expect(byTarget.tasks).toHaveLength(1);
    expect(byTarget.tasks[0].id).toBe(a.task.id);
    const asc = await fetch(`${base}/api/development/tasks?sort=updated_asc`).then((r) => r.json());
    expect(asc.tasks[0].id).toBe(a.task.id);
  });

  it('rejects invalid transition', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'State', description: 'state', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    const bad = await fetch(`${base}/api/development/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'DEPLOYED' }),
    });
    expect(bad.status).toBe(409);
  });

  it('rejects malformed task creation', async () => {
    const r = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', description: '', target_area: 'UNKNOWN', priority: 'NOW' }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects duplicate task id', async () => {
    const body = {
      id: 'dev-dup-1',
      title: 'One',
      description: 'First',
      target_area: 'OTHER',
      priority: 'LOW',
    };
    const first = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
  });

  it('records audit history on changes', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Audit', description: 'Audit', target_area: 'COMPANION', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'CRITICAL', target_area: 'API', status: 'QUEUED' }),
    });
    const detail = await fetch(`${base}/api/development/tasks/${created.task.id}`).then((r) => r.json());
    expect(Array.isArray(detail.task.audit)).toBe(true);
    expect(detail.task.audit.length).toBeGreaterThan(1);
  });

  it('handles two concurrent task updates without state corruption', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Concurrent', description: 'Concurrent', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    const taskId = created.task.id;
    const a = fetch(`${base}/api/development/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'HIGH' }),
    });
    const b = fetch(`${base}/api/development/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'parallel-note' }),
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const finalTask = await fetch(`${base}/api/development/tasks/${taskId}`).then((r) => r.json());
    expect(finalTask.task.priority).toBe('HIGH');
    expect(finalTask.task.notes).toBe('parallel-note');
  });

  it('rejects unknown patch fields', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patch', description: 'Patch', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    const r = await fetch(`${base}/api/development/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shell: 'rm -rf /' }),
    });
    expect(r.status).toBe(400);
  });

  it('handles malformed task store data', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{"tasks":"oops"}', 'utf8');
    const r = await fetch(`${base}/api/development/tasks`);
    expect(r.status).toBe(500);
  });

  it('starts agent with confirmation and exposes isolated branch/worktree metadata', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Agent', description: 'Agent start', target_area: 'API', priority: 'HIGH' }),
    }).then((r) => r.json());
    const denied = await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    expect(denied.status).toBe(400);
    const missingWorktree = await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(missingWorktree.status).toBe(409);
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const started = await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, shell: 'rm -rf /', path: '/etc/passwd' }),
    }).then((r) => r.json());
    expect(started.ok).toBe(true);
    expect(started.agent.session_id).toBeTruthy();
    expect(started.agent.branch).toContain('development/tasks/');
    expect(started.agent.worktree).toContain('.worktrees/');
    expect(started.agent.worktree).not.toContain('/etc');
    expect(started.task.status).toBe('IN_PROGRESS');
  });

  it('syncs agent lifecycle to testing on success', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Agent2', description: 'Agent success', target_area: 'UI', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    // Mock reaches SUCCEEDED at ~800ms; poll instead of fixed sleep so git/worktree
    // variance under full-suite load cannot burn the whole Vitest default 5s budget.
    const poll = await waitForJson(
      `${base}/api/development/tasks/${created.task.id}/agent`,
      (j) => j?.ok === true && j?.task?.agent?.state === 'SUCCEEDED',
      { timeoutMs: 10000, intervalMs: 75 },
    );
    expect(poll.ok).toBe(true);
    expect(poll.task.agent.state).toBe('SUCCEEDED');
    expect(poll.task.status).toBe('IN_PROGRESS');
  }, 20000);

  it('agent poll reaches SUCCEEDED without fixed wall-clock sleep (regression)', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'AgentPoll', description: 'Poll regression', target_area: 'UI', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const startedAt = Date.now();
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const early = await fetch(`${base}/api/development/tasks/${created.task.id}/agent`).then((r) => r.json());
    expect(['QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED']).toContain(early.task.agent.state);
    const done = await waitForJson(
      `${base}/api/development/tasks/${created.task.id}/agent`,
      (j) => j?.task?.agent?.state === 'SUCCEEDED',
      { timeoutMs: 10000, intervalMs: 50 },
    );
    expect(done.task.agent.state).toBe('SUCCEEDED');
    expect(Date.now() - startedAt).toBeLessThan(15000);
    // No leftover lock dir after sync
    expect(fs.existsSync(`${storePath}.lock`)).toBe(false);
  }, 20000);

  it('cancels agent with confirmation and keeps audit trail', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cancel', description: 'Cancel agent', target_area: 'UI', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const denied = await fetch(`${base}/api/development/tasks/${created.task.id}/agent/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    expect(denied.status).toBe(400);
    const cancelled = await fetch(`${base}/api/development/tasks/${created.task.id}/agent/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then((r) => r.json());
    expect(cancelled.ok).toBe(true);
    expect(cancelled.task.agent.state).toBe('CANCELLED');
    expect(cancelled.task.status).toBe('CANCELLED');
    const actions = cancelled.task.audit.map((a) => a.action);
    expect(actions).toContain('agent_cancel_requested');
    expect(actions).toContain('agent_cancelled');
  });

  it('returns unavailable when provider is disconnected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-devapi-disc-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const disconnectedPath = path.join(root, 'tasks.json');
    const app = express();
    app.use(express.json());
    registerDevelopmentTasksApi(app, devApiCtx({
      developmentTaskStorePath: disconnectedPath,
      worktreeManager: createDevelopmentWorktreeManager({ repoRoot: repo }),
      codingAgentProvider: new MockCodingAgentProvider({ scenario: 'disconnected' }),
    }));
    const disconnectedServer = await listen(app);
    const addr = disconnectedServer.address();
    const disconnectedBase = `http://127.0.0.1:${addr.port}`;
    try {
      const created = await fetch(`${disconnectedBase}/api/development/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Disc', description: 'Disc', target_area: 'API', priority: 'NORMAL' }),
      }).then((r) => r.json());
      await fetch(`${disconnectedBase}/api/development/tasks/${created.task.id}/worktree/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const start = await fetch(`${disconnectedBase}/api/development/tasks/${created.task.id}/agent/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(start.status).toBe(503);
    } finally {
      await new Promise((resolve) => disconnectedServer.close(resolve));
    }
  });

  it('creates worktree and reports worktree status', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'WT', description: 'WT', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    const denied = await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    expect(denied.status).toBe(400);
    const ok = await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then((r) => r.json());
    expect(ok.ok).toBe(true);
    expect(ok.worktree.branch).toContain('development/tasks/');
    const status = await fetch(`${base}/api/development/tasks/${created.task.id}/worktree`).then((r) => r.json());
    expect(status.worktree.exists).toBe(true);
    expect(status.worktree.clean).toBe(true);
  });

  it('runs tests only with approved profile and updates task lifecycle', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test run', description: 'Test run', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const beforeAgent = await fetch(`${base}/api/development/tasks/${created.task.id}/tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT' }),
    });
    expect(beforeAgent.status).toBe(409);
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await new Promise((r) => setTimeout(r, 1100));
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent`);
    const badProfile = await fetch(`${base}/api/development/tasks/${created.task.id}/tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'HACK' }),
    });
    expect(badProfile.status).toBe(400);
    await fetch(`${base}/api/development/tasks/${created.task.id}/tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT', shell: 'npm run evil' }),
    });
    await new Promise((r) => setTimeout(r, 1200));
    const state = await fetch(`${base}/api/development/tasks/${created.task.id}/tests`).then((r) => r.json());
    expect(['RUNNING', 'PASSED']).toContain(state.task.tests.state);
  });

  it('allows metadata update during active test execution', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Update during tests', description: 'Update during tests', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await new Promise((r) => setTimeout(r, 1100));
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent`);
    await fetch(`${base}/api/development/tasks/${created.task.id}/tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT' }),
    });
    const update = await fetch(`${base}/api/development/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'edited while testing' }),
    });
    expect(update.status).toBe(200);
    const detail = await fetch(`${base}/api/development/tasks/${created.task.id}`).then((r) => r.json());
    expect(detail.task.notes).toBe('edited while testing');
    expect(['TESTING', 'WAITING_FOR_REVIEW', 'FAILED']).toContain(detail.task.status);
  });

  it('allows update while agent polling endpoint is active', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Update during polling', description: 'Update during polling', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const polling = fetch(`${base}/api/development/tasks/${created.task.id}/agent`);
    const update = fetch(`${base}/api/development/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'CRITICAL' }),
    });
    const [pollRes, updRes] = await Promise.all([polling, update]);
    expect(pollRes.status).toBe(200);
    expect(updRes.status).toBe(200);
    const detail = await fetch(`${base}/api/development/tasks/${created.task.id}`).then((r) => r.json());
    expect(detail.task.priority).toBe('CRITICAL');
  });

  it('cancels active tests with confirmation', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cancel tests', description: 'Cancel tests', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await new Promise((r) => setTimeout(r, 1100));
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent`);
    await fetch(`${base}/api/development/tasks/${created.task.id}/tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT' }),
    });
    const denied = await fetch(`${base}/api/development/tasks/${created.task.id}/tests/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    expect(denied.status).toBe(400);
    const cancelled = await fetch(`${base}/api/development/tasks/${created.task.id}/tests/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then((r) => r.json());
    expect(cancelled.ok).toBe(true);
    expect(cancelled.task.tests.state).toBe('CANCELLED');
  });

  it('returns 503 when testing provider unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-devapi-testdisc-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const isolatedStore = path.join(root, 'tasks.json');
    const app = express();
    app.use(express.json());
    registerDevelopmentTasksApi(app, devApiCtx({
      developmentTaskStorePath: isolatedStore,
      worktreeManager: createDevelopmentWorktreeManager({ repoRoot: repo }),
      testingProvider: new MockTestingProvider({ scenario: 'disconnected' }),
    }));
    const srv = await listen(app);
    const addr = srv.address();
    const localBase = `http://127.0.0.1:${addr.port}`;
    try {
      const created = await fetch(`${localBase}/api/development/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Disc tests', description: 'Disc tests', target_area: 'API', priority: 'NORMAL' }),
      }).then((r) => r.json());
      await fetch(`${localBase}/api/development/tasks/${created.task.id}/worktree/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      await fetch(`${localBase}/api/development/tasks/${created.task.id}/agent/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      await new Promise((r) => setTimeout(r, 1100));
      await fetch(`${localBase}/api/development/tasks/${created.task.id}/agent`);
      const response = await fetch(`${localBase}/api/development/tasks/${created.task.id}/tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT' }),
      });
      expect(response.status).toBe(503);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('returns NOT_SUPPORTED when provider cannot cancel', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-devapi-cancelns-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    initRepo(repo);
    const localStore = path.join(root, 'tasks.json');
    const provider = {
      providerName: 'custom',
      async createSession(_task, worktree) {
        return {
          provider: 'custom',
          session_id: 's-1',
          state: 'RUNNING',
          branch: worktree.branch,
          worktree: worktree.worktree_id,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_message: 'running',
          progress: null,
          error: null,
        };
      },
      async getSession() {
        return { state: 'RUNNING', updated_at: new Date().toISOString(), last_message: 'running', progress: null, error: null };
      },
      async cancelSession() {
        throw new Error('NOT_SUPPORTED');
      },
      async sendInstruction() {
        return {};
      },
    };
    const app = express();
    app.use(express.json());
    registerDevelopmentTasksApi(app, {
      developmentTaskStorePath: localStore,
      worktreeManager: createDevelopmentWorktreeManager({ repoRoot: repo }),
      codingAgentProvider: provider,
      testingProvider: new MockTestingProvider({ scenario: 'healthy' }),
    });
    const srv = await listen(app);
    const addr = srv.address();
    const localBase = `http://127.0.0.1:${addr.port}`;
    try {
      const created = await fetch(`${localBase}/api/development/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Cancel NS', description: 'Cancel NS', target_area: 'API', priority: 'NORMAL' }),
      }).then((r) => r.json());
      await fetch(`${localBase}/api/development/tasks/${created.task.id}/worktree/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      await fetch(`${localBase}/api/development/tasks/${created.task.id}/agent/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const cancel = await fetch(`${localBase}/api/development/tasks/${created.task.id}/agent/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }).then((r) => r.json());
      expect(cancel.ok).toBe(false);
      expect(cancel.code).toBe('NOT_SUPPORTED');
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('requires explicit approval gate before release readiness', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Approve gate', description: 'Approve gate', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    const denied = await fetch(`${base}/api/development/tasks/${created.task.id}/release/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    expect(denied.status).toBe(400);
    const missingPreconditions = await fetch(`${base}/api/development/tasks/${created.task.id}/release/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(missingPreconditions.status).toBe(409);
  });

  it('approves, builds release metadata, and captures tested commit', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Release build', description: 'Release build', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    await new Promise((r) => setTimeout(r, 1100));
    await fetch(`${base}/api/development/tasks/${created.task.id}/agent`);
    await fetch(`${base}/api/development/tasks/${created.task.id}/tests/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT' }),
    });
    await new Promise((r) => setTimeout(r, 1200));
    await fetch(`${base}/api/development/tasks/${created.task.id}/tests`);
    const approved = await fetch(`${base}/api/development/tasks/${created.task.id}/release/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then((r) => r.json());
    expect(approved.ok).toBe(true);
    expect(approved.task.status).toBe('READY_FOR_RELEASE');
    const built = await fetch(`${base}/api/development/tasks/${created.task.id}/release/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, shell: 'rm -rf /', path: '/tmp/x' }),
    }).then((r) => r.json());
    expect(built.ok).toBe(true);
    expect(built.task.release.state).toBe('READY');
    expect(built.task.release.release_id).toContain('devrel-');
    expect(built.task.release.artifact_sha256).toBeTruthy();
    expect(built.task.release.source_commit).toBeTruthy();
  });

  it('rejects release build from dirty worktree', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Dirty release', description: 'Dirty release', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const wt = createDevelopmentWorktreeManager({ repoRoot });
    const ws = wt.status(created.task.id);
    fs.writeFileSync(path.join(repoRoot, ws.worktree_id, 'dirty.txt'), 'x\n', 'utf8');
    const build = await fetch(`${base}/api/development/tasks/${created.task.id}/release/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(build.status).toBe(409);
  });

  it('task creation with injection strings does not execute them', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '$(rm -rf /)',
        description: '`id` && echo PWNED; DROP TABLE tasks; --',
        target_area: 'API',
        priority: 'NORMAL',
        notes: '<script>alert(1)</script>\n; shutdown -h now',
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    expect(created.task.title).toBe('$(rm -rf /)');
    expect(created.task.description).toContain('DROP TABLE');
    expect(created.task.notes).toContain('<script>');
    expect(created.task.id.startsWith('dev-')).toBe(true);
    expect(created.task.branch).toBe(null);
    expect(created.task.worktree).toBe(null);
  });

  it('worktree creation with malicious task id sanitizes paths', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'dev-../../etc/passwd',
        title: 'Escape attempt',
        description: 'Escape attempt',
        target_area: 'API',
        priority: 'NORMAL',
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const wt = await fetch(`${base}/api/development/tasks/${encodeURIComponent(created.task.id)}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).then((r) => r.json());
    expect(wt.ok).toBe(true);
    expect(wt.worktree.branch).toMatch(/^development\/tasks\//);
    expect(wt.worktree.branch).not.toContain('..');
    expect(wt.worktree.branch).not.toContain('/etc/');
  });

  it('rejects arbitrary fields in agent start without leaking to shell', async () => {
    const created = await fetch(`${base}/api/development/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'SecAgent', description: 'SecAgent', target_area: 'API', priority: 'NORMAL' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/development/tasks/${created.task.id}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const started = await fetch(`${base}/api/development/tasks/${created.task.id}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, exec: 'rm -rf /', cmd: 'calc', argv: ['--evil'] }),
    }).then((r) => r.json());
    expect(started.ok).toBe(true);
    expect(started.agent.branch).toMatch(/^development\/tasks\//);
    expect(started.agent.worktree).toMatch(/^\.worktrees\//);
  });

  it('empty store file does not crash list', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '', 'utf8');
    const r = await fetch(`${base}/api/development/tasks`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.tasks).toEqual([]);
  });

  it('maps deploy success/failed/rolled_back to task deployment state', async () => {
    const mkApp = async (deployState) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `vlc-devapi-deploy-${deployState}-`));
      const repo = path.join(root, 'repo');
      fs.mkdirSync(repo, { recursive: true });
      initRepo(repo);
      const localStore = path.join(root, 'tasks.json');
      const app = express();
      app.use(express.json());
      registerDevelopmentTasksApi(app, devApiCtx({
        developmentTaskStorePath: localStore,
        worktreeManager: createDevelopmentWorktreeManager({ repoRoot: repo }),
        releaseBuilder: createDevelopmentReleaseBuilder({ repoRoot: repo }),
        deployRelease: async (releaseId) => ({
          state: deployState,
          release_id: releaseId,
          running_process_changed: deployState === 'SUCCEEDED',
          health_check_ok: deployState === 'SUCCEEDED',
          running_version: deployState === 'SUCCEEDED' ? '1.0.0' : '0.9.0',
          active_release: { version: deployState === 'SUCCEEDED' ? '1.0.0' : '0.9.0' },
        }),
      }));
      const srv = await listen(app);
      const addr = srv.address();
      return { srv, baseUrl: `http://127.0.0.1:${addr.port}` };
    };

    const runFlow = async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/development/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Deploy map', description: 'Deploy map', target_area: 'API', priority: 'NORMAL' }),
      }).then((r) => r.json());
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/worktree/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/agent/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      await new Promise((r) => setTimeout(r, 1100));
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/agent`);
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/tests/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, profile: 'DEVELOPMENT' }) });
      await new Promise((r) => setTimeout(r, 1100));
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/tests`);
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/release/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      await fetch(`${baseUrl}/api/development/tasks/${created.task.id}/release/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      return created.task.id;
    };

    const success = await mkApp('SUCCEEDED');
    try {
      const id = await runFlow(success.baseUrl);
      const dep = await fetch(`${success.baseUrl}/api/development/tasks/${id}/release/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).then((r) => r.json());
      expect(dep.task.status).toBe('DEPLOYED');
      expect(dep.task.deployment.result).toBe('success');
    } finally {
      await new Promise((resolve) => success.srv.close(resolve));
    }

    const failed = await mkApp('FAILED');
    try {
      const id = await runFlow(failed.baseUrl);
      const dep = await fetch(`${failed.baseUrl}/api/development/tasks/${id}/release/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).then((r) => r.json());
      expect(dep.task.status).not.toBe('DEPLOYED');
      expect(dep.task.deployment.result).toBe('failed');
    } finally {
      await new Promise((resolve) => failed.srv.close(resolve));
    }

    const rolled = await mkApp('ROLLED_BACK');
    try {
      const id = await runFlow(rolled.baseUrl);
      const dep = await fetch(`${rolled.baseUrl}/api/development/tasks/${id}/release/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).then((r) => r.json());
      expect(dep.task.status).not.toBe('DEPLOYED');
      expect(dep.task.deployment.result).toBe('rolled_back');
    } finally {
      await new Promise((resolve) => rolled.srv.close(resolve));
    }
  }, 20000);
});
