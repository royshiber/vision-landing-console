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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-advisor-fold-'));
  const store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
  const service = createAssistService({
    repoRoot: root,
    developmentTaskStore: store,
    persistence: createAssistPersistence(root),
  });
  return { root, store, service };
}

describe('Advisor → Assist fold — routes and context', () => {
  it('maps advisor labels to the LAB advisor shelf', () => {
    const route = findAssistRoute('יועץ');
    expect(route?.id).toBe('advisor');
    expect(route?.tab).toBe('advisor');
    expect(route?.workspace).toBe('LAB');
    expect(route?.capability).toBe('advisor');
    expect(findAssistRoute('advisor')?.tab).toBe('advisor');
    expect(findAssistRoute('ai advisor')?.tab).toBe('advisor');
    expect(findAssistRoute('יועץ')?.tab).toBe('advisor');
    expect(findAssistRoute('מעבדה')).toBeNull();
    expect(findAssistRoute('סימולציה')).toBeNull();
    expect(hebrewOpenRouteAnswer('advisor')).toBe('פותחים את היועץ.');
    expect(hebrewLookingAtAnswer('LAB', 'advisor', 'advisor')).toContain('מסך נוכחי: יועץ.');
  });

  it('treats #advisor as LAB, not a Platform peer', () => {
    const ctx = buildAssistContext({ current_tab: 'advisor' });
    expect(ctx.current_workspace).toBe('LAB');
    expect(ctx.current_capability).toBe('advisor');
    expect(ctx.available_actions).toContain('UI_NAVIGATION');
    expect(ctx.policy_state.flight_actions_allowed).toBe(false);
    expect(ctx.policy_state.param_writes_allowed).toBe(false);
  });
});

describe('Advisor → Assist fold — intent routing', () => {
  it('opens the lab advisor from Assist', () => {
    const openHe = resolveAssistIntent('פתח יועץ');
    expect(openHe.intent).toBe('UI_ACTION');
    expect(openHe.slots.route_id).toBe('advisor');
    expect(openHe.slots.action).toBe('UI_NAVIGATION');

    const openEn = resolveAssistIntent('Open advisor');
    expect(openEn.intent).toBe('UI_ACTION');
    expect(openEn.slots.route_id).toBe('advisor');
  });

  it('routes advisor-style questions to the lab shelf', () => {
    const pitch = resolveAssistIntent('יש לי נדנוד לפני ההצפה, מה לשנות?');
    expect(pitch.intent).toBe('UI_ACTION');
    expect(pitch.slots.route_id).toBe('advisor');

    const hard = resolveAssistIntent('הנחיתה קשה מדי, איזה פרמטר לשנות?');
    expect(hard.intent).toBe('UI_ACTION');
    expect(hard.slots.route_id).toBe('advisor');

    const abort = resolveAssistIntent('יש לי הרבה ABORT שגויים, מה לכוונן?');
    expect(abort.intent).toBe('UI_ACTION');
    expect(abort.slots.route_id).toBe('advisor');
  });

  it('does not steal GPS, notes, or development', () => {
    expect(resolveAssistIntent('What is the GPS status?').intent).toBe('QUESTION');
    expect(resolveAssistIntent('הערה: הסחף ימינה').intent).toBe('NOTE');
    expect(resolveAssistIntent('Add a tab for landing confidence.').intent).toBe('DEVELOPMENT');
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
  });
});

describe('Advisor → Assist fold — service', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    ({ root, service, store } = makeAssist());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('navigates to advisor without confirmation and without writes', async () => {
    const resp = await service.processInput({
      text: 'פתח יועץ',
      context_snapshot: { current_tab: 'pulse' },
    });
    expect(resp.intent).toBe('UI_ACTION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal.action).toBe('UI_NAVIGATION');
    expect(resp.action_proposal.payload.route_id).toBe('advisor');
    expect(resp.action_proposal.payload.tab).toBe('advisor');
    expect(resp.action_proposal.payload.workspace).toBe('LAB');
    expect(resp.answer).toBe('פותחים את היועץ.');
    expect(store.list({}).length).toBe(0);
  });

  it('still opens advisor from Mission and still refuses development there', async () => {
    const nav = await service.processInput({
      text: 'יש לי נדנוד לפני ההצפה, מה לשנות?',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(nav.action_proposal.action).toBe('UI_NAVIGATION');
    expect(nav.action_proposal.payload.route_id).toBe('advisor');
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

describe('Advisor → Assist fold — chrome', () => {
  it('keeps advisor reachable from Assist and out of primary ops tabs', () => {
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(html).not.toMatch(/class="tab tab-ops"[^>]*data-tab="advisor"/);
    expect(html).not.toContain('id="tabLabMenu"');
    expect(html).not.toContain('מעבדה');
    expect(html).toContain('id="advisor"');
    expect(html).toContain('id="advisorInput"');
    expect(html).toContain('id="advisorSendBtn"');
    expect(html).toContain('id="advisorIssuesList"');
    expect(html).toMatch(/data-prompt="יש לי נדנוד לפני ההצפה, מה לשנות\?"/);
    expect(html).toContain('id="advisorAssistFoldNote"');
    expect(html).toContain('id="advisorOpenAssistBtn"');
    expect(html).toMatch(/id="advisorAssistFoldNote"[^>]*>[\s\S]*שאלו את AIRVIX Ask./);
    expect(html).toMatch(/data-assist-chip="advisor"[^>]*>יועץ</);
    expect(html).toMatch(/id="assistEmptyInvite"[^>]*>שאלו את AIRVIX Ask.</);
    expect(js).toContain("ASSIST_TAB_WORKSPACE");
    expect(js).toMatch(/advisor:\s*'LAB'/);
    expect(js).toMatch(/advisor:\s*'advisor'/);
    expect(js).toContain("ASSIST_DEFAULT_INVITE_HE = 'שאלו את AIRVIX Ask.'");
    expect(js).toContain("void assistSendText('פתח יועץ')");
    expect(js).toContain("advisorOpenAssistBtn");
    expect(css).toMatch(/\.advisor-assist-fold\b/);
    expect(css).toMatch(/\.assist-quick-chip\[hidden\]/);
    expect(js).toMatch(/function attentionSyncAssistChrome\(/);
    expect(js).toContain("ASSIST_MISSION_HINT_HE = 'הטסה. הערה ותצפית בלבד.'");
  });

  it('does not add flight-command, apply, restart, or secret paths', () => {
    const fold = [
      sliceFunction(js, 'assistSyncMissionPosture'),
      sliceFunction(js, 'assistApplyQuickChip'),
    ].join('\n');
    expect(fold).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY|ELEVENLABS/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('pins APP_VERSION at 1.02.264', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.264'");
    expect(pkg.version).toBe('1.02.264');
  });
});
