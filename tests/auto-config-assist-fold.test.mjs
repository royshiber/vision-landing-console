import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAssistContext } from '../lib/assist/assist-context.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { ASSIST_HE, hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';
import { MISSION_AVAILABLE_ACTIONS } from '../lib/assist/assist-types.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const paren = src.indexOf('(', start);
  let depth = 0;
  let i = paren;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const brace = src.indexOf('{', i);
  depth = 0;
  for (i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function makeAssist() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-auto-config-fold-'));
  const store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
  const service = createAssistService({
    repoRoot: root,
    developmentTaskStore: store,
    persistence: createAssistPersistence(root),
  });
  return { root, store, service };
}

describe('Auto-Config → Assist + Configuration fold — routes and context', () => {
  it('maps auto-config / אשף / קונפיג אוטומטי to Parameter Center #autoConfig', () => {
    const route = findAssistRoute('אשף');
    expect(route?.id).toBe('auto-config');
    expect(route?.tab).toBe('control');
    expect(route?.subtab).toBe('autoConfig');
    expect(route?.workspace).toBe('PLATFORM');
    expect(route?.capability).toBe('configuration');
    expect(findAssistRoute('auto-config')?.subtab).toBe('autoConfig');
    expect(findAssistRoute('autoconfig')?.subtab).toBe('autoConfig');
    expect(findAssistRoute('auto config')?.subtab).toBe('autoConfig');
    expect(findAssistRoute('קונפיג אוטומטי')?.subtab).toBe('autoConfig');
    expect(findAssistRoute('קונפיגורציה אוטומטית')?.subtab).toBe('autoConfig');
    expect(findAssistRoute('אשף קונפיגורציה')?.subtab).toBe('autoConfig');
    expect(findAssistRoute('פרמטרים')?.id).toBe('configuration');
    expect(findAssistRoute('פרמטרים')?.subtab).toBeUndefined();
    expect(hebrewOpenRouteAnswer('auto-config')).toBe('פותחים את אשף הקונפיגורציה.');
  });

  it('treats #autoConfig as Platform configuration, not a write path', () => {
    const ctx = buildAssistContext({
      current_tab: 'control',
      current_subtab: 'autoConfig',
    });
    expect(ctx.current_workspace).toBe('PLATFORM');
    expect(ctx.current_capability).toBe('configuration');
    expect(ctx.available_actions).toContain('UI_NAVIGATION');
    expect(ctx.policy_state.flight_actions_allowed).toBe(false);
    expect(ctx.policy_state.param_writes_allowed).toBe(false);
    expect(ctx.policy_state.deploy_allowed).toBe(false);
  });
});

describe('Auto-Config → Assist + Configuration fold — intent routing', () => {
  it('opens Auto-Config from Assist', () => {
    const openHe = resolveAssistIntent('פתח אשף');
    expect(openHe.intent).toBe('UI_ACTION');
    expect(openHe.slots.route_id).toBe('auto-config');
    expect(openHe.slots.action).toBe('UI_NAVIGATION');

    const phrase = resolveAssistIntent('פתח קונפיג אוטומטי');
    expect(phrase.slots.route_id).toBe('auto-config');

    const openEn = resolveAssistIntent('Open auto-config');
    expect(openEn.slots.route_id).toBe('auto-config');
  });

  it('routes bare spoken Hebrew to Auto-Config without stealing peer shelves', () => {
    const wizard = resolveAssistIntent('אשף');
    expect(wizard.intent).toBe('UI_ACTION');
    expect(wizard.slots.route_id).toBe('auto-config');

    const auto = resolveAssistIntent('קונפיג אוטומטי');
    expect(auto.slots.route_id).toBe('auto-config');

    expect(resolveAssistIntent('פתח פרמטרים').slots.route_id).toBe('configuration');
    expect(resolveAssistIntent('יש לי נדנוד לפני ההצפה, מה לשנות?').slots.route_id).toBe('advisor');
    expect(resolveAssistIntent('פתח מהנדס').slots.route_id).toBe('engineer');
    expect(resolveAssistIntent('פתח ארדולאב').slots.route_id).toBe('ardulab');
  });

  it('does not steal GPS, notes, development, or flight commands', () => {
    expect(resolveAssistIntent('What is the GPS status?').intent).toBe('QUESTION');
    expect(resolveAssistIntent('הערה: הסחף ימינה').intent).toBe('NOTE');
    expect(resolveAssistIntent('Add a tab for landing confidence.').intent).toBe('DEVELOPMENT');
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
    expect(resolveAssistIntent('ARM the plane').prohibited).toBe(true);
  });
});

describe('Auto-Config → Assist + Configuration fold — service', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    ({ root, service, store } = makeAssist());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('navigates to #autoConfig without confirmation and without writes', async () => {
    const resp = await service.processInput({
      text: 'פתח אשף',
      context_snapshot: { current_tab: 'pulse' },
    });
    expect(resp.intent).toBe('UI_ACTION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal.action).toBe('UI_NAVIGATION');
    expect(resp.action_proposal.payload.route_id).toBe('auto-config');
    expect(resp.action_proposal.payload.tab).toBe('control');
    expect(resp.action_proposal.payload.subtab).toBe('autoConfig');
    expect(resp.action_proposal.payload.workspace).toBe('PLATFORM');
    expect(resp.answer).toBe('פותחים את אשף הקונפיגורציה.');
    expect(store.list({}).length).toBe(0);
  });

  it('still opens Auto-Config from Mission and still refuses development there', async () => {
    const nav = await service.processInput({
      text: 'פתח קונפיג אוטומטי',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(nav.action_proposal.action).toBe('UI_NAVIGATION');
    expect(nav.action_proposal.payload.route_id).toBe('auto-config');
    expect(nav.requires_confirmation).toBe(false);

    const refused = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(refused.intent).toBe('DEVELOPMENT');
    expect(refused.action_proposal).toBe(null);
    expect(refused.answer).toBe(ASSIST_HE.missionDevelopmentRefused);
    expect(store.list({}).length).toBe(0);

    const missionCtx = buildAssistContext({ current_tab: 'terrain' });
    expect(missionCtx.available_actions).toEqual([...MISSION_AVAILABLE_ACTIONS]);
    expect(missionCtx.available_actions).not.toContain('CREATE_DEVELOPMENT_TASK');
  });
});

describe('Auto-Config → Assist + Configuration fold — chrome', () => {
  it('keeps #autoConfig under Parameter Center after Platform tab removal', () => {
    expect(html).toContain('id="autoConfig"');
    expect(html).toContain('data-ac-model="concept-b"');
    expect(html).toContain('id="acBCardWhat"');
    expect(html).toContain('id="acPlanBtn"');
    expect(html).toMatch(/class="subtab"[^>]*data-subtab="autoConfig"[^>]*>אשף קונפיגורציה</);
    expect(html).not.toContain('data-platform-go');
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="control"[^>]*>פרמטרים</);
    expect(js).toContain("applyControlSubtab('autoConfig')");
    expect(js).toMatch(/action === 'auto-config'/);
    expect(js).toContain("autoConfig: 'configuration'");
    expect(js).toContain("ASSIST_MISSION_HINT_HE = 'הטסה. הערה ותצפית בלבד.'");
    expect(js).toMatch(/tab === 'terrain' \|\| tab === 'flightEngineer'/);
    expect(html).toContain('id="featureDesigner"');
    expect(html).toContain('id="advisor"');
    expect(html).toContain('id="flightEngineer"');
  });

  it('does not add flight-command, apply, restart, or secret paths', () => {
    const fold = [
      sliceFunction(js, 'operatorOpenFirstAction'),
      sliceFunction(js, 'assistApplyNavigation'),
    ].join('\n');
    expect(fold).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY|ELEVENLABS/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('pins APP_VERSION at 1.02.286', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.286'");
    expect(pkg.version).toBe('1.02.286');
  });
});
