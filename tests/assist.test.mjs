import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildAssistContext } from '../lib/assist/assist-context.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { ASSIST_ACTION_TYPES, ASSIST_PROHIBITED_ACTIONS } from '../lib/assist/assist-types.mjs';
import { isKnownAssistRouteId, findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';
import { registerAssistApi } from '../lib/routes/assist-api.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
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

  it('does not start agent, create release, or deploy from Assist', async () => {
    const resp = await service.processInput({
      text: 'Add a tab that shows landing confidence.',
      context_snapshot: { current_tab: 'control' },
    });
    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    const task = store.getById(confirmed.result.task.id);
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
    expect(resp.answer).toMatch(/WIP|development task/i);
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

  it('message → confirm creates development task without agent start', async () => {
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
  });

  it('meta exposes intents and prohibited actions', async () => {
    const meta = await fetch(`${base}/api/assist/meta`).then((r) => r.json());
    expect(meta.intents).toContain('QUESTION');
    expect(meta.prohibited).toContain('DEPLOY');
    expect(meta.prohibited).toContain('CURSOR_AGENT_START');
    expect(meta.channels).toEqual(['text', 'voice']);
  });
});
