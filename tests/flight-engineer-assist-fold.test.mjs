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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-fe-fold-'));
  const store = createDevelopmentTaskStore({ filePath: path.join(root, 'tasks.json') });
  const service = createAssistService({
    repoRoot: root,
    developmentTaskStore: store,
    persistence: createAssistPersistence(root),
  });
  return { root, store, service };
}

describe('Flight Engineer → Assist fold — routes and context', () => {
  it('maps מהנדס / flight engineer labels to the MISSION engineer shelf', () => {
    const route = findAssistRoute('מהנדס');
    expect(route?.id).toBe('engineer');
    expect(route?.tab).toBe('flightEngineer');
    expect(route?.workspace).toBe('MISSION');
    expect(route?.capability).toBe('voice');
    expect(findAssistRoute('flight engineer')?.tab).toBe('flightEngineer');
    expect(findAssistRoute('voice engineer')?.tab).toBe('flightEngineer');
    expect(findAssistRoute('מהנדס טיסה')?.tab).toBe('flightEngineer');
    expect(findAssistRoute('מהנדס מעבדה')?.tab).toBe('flightEngineer');
    expect(findAssistRoute('מהנדס קולי')?.tab).toBe('flightEngineer');
    expect(findAssistRoute('יועץ')?.tab).toBe('advisor');
    expect(findAssistRoute('מעבדה')?.tab).toBe('simLab');
    expect(hebrewOpenRouteAnswer('engineer')).toBe('פותחים את מהנדס הטיסה.');
    expect(hebrewLookingAtAnswer('MISSION', 'voice', 'flightEngineer')).toContain('מסך נוכחי: מהנדס טיסה.');
  });

  it('keeps #flightEngineer as MISSION, not a coding-agent surface', () => {
    const ctx = buildAssistContext({ current_tab: 'flightEngineer' });
    expect(ctx.current_workspace).toBe('MISSION');
    expect(ctx.current_capability).toBe('voice');
    expect(ctx.available_actions).toEqual([...MISSION_AVAILABLE_ACTIONS]);
    expect(ctx.available_actions).not.toContain('CREATE_DEVELOPMENT_TASK');
    expect(ctx.policy_state.flight_actions_allowed).toBe(false);
    expect(ctx.policy_state.param_writes_allowed).toBe(false);
    expect(ctx.policy_state.agent_autostart_allowed).toBe(false);
  });
});

describe('Flight Engineer → Assist fold — intent routing', () => {
  it('opens the engineer panel from Assist', () => {
    const openHe = resolveAssistIntent('פתח מהנדס');
    expect(openHe.intent).toBe('UI_ACTION');
    expect(openHe.slots.route_id).toBe('engineer');
    expect(openHe.slots.action).toBe('UI_NAVIGATION');

    const openEn = resolveAssistIntent('Open flight engineer');
    expect(openEn.intent).toBe('UI_ACTION');
    expect(openEn.slots.route_id).toBe('engineer');

    const voice = resolveAssistIntent('Open voice engineer');
    expect(voice.slots.route_id).toBe('engineer');
  });

  it('routes voice/ops-notes style talk to the engineer shelf', () => {
    const voiceNote = resolveAssistIntent('פתק קולי על הסחף');
    expect(voiceNote.intent).toBe('UI_ACTION');
    expect(voiceNote.slots.route_id).toBe('engineer');

    const ops = resolveAssistIntent('ops notes from the headset');
    expect(ops.intent).toBe('UI_ACTION');
    expect(ops.slots.route_id).toBe('engineer');
  });

  it('does not steal advisor Q&A, GPS, notes, development, or flight commands', () => {
    expect(resolveAssistIntent('יש לי נדנוד לפני ההצפה, מה לשנות?').slots.route_id).toBe('advisor');
    expect(resolveAssistIntent('What is the GPS status?').intent).toBe('QUESTION');
    expect(resolveAssistIntent('הערה: הסחף ימינה').intent).toBe('NOTE');
    expect(resolveAssistIntent('Add a tab for landing confidence.').intent).toBe('DEVELOPMENT');
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
    expect(resolveAssistIntent('ARM the plane').prohibited).toBe(true);
    expect(resolveAssistIntent('land now').prohibited).toBe(true);
  });
});

describe('Flight Engineer → Assist fold — service', () => {
  let root;
  let service;
  let store;

  beforeEach(() => {
    ({ root, service, store } = makeAssist());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('navigates to flightEngineer without confirmation and without writes', async () => {
    const resp = await service.processInput({
      text: 'פתח מהנדס',
      context_snapshot: { current_tab: 'pulse' },
    });
    expect(resp.intent).toBe('UI_ACTION');
    expect(resp.requires_confirmation).toBe(false);
    expect(resp.action_proposal.action).toBe('UI_NAVIGATION');
    expect(resp.action_proposal.payload.route_id).toBe('engineer');
    expect(resp.action_proposal.payload.tab).toBe('flightEngineer');
    expect(resp.action_proposal.payload.workspace).toBe('MISSION');
    expect(resp.answer).toBe('פותחים את מהנדס הטיסה.');
    expect(store.list({}).length).toBe(0);
  });

  it('still opens the engineer from Mission and still refuses development there', async () => {
    const nav = await service.processInput({
      text: 'פתח מהנדס',
      context_snapshot: { current_tab: 'terrain', current_workspace: 'MISSION' },
    });
    expect(nav.action_proposal.action).toBe('UI_NAVIGATION');
    expect(nav.action_proposal.payload.route_id).toBe('engineer');
    expect(nav.requires_confirmation).toBe(false);

    const refused = await service.processInput({
      text: 'Add a tab for landing confidence.',
      context_snapshot: { current_tab: 'flightEngineer', current_workspace: 'MISSION' },
    });
    expect(refused.intent).toBe('DEVELOPMENT');
    expect(refused.action_proposal).toBe(null);
    expect(refused.answer).toBe(ASSIST_HE.missionDevelopmentRefused);
    expect(store.list({}).length).toBe(0);

    const missionCtx = buildAssistContext({ current_tab: 'flightEngineer' });
    expect(missionCtx.available_actions).toEqual([...MISSION_AVAILABLE_ACTIONS]);
    expect(missionCtx.available_actions).not.toContain('CREATE_DEVELOPMENT_TASK');
  });
});

describe('Flight Engineer → Assist fold — chrome', () => {
  it('keeps #flightEngineer on the lab shelf and folds Assist chrome', () => {
    expect(html).not.toMatch(/class="tab tab-ops"[^>]*data-tab="flightEngineer"/);
    const menu = html.match(/<div id="tabLabMenu"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1] || '';
    expect(menu).toMatch(/class="tab tab-lab"[^>]*data-tab="flightEngineer"[^>]*>מהנדס מעבדה</);
    expect(html).toContain('id="flightEngineer"');
    expect(html).toContain('id="feChat"');
    expect(html).toContain('id="feMicBtn"');
    expect(html).toContain('id="feAssistFoldNote"');
    expect(html).toContain('id="feOpenAssistBtn"');
    expect(html).toMatch(/id="feAssistFoldNote"[^>]*>[\s\S]*שאלו במסייע\./);
    expect(html).toMatch(/data-assist-chip="flightEngineer"[^>]*>מהנדס</);
    expect(html).toMatch(/data-assist-chip="advisor"[^>]*>יועץ</);
    expect(html).toContain('id="advisorAssistFoldNote"');
    expect(js).toMatch(/flightEngineer:\s*'MISSION'/);
    expect(js).toMatch(/flightEngineer:\s*'voice'/);
    expect(js).toContain("void assistSendText('פתח מהנדס')");
    expect(js).toContain('feOpenAssistBtn');
    expect(js).toContain("ASSIST_MISSION_HINT_HE = 'הטסה. הערה ותצפית בלבד.'");
    expect(js).toMatch(/tab === 'terrain' \|\| tab === 'flightEngineer'/);
    expect(css).toMatch(/\.fe-assist-fold\b/);
    expect(css).toMatch(/\.assist-quick-chip\[hidden\]/);
  });

  it('does not add flight-command, apply, restart, or secret paths', () => {
    const fold = [
      sliceFunction(js, 'assistSyncMissionPosture'),
      sliceFunction(js, 'assistApplyQuickChip'),
    ].join('\n');
    expect(fold).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY|ELEVENLABS/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(html).toContain('id="pfdVoiceFlightBtn"');
  });

  it('pins APP_VERSION at 1.02.255', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.255'");
    expect(pkg.version).toBe('1.02.255');
  });
});
