import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAssistContext } from '../lib/assist/assist-context.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { ASSIST_ACTION_TYPES, ASSIST_PROHIBITED_ACTIONS } from '../lib/assist/assist-types.mjs';
import { isKnownAssistRouteId, findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';
import { registerAssistApi } from '../lib/routes/assist-api.mjs';
import { createDevelopmentAgentService } from '../lib/development-agent-service.mjs';
import { MockCodingAgentProvider, UnavailableCodingAgentProvider } from '../lib/coding-agent-provider.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function memoryWorktreeManager() {
  const byId = new Map();
  function paths(taskId) {
    const slug = String(taskId || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'task';
    return { branch: `development/tasks/${slug}`, worktree_id: `.worktrees/${slug}` };
  }
  return {
    create(taskId) {
      const id = String(taskId);
      if (byId.has(id)) throw new Error('worktree already exists');
      const p = paths(id);
      const meta = {
        exists: true,
        ...p,
        clean: true,
        changed_files: 0,
        base_commit: 'abc123',
        created_at: new Date().toISOString(),
      };
      byId.set(id, meta);
      return meta;
    },
    status(taskId) {
      const id = String(taskId);
      const p = paths(id);
      return byId.get(id) || { exists: false, ...p, clean: null, changed_files: 0, base_commit: null };
    },
    remove(taskId) {
      const id = String(taskId);
      const p = paths(id);
      const removed = byId.delete(id);
      return { removed, ...p };
    },
  };
}

function makeAssistWithAgent({ provider } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-'));
  const store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
  const codingAgentProvider = provider || new MockCodingAgentProvider({ scenario: 'healthy' });
  const worktreeManager = memoryWorktreeManager();
  const developmentAgentService = createDevelopmentAgentService({
    store,
    provider: codingAgentProvider,
    worktreeManager,
  });
  const service = createAssistService({
    repoRoot: root,
    developmentTaskStore: store,
    persistence: createAssistPersistence(root),
    codingAgentProvider,
    worktreeManager,
    developmentAgentService,
  });
  return { root, store, service, codingAgentProvider, worktreeManager, developmentAgentService };
}

describe('Assist context', () => {
  it('builds workspace-aware context from current tab without inventing aircraft data', () => {
    const ctx = buildAssistContext({
      current_tab: 'terrain',
      current_subtab: null,
    }, {});
    expect(ctx.current_workspace).toBe('MISSION');
    expect(ctx.current_capability).toBe('mission');
    expect(ctx.aircraft_state).toBe(null);
    expect(ctx.historical_context).toBe(null);
    expect(ctx.policy_state.flight_actions_allowed).toBe(false);
  });

  it('maps Platform → Vision subtab', () => {
    const ctx = buildAssistContext({
      current_tab: 'control',
      current_subtab: 'visionNavParams',
    });
    expect(ctx.current_workspace).toBe('PLATFORM');
    expect(ctx.current_capability).toBe('vision');
  });

  it('passes through aircraft snapshot when provided', () => {
    const ctx = buildAssistContext({
      current_tab: 'telemetry',
      aircraft_state: { connected: true, gps_ok: true, flight_mode: 'FBWA' },
    });
    expect(ctx.aircraft_state.gps_ok).toBe(true);
    expect(ctx.aircraft_state.flight_mode).toBe('FBWA');
  });
});

describe('Assist intent routing', () => {
  it('routes GPS question', () => {
    const r = resolveAssistIntent('What is the GPS status?');
    expect(r.intent).toBe('QUESTION');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('routes observation', () => {
    const r = resolveAssistIntent('I noticed the aircraft is drifting right.');
    expect(r.intent).toBe('OBSERVATION');
  });

  it('routes note', () => {
    const r = resolveAssistIntent('Write a note that the aircraft drifted right.');
    expect(r.intent).toBe('NOTE');
    expect(r.slots.body).toMatch(/drifted right/i);
  });

  it('routes development', () => {
    const r = resolveAssistIntent('Add a tab for landing confidence.');
    expect(r.intent).toBe('DEVELOPMENT');
    expect(r.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
  });

  it('routes UI navigation', () => {
    const r = resolveAssistIntent('Open Vision');
    expect(r.intent).toBe('UI_ACTION');
    expect(r.slots.route_id).toBe('vision');
  });

  it('returns unresolved for nonsense', () => {
    const r = resolveAssistIntent('purple bananas dance tomorrow');
    expect(r.intent).toBe('UNRESOLVED');
  });

  it('rejects prohibited flight / deploy / agent patterns', () => {
    expect(resolveAssistIntent('Please arm the aircraft').prohibited).toBe(true);
    expect(resolveAssistIntent('Deploy the release now').prohibited).toBe(true);
    expect(resolveAssistIntent('Start agent for this task').prohibited).toBe(true);
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
  });
});

describe('Assist service proposals and confirmation', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-'));
    store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
    service = createAssistService({
      repoRoot: root,
      developmentTaskStore: store,
      persistence: createAssistPersistence(root),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers questions without action proposal', async () => {
    const resp = await service.processInput({
      text: 'What is the GPS status?',
      context_snapshot: { current_tab: 'telemetry', aircraft_state: { gps_ok: true, connected: true } },
    });
    expect(resp.intent).toBe('QUESTION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal).toBe(null);
    expect(resp.answer).toMatch(/GPS/i);
  });

  it('proposes development task and requires confirmation; does not create until confirm', async () => {
    const resp = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'development' },
    });
    expect(resp.intent).toBe('DEVELOPMENT');
    expect(resp.requires_confirmation).toBe(true);
    expect(resp.kind).toBe('ACTION_REQUIRING_CONFIRMATION');
    expect(resp.action_proposal.action).toBe('CREATE_DEVELOPMENT_TASK');
    expect(resp.answer).toMatch(/ענף מבודד/);
    expect(resp.answer).toMatch(/לא יתבצע מיזוג/);
    expect(resp.next_step).toMatch(/אישור/);
    expect(store.list({}).length).toBe(0);

    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.result.agent_started).toBe(false);
    expect(confirmed.result.release_created).toBe(false);
    expect(confirmed.result.deploy_started).toBe(false);
    expect(confirmed.result.task.status).toBe('DRAFT');
    expect(confirmed.result.task.agent_state).toBe('NOT_STARTED');
    expect(confirmed.result.navigation.tab).toBe('development');
    expect(store.list({}).length).toBe(1);
  });

  it('starts the coding agent after confirm when the provider is READY', async () => {
    const wired = makeAssistWithAgent();
    try {
      const resp = await wired.service.processInput({
        text: 'Add a tab for landing confidence.',
        context_snapshot: { current_tab: 'development' },
      });
      expect(resp.action_proposal.action).toBe('CREATE_DEVELOPMENT_TASK');
      const confirmed = await wired.service.confirmProposal({
        proposal_id: resp.action_proposal.id,
        confirm: true,
      });
      expect(confirmed.ok).toBe(true);
      expect(confirmed.result.agent_started).toBe(true);
      expect(confirmed.result.agent_runtime).toBe('READY');
      expect(confirmed.result.release_created).toBe(false);
      expect(confirmed.result.deploy_started).toBe(false);
      expect(confirmed.result.merged_to_master).toBe(false);
      expect(confirmed.result.worktree.branch.startsWith('development/tasks/')).toBe(true);
      expect(confirmed.result.task.agent_state).toMatch(/QUEUED|RUNNING/);
      expect(confirmed.answer).toMatch(/מבודד/);
      const task = wired.store.getById(confirmed.result.task.id);
      expect(task.agent.state).not.toBe('NOT_STARTED');
      expect(task.agent.session_id).toBeTruthy();
      expect(task.release.state).toBe('NOT_STARTED');
      expect(task.deployment.state).toBe('NOT_STARTED');
    } finally {
      fs.rmSync(wired.root, { recursive: true, force: true });
    }
  });

  it('creates the task and does not start the agent when the provider is UNAVAILABLE', async () => {
    const wired = makeAssistWithAgent({
      provider: new UnavailableCodingAgentProvider({ reason: 'CURSOR_API_KEY is not configured' }),
    });
    try {
      const resp = await wired.service.processInput({
        text: 'Add a tab for landing confidence.',
      });
      const confirmed = await wired.service.confirmProposal({
        proposal_id: resp.action_proposal.id,
        confirm: true,
      });
      expect(confirmed.ok).toBe(true);
      expect(wired.store.list({}).length).toBe(1);
      expect(confirmed.result.agent_started).toBe(false);
      expect(confirmed.result.agent_runtime).toBe('UNAVAILABLE');
      expect(confirmed.result.agent_unavailable_reason).toMatch(/מפתח החיבור לסוכן לא הוגדר/);
      expect(confirmed.answer).toMatch(/לא הופעל סוכן/);
      const task = wired.store.getById(confirmed.result.task.id);
      expect(task).toBeTruthy();
      expect(task.agent.state).toBe('NOT_STARTED');
    } finally {
      fs.rmSync(wired.root, { recursive: true, force: true });
    }
  });

  it('does not start the agent on cancel', async () => {
    const wired = makeAssistWithAgent();
    try {
      const resp = await wired.service.processInput({
        text: 'Add a tab for landing confidence.',
      });
      const cancelled = await wired.service.confirmProposal({
        proposal_id: resp.action_proposal.id,
        confirm: false,
      });
      expect(cancelled.cancelled).toBe(true);
      expect(wired.store.list({}).length).toBe(0);
      expect(cancelled.answer).toMatch(/בוטלה/);
    } finally {
      fs.rmSync(wired.root, { recursive: true, force: true });
    }
  });

  it('does not create release or deploy from Assist', async () => {
    const resp = await service.processInput({
      text: 'Add a tab that shows landing confidence.',
      context_snapshot: { current_tab: 'control' },
    });
    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    const task = store.getById(confirmed.result.task.id);
    expect(confirmed.result.agent_started).toBe(false);
    expect(task.agent.state).toBe('NOT_STARTED');
    expect(task.release.state).toBe('NOT_STARTED');
    expect(task.deployment.state).toBe('NOT_STARTED');
  });

  it('proposes observation with confirmation then persists', async () => {
    const resp = await service.processInput({
      text: 'I see the aircraft drifting right.',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(resp.intent).toBe('OBSERVATION');
    expect(resp.requires_confirmation).toBe(true);
    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    expect(confirmed.result.observation.text).toMatch(/drifting right/i);
    expect(confirmed.result.observation.workspace).toBe('MISSION');
  });

  it('proposes note with confirmation', async () => {
    const resp = await service.processInput({
      text: 'Write a note that the aircraft drifted right.',
      context_snapshot: { current_tab: 'flightEngineer' },
    });
    expect(resp.intent).toBe('NOTE');
    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    expect(confirmed.result.note.text).toMatch(/drifted right/i);
  });

  it('navigates via known routes only', async () => {
    const resp = await service.processInput({ text: 'Open Vision' });
    expect(resp.intent).toBe('UI_ACTION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal.action).toBe('UI_NAVIGATION');
    expect(resp.action_proposal.payload.tab).toBe('control');
    expect(resp.action_proposal.payload.subtab).toBe('visionNavParams');
    expect(isKnownAssistRouteId(resp.action_proposal.payload.route_id)).toBe(true);
  });

  it('rejects cancel without applying', async () => {
    const resp = await service.processInput({
      text: 'Add a tab for landing confidence.',
    });
    const cancelled = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: false,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(store.list({}).length).toBe(0);
  });

  it('rejects prohibited inputs without proposals', async () => {
    const resp = await service.processInput({ text: 'Please disarm now' });
    expect(resp.intent).toBe('UNRESOLVED');
    expect(resp.action_proposal).toBe(null);
    expect(resp.answer).toMatch(/prohibited/i);
  });

  it('allows only safe action types', () => {
    for (const a of ASSIST_ACTION_TYPES) {
      expect(service._isActionAllowed(a)).toBe(true);
    }
    for (const a of ASSIST_PROHIBITED_ACTIONS) {
      expect(service._isActionAllowed(a)).toBe(false);
    }
  });

  it('workspace-aware question uses Evolve context', async () => {
    store.create({
      title: 'WIP',
      description: 'in progress task',
      target_area: 'UI',
    });
    const resp = await service.processInput({
      text: "What's running right now?",
      context_snapshot: { current_tab: 'development', current_workspace: 'EVOLVE' },
    });
    expect(resp.intent).toBe('QUESTION');
    expect(resp.context_used.workspace).toBe('EVOLVE');
    expect(resp.answer).toMatch(/WIP|משימת פיתוח/);
  });
});

describe('Assist routes security', () => {
  it('never invents arbitrary paths', () => {
    expect(findAssistRoute('../../etc/passwd')).toBe(null);
    expect(findAssistRoute('https://evil.example')).toBe(null);
    expect(findAssistRoute('/api/development/tasks')).toBe(null);
  });
});

describe('Assist HTTP API', () => {
  let server;
  let base;
  let root;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-api-'));
    const app = express();
    app.use(express.json());
    registerAssistApi(app, {
      repoRoot: root,
      developmentTaskStorePath: path.join(root, 'tasks.json'),
    });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('message → confirm creates development task without pretending the agent ran when runtime is missing', async () => {
    const msg = await fetch(`${base}/api/assist/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Add a tab for landing confidence.',
        context: { current_tab: 'development' },
      }),
    }).then((r) => r.json());
    expect(msg.ok).toBe(true);
    expect(msg.response.requires_confirmation).toBe(true);
    expect(msg.response.answer).toMatch(/ענף מבודד/);

    const conf = await fetch(`${base}/api/assist/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_id: msg.response.action_proposal.id,
        confirm: true,
      }),
    }).then((r) => r.json());
    expect(conf.ok).toBe(true);
    expect(conf.result.agent_started).toBe(false);
    expect(conf.result.deploy_started).toBe(false);
    expect(conf.result.task.id).toBeTruthy();
  });

  it('meta exposes intents and prohibited actions', async () => {
    const meta = await fetch(`${base}/api/assist/meta`).then((r) => r.json());
    expect(meta.intents).toContain('QUESTION');
    expect(meta.prohibited).toContain('DEPLOY');
    expect(meta.prohibited).toContain('CURSOR_AGENT_START');
    expect(meta.channels).toEqual(['text', 'voice']);
  });
});

describe('Assist HTTP confirm with injected coding-agent provider', () => {
  let server;
  let base;
  let root;

  async function startWithProvider(provider) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-agent-api-'));
    const app = express();
    app.use(express.json());
    registerAssistApi(app, {
      repoRoot: root,
      developmentTaskStorePath: path.join(root, 'tasks.json'),
      codingAgentProvider: provider,
      worktreeManager: memoryWorktreeManager(),
    });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  }

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    server = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  async function confirmDevelopment() {
    const msg = await fetch(`${base}/api/assist/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Add a tab for landing confidence.',
        context: { current_tab: 'development' },
      }),
    }).then((r) => r.json());
    return fetch(`${base}/api/assist/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_id: msg.response.action_proposal.id,
        confirm: true,
      }),
    }).then((r) => r.json());
  }

  it('starts the agent when the provider is READY and polls until a result', async () => {
    await startWithProvider(new MockCodingAgentProvider({ scenario: 'healthy' }));
    const conf = await confirmDevelopment();
    expect(conf.ok).toBe(true);
    expect(conf.result.agent_started).toBe(true);
    expect(conf.result.agent_runtime).toBe('READY');
    expect(conf.result.worktree.branch.startsWith('development/tasks/')).toBe(true);
    const taskId = conf.result.task.id;
    const started = Date.now();
    let status = null;
    while (Date.now() - started < 5000) {
      status = await fetch(`${base}/api/assist/tasks/${encodeURIComponent(taskId)}`).then((r) => r.json());
      if (status.ok && status.terminal) break;
      await new Promise((r) => setTimeout(r, 75));
    }
    expect(status.ok).toBe(true);
    expect(status.agent_state).toBe('SUCCEEDED');
    expect(status.branch.startsWith('development/tasks/')).toBe(true);
    expect(status.pr_url).toMatch(/^https:\/\//);
    expect(status.answer).toMatch(/סיים/);
  });

  it('creates the task and reports Hebrew unavailable when the provider is UNAVAILABLE', async () => {
    await startWithProvider(new UnavailableCodingAgentProvider({
      reason: 'DEVELOPMENT_AGENT_PROVIDER is not configured',
    }));
    const conf = await confirmDevelopment();
    expect(conf.ok).toBe(true);
    expect(conf.result.agent_started).toBe(false);
    expect(conf.result.agent_runtime).toBe('UNAVAILABLE');
    expect(conf.result.agent_unavailable_reason).toMatch(/ספק הסוכן לא הוגדר/);
    expect(conf.result.task.id).toBeTruthy();
    const listed = await fetch(`${base}/api/assist/tasks/${encodeURIComponent(conf.result.task.id)}`).then((r) => r.json());
    expect(listed.ok).toBe(true);
    expect(listed.agent_state).toBe('NOT_STARTED');
  });
});

function htmlButtonInnerText(html, id) {
  const re = new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</button>`, 'i');
  const m = html.match(re);
  expect(m, `missing <button id="${id}">`).toBeTruthy();
  return m[1].replace(/<[^>]+>/g, '').trim();
}

describe('Assist rail proposal chrome', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('uses Hebrew אישור / ביטול on Confirm/Cancel proposal buttons', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
    const confirmLabel = htmlButtonInnerText(html, 'assistConfirmBtn');
    const cancelLabel = htmlButtonInnerText(html, 'assistCancelBtn');
    expect(confirmLabel).toBe('אישור');
    expect(cancelLabel).toBe('ביטול');
    expect(confirmLabel).not.toBe('Confirm');
    expect(cancelLabel).not.toBe('Cancel');
  });

  it('keeps CURSOR_AGENT_START prohibited as a proposed Assist action', () => {
    expect(ASSIST_PROHIBITED_ACTIONS).toContain('CURSOR_AGENT_START');
  });

  it('does not hardcode English Confirm/Cancel onto those buttons in JS', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    expect(js).not.toMatch(/assistConfirmBtn[\s\S]{0,240}?(?:textContent|innerText|innerHTML)\s*=\s*['"`]Confirm['"`]/);
    expect(js).not.toMatch(/assistCancelBtn[\s\S]{0,240}?(?:textContent|innerText|innerHTML)\s*=\s*['"`]Cancel['"`]/);
  });

  it('treats NOT_STARTED live status as unavailable, not a running agent', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    expect(js).toMatch(/s === 'NOT_STARTED'/);
    expect(js).toMatch(/panel\.dataset\.kind = kind/);
    const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
    expect(html).toMatch(/id="assistRunPanel"[^>]*data-kind="unavailable"/);
    const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.assist-run-panel\[data-kind="run"\]/);
    expect(css).toMatch(/\.assist-run-panel\[data-kind="result"\]/);
    const runBlock = css.split('.assist-run-panel[data-kind="run"]')[0];
    expect(runBlock).toMatch(/rgba\(251, 191, 36/);
    expect(runBlock).not.toMatch(/rgba\(56, 189, 248, 0\.35\)/);
  });
});
