import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';
import { buildCapabilityBrief } from '../lib/assist/capability-brief.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';
import { createDevelopmentAgentService } from '../lib/development-agent-service.mjs';
import { MockCodingAgentProvider } from '../lib/coding-agent-provider.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');
const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');
const execution = fs.readFileSync(path.join(repoRoot, 'docs', 'PRODUCT_EXECUTION.md'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
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
      return { removed: byId.delete(id), ...p };
    },
  };
}

function makeAssist({ withAgent = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ask-brief-'));
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

describe('AIRVIX 1.02.269 Ask → Capability Brief F4 (still holds on 1.02.287)', () => {
  it('pins APP_VERSION at 1.02.287', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.287'");
    expect(pkg.version).toBe('1.02.287');
    expect(changelog).toContain('"version": "1.02.269"');
    expect(changelog).toContain('"version": "1.02.272"');
  });

  it('keeps מסייע out of public UI', () => {
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(css.includes('מסייע')).toBe(false);
    expect(commercial.includes('מסייע')).toBe(false);
  });

  it('ships Ask capability brief card with three actions', () => {
    expect(html).toContain('id="assistCapabilityBrief"');
    expect(html).toContain('data-cap-brief="f4"');
    expect(html).toContain('id="assistCapWhat"');
    expect(html).toContain('id="assistCapWhy"');
    expect(html).toContain('id="assistCapModules"');
    expect(html).toContain('id="assistCapTaxonomy"');
    expect(html).toMatch(/id="assistCapOpenDevelopBtn"[^>]*>פתח בפיתוח</);
    expect(html).toMatch(/id="assistCapSaveDraftBtn"[^>]*>שמור טיוטה</);
    expect(html).toMatch(/id="assistCapStartAgentBtn"[^>]*>התחל סוכן</);
    expect(html).toContain('סוכן הפיתוח אינו זמין. חברו אותו ב-AIRVIX Ask.');
    expect(css).toContain('.assist-cap-brief');
    expect(css).toContain('.assist-rail:not(.assist-rail--mission) .assist-proposal-bar');
    expect(css).toContain('max-height: 42vh');
    expect(js).toContain('function assistRenderCapabilityBrief(');
    expect(js).toContain('function capHandoffFromAsk(');
    expect(js).toContain('function assistOpenCapabilityInDevelop(');
  });

  it('handoff fills F1 composer and switches to Develop', () => {
    const handoff = sliceFunction(js, 'capHandoffFromAsk');
    expect(handoff).toContain("applyMainTab('development')");
    expect(handoff).toContain("getElementById('devTaskTitle')");
    expect(handoff).toContain("getElementById('devTaskDescription')");
    expect(handoff).toContain('capSetTaxonomy');
    expect(handoff).toContain('capRenderDraftCard');
    expect(handoff).toContain('_capDraftOverride');
    expect(handoff).toContain('developChatSeedFromBrief');
    expect(js).toContain("getElementById('assistCapOpenDevelopBtn')?.addEventListener('click'");
    expect(js).toContain('assistOpenCapabilityInDevelop');
  });

  it('reuses CREATE_DEVELOPMENT_TASK and existing agent start', () => {
    expect(js).toContain("start_agent: startAgent !== false");
    expect(js).toContain("assistConfirm(true, { startAgent: false })");
    expect(js).toContain("assistConfirm(true, { startAgent: true })");
    expect(js).not.toContain('CREATE_CAPABILITY_AGENT');
    expect(js).not.toContain('startCapabilityAgentStack');
    expect(js).toContain("data.action === 'CREATE_DEVELOPMENT_TASK'");
    expect(js).toContain("agent_runtime === 'NOT_STARTED'");
  });

  it('detects Hebrew and English capability asks as FEATURE briefs', () => {
    const he = resolveAssistIntent('יכולת חדשה לנחיתה מדויקת');
    expect(he.intent).toBe('DEVELOPMENT');
    expect(he.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
    expect(he.slots.taxonomy).toBe('FEATURE');
    const en = resolveAssistIntent('Add a capability for precision landing');
    expect(en.intent).toBe('DEVELOPMENT');
    expect(en.slots.action).toBe('CREATE_DEVELOPMENT_TASK');
    const brief = buildCapabilityBrief({
      title: 'Add a tab for landing confidence.',
      description: 'Add a tab for landing confidence.',
      taxonomy: 'FEATURE',
      target_area: 'LANDING',
    });
    expect(brief.taxonomy).toBe('FEATURE');
    expect(brief.what).toMatch(/landing confidence/i);
    expect(brief.modules).toContain('Mission UI');
  });

  it('does not add AH polish, flight writes, apply, restart, or secrets', () => {
    expect(js).not.toContain('הגדל את האופק');
    expect(html).not.toContain('הגדל את האופק');
    const src = [
      sliceFunction(js, 'capHandoffFromAsk'),
      sliceFunction(js, 'assistOpenCapabilityInDevelop'),
      sliceFunction(js, 'assistRenderCapabilityBrief'),
      sliceFunction(js, 'assistSetProposalBar'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(commercial).toContain('כרטיס קצר');
    expect(execution).toContain('F4');
    expect(execution).toContain('F3');
  });
});

describe('Ask capability brief service loop', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    ({ root, service, store } = makeAssist({ withAgent: true }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('proposes a FEATURE brief from Develop / Pulse and does not create until an action', async () => {
    const resp = await service.processInput({
      text: 'Add a capability for precision landing',
      context_snapshot: { current_tab: 'development', current_workspace: 'EVOLVE' },
    });
    expect(resp.intent).toBe('DEVELOPMENT');
    expect(resp.action_proposal.action).toBe('CREATE_DEVELOPMENT_TASK');
    expect(resp.capability_brief.taxonomy).toBe('FEATURE');
    expect(resp.capability_brief.modules.length).toBeGreaterThan(0);
    expect(resp.capability_brief.what).toMatch(/capability|landing/i);
    expect(resp.next_step).toBe(ASSIST_HE.developmentProposalNextStep);
    expect(store.list({}).length).toBe(0);
  });

  it('saves a FEATURE draft without starting the coding agent', async () => {
    const resp = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'pulse', current_workspace: 'PULSE' },
    });
    const saved = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
      start_agent: false,
    });
    expect(saved.ok).toBe(true);
    expect(saved.result.agent_started).toBe(false);
    expect(saved.result.agent_runtime).toBe('NOT_STARTED');
    expect(saved.result.worktree_created).toBe(false);
    expect(saved.answer).toBe(ASSIST_HE.taskDraftSaved);
    expect(saved.result.navigation.tab).toBe('development');
    expect(store.list({}).length).toBe(1);
    expect(store.list({})[0].taxonomy).toBe('FEATURE');
    expect(store.list({})[0].agent.state).toBe('NOT_STARTED');
  });

  it('starts the existing isolated-branch agent from the brief when asked', async () => {
    const resp = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'development' },
    });
    const started = await service.confirmProposal({
      proposal_id: resp.action_proposal.id,
      confirm: true,
      start_agent: true,
    });
    expect(started.ok).toBe(true);
    expect(started.result.agent_started).toBe(true);
    expect(started.result.worktree.branch.startsWith('development/tasks/')).toBe(true);
    expect(started.result.release_created).toBe(false);
    expect(started.result.deploy_started).toBe(false);
  });

  it('Mission still refuses development and does not start an agent', async () => {
    const resp = await service.processInput({
      text: 'Add a capability for precision landing',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(resp.intent).toBe('DEVELOPMENT');
    expect(resp.action_proposal).toBe(null);
    expect(resp.capability_brief).toBeUndefined();
    expect(resp.answer).toBe(ASSIST_HE.missionDevelopmentRefused);
    expect(store.list({}).length).toBe(0);
    expect(service._pendingSize()).toBe(0);
  });
});
