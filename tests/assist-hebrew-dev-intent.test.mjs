import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';

function expectDevelopmentProposal(resolved) {
  expect(resolved.intent).toBe('DEVELOPMENT');
  expect(resolved.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
}

function expectRequestProposal(resolved) {
  expect(resolved.intent).toBe('REQUEST');
  expect(resolved.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
}

describe('Assist Hebrew development / request intent', () => {
  it('proposes DEVELOPMENT for הוסף טאב לביטחון נחיתה like the English equivalent', () => {
    const en = resolveAssistIntent('Add a tab for landing confidence.');
    expectDevelopmentProposal(en);
    const he = resolveAssistIntent('הוסף טאב לביטחון נחיתה');
    expectDevelopmentProposal(he);
  });

  it('proposes DEVELOPMENT for natural Hebrew add/change/fix phrasing', () => {
    expectDevelopmentProposal(resolveAssistIntent('תוסיף לשונית לביטחון נחיתה'));
    expectDevelopmentProposal(resolveAssistIntent('שנה את הכיתוב במסך הנחיתה'));
    expectDevelopmentProposal(resolveAssistIntent('תקן את הזרימה במסך'));
    expectDevelopmentProposal(resolveAssistIntent('שפר את הממשק של הנחיתה'));
    expectDevelopmentProposal(resolveAssistIntent('אפשר להוסיף טאב לביטחון נחיתה'));
  });

  it('proposes REQUEST for Hebrew want/need phrasing with a product object', () => {
    expectRequestProposal(resolveAssistIntent('אני רוצה טאב לביטחון נחיתה'));
    expectRequestProposal(resolveAssistIntent('אני צריך מסך לביטחון נחיתה'));
  });

  it('keeps English development and request phrases working', () => {
    expectDevelopmentProposal(resolveAssistIntent('Add a new tab'));
    expectDevelopmentProposal(resolveAssistIntent('Create a screen for landing confidence'));
    expectRequestProposal(resolveAssistIntent('I want a tab for the HUD'));
    const politeEn = resolveAssistIntent('Can you add a feature for the landing UI');
    expect(['DEVELOPMENT', 'REQUEST']).toContain(politeEn.intent);
    expect(politeEn.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
  });

  it('does not turn a Hebrew question into a development task', () => {
    const r = resolveAssistIntent('איך עובד ביטחון הנחיתה?');
    expect(r.intent).toBe('QUESTION');
    expect(r.slots.action).not.toBe('CREATE_DEVELOPMENT_TASK');
  });

  it('does not turn a Hebrew question that mentions a tab into a development task', () => {
    const r = resolveAssistIntent('האם יש טאב לביטחון נחיתה?');
    expect(r.intent).toBe('QUESTION');
    expect(r.slots.action).not.toBe('CREATE_DEVELOPMENT_TASK');
  });

  it('does not treat a Hebrew question without a question mark as development', () => {
    const r = resolveAssistIntent('מה מצב ה-GPS');
    expect(r.intent).toBe('QUESTION');
    expect(r.slots.action).not.toBe('CREATE_DEVELOPMENT_TASK');
  });
});

describe('Assist Hebrew development proposal loop', () => {
  let root;
  let service;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-he-dev-'));
    service = createAssistService({
      repoRoot: root,
      developmentTaskStore: createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') }),
      persistence: createAssistPersistence(root),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns a confirmable CREATE_DEVELOPMENT_TASK proposal for Hebrew add-tab phrasing', async () => {
    const resp = await service.processInput({
      text: 'הוסף טאב לביטחון נחיתה',
      context_snapshot: { current_tab: 'development' },
    });
    expect(resp.intent).toBe('DEVELOPMENT');
    expect(resp.requires_confirmation).toBe(true);
    expect(resp.kind).toBe('ACTION_REQUIRING_CONFIRMATION');
    expect(resp.action_proposal.action).toBe('CREATE_DEVELOPMENT_TASK');
    expect(resp.answer).toMatch(/ענף מבודד/);
    expect(resp.next_step).toMatch(/אישור/);
    expect(resp.intent).not.toBe('UNRESOLVED');
  });

  it('does not propose a development task for a Hebrew question', async () => {
    const resp = await service.processInput({
      text: 'איך עובד ביטחון הנחיתה?',
      context_snapshot: { current_tab: 'development' },
    });
    expect(resp.intent).toBe('QUESTION');
    expect(resp.action_proposal).toBe(null);
    expect(resp.requires_confirmation).toBe(false);
  });
});
