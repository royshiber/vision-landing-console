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
import { ASSIST_HE, hebrewLookingAtAnswer, hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';
import { MISSION_AVAILABLE_ACTIONS } from '../lib/assist/assist-types.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ardulab-fold-'));
  const store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
  const service = createAssistService({
    repoRoot: root,
    developmentTaskStore: store,
    persistence: createAssistPersistence(root),
  });
  return { root, store, service };
}

describe('ArduLab → Assist fold — routes and context', () => {
  it('maps ardulab / featureDesigner labels to the Evolve specialist shelf', () => {
    const route = findAssistRoute('ארדולאב');
    expect(route?.id).toBe('ardulab');
    expect(route?.tab).toBe('featureDesigner');
    expect(route?.workspace).toBe('EVOLVE');
    expect(route?.capability).toBe('evolve');
    expect(findAssistRoute('ardulab')?.tab).toBe('featureDesigner');
    expect(findAssistRoute('feature designer')?.tab).toBe('featureDesigner');
    expect(findAssistRoute('featuredesigner')?.tab).toBe('featureDesigner');
    expect(findAssistRoute('מעצב פיצ׳רים')?.tab).toBe('featureDesigner');
    expect(findAssistRoute('יועץ')?.tab).toBe('advisor');
    expect(findAssistRoute('מעבדה')).toBeNull();
    expect(findAssistRoute('סימולציה')).toBeNull();
    expect(hebrewOpenRouteAnswer('ardulab')).toBe('פותחים את הפיצ׳ר המותאם.');
    expect(hebrewLookingAtAnswer('EVOLVE', 'evolve', 'featureDesigner')).toContain('מסך נוכחי: פיצ׳ר.');
  });

  it('treats #featureDesigner as EVOLVE specialist, not a Mission or Lab peer workspace', () => {
    const ctx = buildAssistContext({ current_tab: 'featureDesigner' });
    expect(ctx.current_workspace).toBe('EVOLVE');
    expect(ctx.current_capability).toBe('evolve');
    expect(ctx.available_actions).toContain('UI_NAVIGATION');
    expect(ctx.available_actions).toContain('CREATE_DEVELOPMENT_TASK');
    expect(ctx.policy_state.flight_actions_allowed).toBe(false);
    expect(ctx.policy_state.param_writes_allowed).toBe(false);
    expect(ctx.policy_state.deploy_allowed).toBe(false);
  });
});

describe('ArduLab → Assist fold — intent routing', () => {
  it('opens ArduLab from Assist', () => {
    const openHe = resolveAssistIntent('פתח ארדולאב');
    expect(openHe.intent).toBe('UI_ACTION');
    expect(openHe.slots.route_id).toBe('ardulab');
    expect(openHe.slots.action).toBe('UI_NAVIGATION');

    const openEn = resolveAssistIntent('Open ardulab');
    expect(openEn.intent).toBe('UI_ACTION');
    expect(openEn.slots.route_id).toBe('ardulab');

    const designer = resolveAssistIntent('Open feature designer');
    expect(designer.slots.route_id).toBe('ardulab');
  });

  it('routes custom-feature talk to ArduLab without stealing peer Assist shelves', () => {
    const brand = resolveAssistIntent('ארדולאב');
    expect(brand.intent).toBe('UI_ACTION');
    expect(brand.slots.route_id).toBe('ardulab');

    const custom = resolveAssistIntent('פיצ׳ר מותאם לבקר');
    expect(custom.intent).toBe('UI_ACTION');
    expect(custom.slots.route_id).toBe('ardulab');
  });

  it('does not steal advisor Q&A, GPS, notes, development, or flight commands', () => {
    expect(resolveAssistIntent('יש לי נדנוד לפני ההצפה, מה לשנות?').slots.route_id).toBe('advisor');
    expect(resolveAssistIntent('פתח מהנדס').slots.route_id).toBe('engineer');
    expect(resolveAssistIntent('What is the GPS status?').intent).toBe('QUESTION');
    expect(resolveAssistIntent('הערה: הסחף ימינה').intent).toBe('NOTE');
    expect(resolveAssistIntent('Add a tab for landing confidence.').intent).toBe('DEVELOPMENT');
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
    expect(resolveAssistIntent('ARM the plane').prohibited).toBe(true);
  });
});

describe('ArduLab → Assist fold — service', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    ({ root, service, store } = makeAssist());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('navigates to featureDesigner without confirmation and without writes', async () => {
    const resp = await service.processInput({
      text: 'פתח ארדולאב',
      context_snapshot: { current_tab: 'pulse' },
    });
    expect(resp.intent).toBe('UI_ACTION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal.action).toBe('UI_NAVIGATION');
    expect(resp.action_proposal.payload.route_id).toBe('ardulab');
    expect(resp.action_proposal.payload.tab).toBe('featureDesigner');
    expect(resp.action_proposal.payload.workspace).toBe('EVOLVE');
    expect(resp.answer).toBe('פותחים את הפיצ׳ר המותאם.');
    expect(store.list({}).length).toBe(0);
  });

  it('still opens ArduLab from Mission and still refuses development there', async () => {
    const nav = await service.processInput({
      text: 'פתח ארדולאב',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(nav.action_proposal.action).toBe('UI_NAVIGATION');
    expect(nav.action_proposal.payload.route_id).toBe('ardulab');
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

describe('ArduLab → Assist fold — chrome', () => {
  it('keeps #featureDesigner reachable from Assist without Lab chrome', () => {
    expect(html).not.toMatch(/class="tab tab-ops"[^>]*data-tab="featureDesigner"/);
    expect(html).not.toContain('id="tabLabMenu"');
    expect(html).not.toContain('id="devArdulabHandoff"');
    expect(html).not.toContain('id="devOpenArdulabBtn"');
    expect(html).not.toContain('מעבדה');
    expect(html).toContain('id="featureDesigner"');
    expect(html).toContain('id="fdWelcomeInput"');
    expect(html).toContain('id="fdAssistFoldNote"');
    expect(html).toContain('id="fdOpenAssistBtn"');
    expect(html).toMatch(/id="fdAssistFoldNote"[^>]*>[\s\S]*שאלו במסייע\./);
    expect(html).toMatch(/data-assist-chip="ardulab"[^>]*>פיצ׳ר</);
    expect(html).toMatch(/data-assist-chip="advisor"[^>]*>יועץ</);
    expect(html).toMatch(/class="fd-welcome-title">פיצ׳ר מותאם</);
    expect(js).toMatch(/featureDesigner:\s*'EVOLVE'/);
    expect(js).toMatch(/featureDesigner:\s*'evolve'/);
    expect(js).toContain("void assistSendText('פתח ארדולאב')");
    expect(js).toContain('fdOpenAssistBtn');
    expect(js).toContain("applyMainTab('featureDesigner')");
    expect(js).toContain("ASSIST_MISSION_HINT_HE = 'הטסה. הערה ותצפית בלבד.'");
    expect(js).toMatch(/tab === 'terrain' \|\| tab === 'flightEngineer'/);
    expect(css).toMatch(/\.fd-assist-fold\b/);
    expect(css).toMatch(/#featureDesigner\.panel\.visible/);
    expect(css).toMatch(/\.assist-quick-chip\[hidden\]/);
  });

  it('does not add flight-command, apply, restart, or secret paths', () => {
    const fold = [
      sliceFunction(js, 'assistSyncMissionPosture'),
      sliceFunction(js, 'assistApplyQuickChip'),
    ].join('\n');
    expect(fold).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY|ELEVENLABS/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('pins APP_VERSION at 1.02.257', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.257'");
    expect(pkg.version).toBe('1.02.257');
  });
});
