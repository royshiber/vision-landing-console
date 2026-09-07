import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

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

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

describe('AIRVIX Mission chrome — top strip gone', () => {
  it('removes the blue telemetry top strip and keeps connect floating', () => {
    expect(html).not.toMatch(/class="topbar"/);
    expect(html).not.toMatch(/class="topbar-right-scroll"/);
    expect(html).not.toContain('רמת ביטחון נחיתה לפי תמונה');
    expect(html).not.toContain('הפרש Vision מול GPS');
    expect(html).not.toContain('assist-toggle-en');
    expect(html).toMatch(/<header class="app-chrome"/);
    expect(html).toMatch(/id="connectWidget"[^>]*connect-widget-float/);
    expect(html).toMatch(/id="connectWidget"[\s\S]*?<\/div>\s*<header class="app-chrome"/);
    expect(html).toMatch(/<main class="layout">\s*<div id="controlSubtabsBar"/);
    expect(css).toMatch(/\.connect-widget\.connect-widget-float\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/z-index:\s*var\(--z-connect-float\)/);
  });

  it('raises הטסה into the primary tab row', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/class="tab tab-fly"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(chrome.indexOf('data-tab="terrain"')).toBeLessThan(chrome.indexOf('data-tab="pulse"'));
    const menu = capture(html, /<div id="tabLabMenu"[^>]*>([\s\S]*?)<\/div>/, 'missing #tabLabMenu')[1];
    expect(menu).not.toMatch(/data-tab="terrain"/);
    expect(js).toMatch(/LAB_SHELF_TABS = new Set\(\['simLab', 'advisor', 'featureDesigner', 'flightEngineer'\]\)/);
    expect(js).not.toMatch(/LAB_SHELF_TABS = new Set\(\[[^\]]*terrain/);
  });
});

describe('AIRVIX Mission chrome — workspace regions', () => {
  it('folds horizon, map, data, messages, and talk as named regions', () => {
    expect(html).toMatch(/data-mission-layout="ops-v1"/);
    expect(html).toMatch(/data-mission-region="horizon"/);
    expect(html).toMatch(/data-mission-region="map"/);
    expect(html).toMatch(/data-mission-region="data"/);
    expect(html).toMatch(/data-mission-region="messages"/);
    expect(html).toMatch(/data-mission-region="talk"/);
    expect(html).toContain('id="flightHud"');
    expect(html).toContain('id="horizonCanvas"');
    expect(html).toContain('id="terrainMap"');
    expect(html).toContain('id="hudFlightMode"');
    expect(html).toContain('id="hudAltitude"');
    expect(html).toContain('id="hudAirspeed"');
    expect(html).toContain('id="missionLink"');
    expect(html).toContain('id="liveGpsVisionDelta"');
    expect(html).toContain('id="liveConfidenceText"');
    expect(html).toContain('id="pfdStatustextStrip"');
    expect(html).toContain('id="pfcMsgScroll"');
    expect(html).toContain('id="missionTalkForm"');
    expect(html).toMatch(/id="missionTalkHint"[^>]*>הטסה\. הערה ותצפית בלבד\.</);
    expect(css).toMatch(/data-mission-region="horizon\|map\|data\|messages\|talk"/);
    expect(css).toMatch(/grid-template-areas:/);
  });

  it('keeps empty GPS honest and does not invent a number', () => {
    expect(html).toMatch(/id="liveGpsVisionDelta"[^>]*>-- m</);
    expect(html).toMatch(/id="hudNavGpsVal">--</);
    expect(js).toContain('formatGpsVisionDeltaMeters');
  });
});

describe('AIRVIX Mission chrome — talk is flight-safe', () => {
  it('opens existing Assist notes and advisor without flight writes', () => {
    expect(js).toContain('function initMissionTalk(');
    expect(js).toContain("assistApplyQuickChip(btn.dataset.assistChip)");
    const talk = sliceFunction(js, 'initMissionTalk');
    const chip = sliceFunction(js, 'assistApplyQuickChip');
    expect(talk + chip).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(talk).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
    expect(chip).toContain("kind === 'ask'");
    expect(chip).toContain("kind === 'advisor'");
  });

  it('pins APP_VERSION at 1.02.255', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.255'");
    expect(pkg.version).toBe('1.02.255');
  });
});

describe('AIRVIX Mission chrome — default open + layout policy', () => {
  it('opens הטסה first and keeps בית as the Pulse tab name', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/class="tab tab-fly active"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(chrome).toMatch(/class="tab tab-ops"[^>]*data-tab="pulse"[^>]*>בית</);
    expect(chrome).not.toMatch(/class="tab tab-ops active"[^>]*data-tab="pulse"/);
    expect(html).toMatch(/<section id="terrain" class="panel visible"/);
    expect(html).toMatch(/<section id="pulse" class="panel"/);
    expect(html).not.toMatch(/<section id="pulse" class="panel visible"/);
    expect(js).toContain("function appDefaultWorkspaceTab(");
    expect(sliceFunction(js, 'appDefaultWorkspaceTab')).toContain("return 'terrain'");
    expect(sliceFunction(js, 'restoreLastUiTab')).toContain('applyMainTab(appDefaultWorkspaceTab(), { save: false })');
    expect(sliceFunction(js, 'pulseDefaultHomeTab')).toContain("pulseReadHomePref() === 'telemetry' ? 'telemetry' : 'pulse'");
  });

  it('allows mid-flight map↔horizon swap and resize only', () => {
    expect(html).toContain('id="missionSwapHorizonMapBtn"');
    expect(html).toContain('id="missionLayoutHint"');
    expect(html).toContain('id="missionColSplit"');
    expect(html).toContain('id="missionRowSplit"');
    expect(html).toMatch(/data-mission-swap="horizon-map"/);
    expect(html).toMatch(/data-mission-edit="off"/);
    expect(css).toMatch(/data-mission-swap="map-horizon"/);
    expect(css).toMatch(/--mission-c1/);
    expect(css).toMatch(/cursor:\s*col-resize/);
    expect(css).toMatch(/cursor:\s*row-resize/);
    expect(js).toContain('function resolveMissionLayoutPhase(');
    expect(js).toContain('function toggleMissionHorizonMapSwap(');
    expect(js).toContain('function syncMissionLayoutChrome(');
    expect(js).toContain('function initMissionLayout(');
    const phase = [
      'const MISSION_APPROACH_MODES = Object.freeze(["LAND", "QLAND"]);',
      'const ARDUPILOT_PLANE_MODES = { 10: "AUTO", 14: "LAND", 20: "QLAND" };',
      sliceFunction(js, 'missionModeName'),
      sliceFunction(js, 'missionApproachActive'),
      sliceFunction(js, 'resolveMissionLayoutPhase'),
      'return { resolveMissionLayoutPhase };',
    ].join('\n');
    const { resolveMissionLayoutPhase } = new Function(phase)();
    expect(resolveMissionLayoutPhase(null, null)).toBe('ground');
    expect(resolveMissionLayoutPhase({ armed: true, armedKnown: true, flightMode: 10 }, null)).toBe('flight');
    expect(resolveMissionLayoutPhase({ armed: true, armedKnown: true, flightMode: 14 }, null)).toBe('approach');
    expect(resolveMissionLayoutPhase({ armed: true, armedKnown: true, flightMode: 20 }, null)).toBe('approach');
    expect(resolveMissionLayoutPhase({ armed: true, armedKnown: true, flightMode: 10 }, { landing: { detected: true } })).toBe('approach');
    expect(resolveMissionLayoutPhase({ armed: false, armedKnown: true, flightMode: 10 }, null)).toBe('ground');
    expect(sliceFunction(js, 'toggleMissionHorizonMapSwap')).toContain("!== 'flight'");
    expect(sliceFunction(js, 'syncMissionLayoutChrome')).toContain('בגישה אין החלפה ואין סידור חופשי.');
    expect(sliceFunction(js, 'syncMissionLayoutChrome')).toContain('החלפה ושינוי גודל בטיסה בלבד.');
  });

  it('does not add free tiling or flight writes', () => {
    expect(html).not.toMatch(/data-mission-region="[^"]+"[^>]*\bdraggable=/);
    expect(js).not.toMatch(/mission-region[\s\S]{0,120}dragstart/);
    expect(js).not.toContain('free-tile');
    const layout = [
      sliceFunction(js, 'resolveMissionLayoutPhase'),
      sliceFunction(js, 'toggleMissionHorizonMapSwap'),
      sliceFunction(js, 'syncMissionLayoutChrome'),
      sliceFunction(js, 'bindMissionSplitters'),
      sliceFunction(js, 'initMissionLayout'),
    ].join('\n');
    expect(layout).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
    expect(layout).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});

describe('AIRVIX Mission chrome — operator naming', () => {
  it('uses locked בית for Pulse home and Jetson / מחשב משימה for the computer', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/data-tab="pulse"[^>]*>בית</);
    expect(chrome).not.toMatch(/>סקירה</);
    expect(chrome).not.toMatch(/>תמונת מצב</);
    expect(html).toMatch(/<h3 class="pulse-title">בית<\/h3>/);
    expect(html).toMatch(/id="pulseHomePulseBtn"[^>]*>בית</);
    expect(html).toMatch(/<dt>Jetson<\/dt>/);
    expect(html).toMatch(/data-first-action="companion">חברו Jetson</);
    expect(html).toMatch(/id="teleNextStep"[^>]*>חברו מחשב משימה\. כתובת לבד לא מספיקה\.</);
    expect(html).not.toContain('מלווה');
    expect(html).not.toContain('תמונת מצב');
    expect(html).not.toMatch(/>סקירה</);
    expect(html).not.toMatch(/>Companion</);
    expect(js).toMatch(/PULSE:\s*'בית'/);
    expect(js).toMatch(/companion:\s*'Jetson'/);
    expect(findAssistRoute('בית')?.tab).toBe('pulse');
    expect(findAssistRoute('תמונת מצב')?.tab).toBe('pulse');
    expect(findAssistRoute('סקירה')?.tab).toBe('pulse');
    expect(findAssistRoute('Jetson')?.id).toBe('companion');
    expect(findAssistRoute('מחשב משימה')?.id).toBe('companion');
    expect(findAssistRoute('Companion')?.id).toBe('companion');
    expect(findAssistRoute('מלווה')?.id).toBe('companion');
  });
});
