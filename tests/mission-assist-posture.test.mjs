import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAssistContext } from '../lib/assist/assist-context.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';
import { MISSION_AVAILABLE_ACTIONS } from '../lib/assist/assist-types.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';
import { createDevelopmentAgentService } from '../lib/development-agent-service.mjs';
import { MockCodingAgentProvider } from '../lib/coding-agent-provider.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

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
      return { removed: byId.delete(id), ...p };
    },
  };
}

function makeAssist({ withAgent = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-mission-assist-'));
  const store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
  const extras = {};
  if (withAgent) {
    extras.codingAgentProvider = new MockCodingAgentProvider({ scenario: 'healthy' });
    extras.worktreeManager = memoryWorktreeManager();
    extras.developmentAgentService = createDevelopmentAgentService({
      store,
      provider: extras.codingAgentProvider,
      worktreeManager: extras.worktreeManager,
    });
  }
  const service = createAssistService({
    repoRoot: root,
    developmentTaskStore: store,
    persistence: createAssistPersistence(root),
    ...extras,
  });
  return { root, store, service };
}

describe('C10.6 Mission Assist context', () => {
  it('limits Mission available_actions and keeps flight writes off', () => {
    const fromTerrain = buildAssistContext({ current_tab: 'terrain' }, {
      available_actions: ['UI_NAVIGATION', 'CREATE_NOTE', 'CREATE_OBSERVATION', 'CREATE_DEVELOPMENT_TASK'],
      policy_state: { flight_actions_allowed: true, deploy_allowed: true },
    });
    expect(fromTerrain.current_workspace).toBe('MISSION');
    expect(fromTerrain.available_actions).toEqual([...MISSION_AVAILABLE_ACTIONS]);
    expect(fromTerrain.available_actions).not.toContain('CREATE_DEVELOPMENT_TASK');
    expect(fromTerrain.policy_state.flight_actions_allowed).toBe(false);
    expect(fromTerrain.policy_state.param_writes_allowed).toBe(false);
    expect(fromTerrain.policy_state.deploy_allowed).toBe(false);
    expect(fromTerrain.policy_state.requires_confirmation_for).toEqual(['CREATE_NOTE', 'CREATE_OBSERVATION']);

    const fromEngineer = buildAssistContext({ current_tab: 'flightEngineer' });
    expect(fromEngineer.current_workspace).toBe('MISSION');
    expect(fromEngineer.available_actions).toEqual([...MISSION_AVAILABLE_ACTIONS]);
  });

  it('keeps CREATE_DEVELOPMENT_TASK on Evolve', () => {
    const ctx = buildAssistContext({ current_tab: 'development' });
    expect(ctx.current_workspace).toBe('EVOLVE');
    expect(ctx.available_actions).toContain('CREATE_DEVELOPMENT_TASK');
  });
});

describe('C10.6 Mission refuses development', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    ({ root, service, store } = makeAssist({ withAgent: true }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses English development phrasing in Mission without starting an agent', async () => {
    const resp = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(resp.intent).toBe('DEVELOPMENT');
    expect(resp.kind).toBe('INFORMATION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal).toBe(null);
    expect(resp.answer).toBe(ASSIST_HE.missionDevelopmentRefused);
    expect(resp.next_step).toBe(ASSIST_HE.missionDevelopmentNextStep);
    expect(resp.answer).toMatch(/הטסה/);
    expect(resp.answer).toMatch(/פיתוח/);
    expect(store.list({}).length).toBe(0);
    expect(service._pendingSize()).toBe(0);
  });

  it('refuses תכתוב משימת פיתוח in Mission', async () => {
    const resolved = resolveAssistIntent('תכתוב משימת פיתוח');
    expect(resolved.intent).toBe('DEVELOPMENT');
    expect(resolved.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
    const resp = await service.processInput({
      text: 'תכתוב משימת פיתוח',
      context_snapshot: { current_tab: 'flightEngineer', current_workspace: 'MISSION' },
    });
    expect(resp.intent).toBe('DEVELOPMENT');
    expect(resp.action_proposal).toBe(null);
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.answer).toBe(ASSIST_HE.missionDevelopmentRefused);
    expect(store.list({}).length).toBe(0);
  });

  it('still proposes NOTE and OBSERVATION in Mission', async () => {
    const note = await service.processInput({
      text: 'הערה: הסחף ימינה',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(note.intent).toBe('NOTE');
    expect(note.requires_confirmation).toBe(true);
    expect(note.action_proposal.action).toBe('CREATE_NOTE');
    const savedNote = await service.confirmProposal({
      proposal_id: note.action_proposal.id,
      confirm: true,
    });
    expect(savedNote.ok).toBe(true);
    expect(savedNote.result.note.text).toMatch(/הסחף ימינה/);

    const obs = await service.processInput({
      text: 'תצפית: הסחף ימינה',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(obs.intent).toBe('OBSERVATION');
    expect(obs.action_proposal.action).toBe('CREATE_OBSERVATION');
    const savedObs = await service.confirmProposal({
      proposal_id: obs.action_proposal.id,
      confirm: true,
    });
    expect(savedObs.ok).toBe(true);
    expect(savedObs.result.observation.workspace).toBe('MISSION');
  });

  it('still creates a development task from Evolve', async () => {
    const resp = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'development', current_workspace: 'EVOLVE' },
    });
    expect(resp.action_proposal.action).toBe('CREATE_DEVELOPMENT_TASK');
    const confirmed = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.result.agent_started).toBe(true);
    expect(store.list({}).length).toBe(1);
  });
});

describe('C10.6 Mission chrome', () => {
  it('marks #terrain as הטסה without hiding PFD or map', () => {
    expect(html).toMatch(/id="missionIdentity"[^>]*>הטסה · מרחב טיסה</);
    expect(html).toMatch(/class="tab tab-fly[^"]*"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(html).toContain('id="flightHud"');
    expect(html).toContain('id="terrainMap"');
    expect(html).toMatch(/class="terrain-flight-shell(?:\s|")/);
    expect(css).toMatch(/\.mission-identity\b/);
  });

  it('uses a flight-safe Assist hint on Mission tabs', () => {
    expect(html).toMatch(/id="assistRailHint"[^>]*>שינוי דורש אישור\.</);
    expect(html).toMatch(/id="assistEmptyInvite"[^>]*>שאלו כאן\.</);
    expect(html).toMatch(/id="assistQuickChips"[^>]*hidden/);
    expect(html).toMatch(/data-assist-chip="note">הערה</);
    expect(html).toMatch(/data-assist-chip="observation">תצפית</);
    expect(html).toMatch(/data-assist-chip="advisor"[^>]*>יועץ</);
    expect(html).toMatch(/data-assist-chip="ardulab"[^>]*>פיצ׳ר</);
    expect(html).toMatch(/data-assist-chip="flightEngineer"[^>]*>מהנדס</);
    expect(js).toContain("ASSIST_MISSION_HINT_HE = 'הטסה. הערה ותצפית בלבד.'");
    expect(js).toContain("ASSIST_MISSION_PLACEHOLDER_HE = 'הערה, תצפית, או שאלה'");
    expect(js).toContain('function assistSyncMissionPosture(');
    expect(js).toContain('function assistIsMissionTab(');
    expect(js).toContain('_assistChromeReady');
    expect(js).toMatch(/if \(_assistChromeReady\) assistRefreshContextChip\(\)/);
    expect(js).toMatch(/tab === 'terrain' \|\| tab === 'flightEngineer'/);
    expect(html).not.toContain('מה שחשוב עכשיו בלבד');
    expect(js).not.toContain('מה שחשוב עכשיו בלבד');
  });

  it('does not add flight-command or companion-apply paths', () => {
    expect(js).toMatch(/function assistSyncMissionPosture\([\s\S]*?\(kind === 'advisor' \|\| kind === 'ardulab'\) \? mission : !mission/);
    const posture = js.slice(js.indexOf('function assistSyncMissionPosture('), js.indexOf('function assistApplyQuickChip('));
    expect(posture).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
  });

  it('pins APP_VERSION at 1.02.258', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.258'");
    expect(pkg.version).toBe('1.02.258');
  });
});
