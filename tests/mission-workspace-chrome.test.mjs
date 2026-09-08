import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { ASSIST_PROHIBITED_ACTIONS, MISSION_AVAILABLE_ACTIONS } from '../lib/assist/assist-types.mjs';

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
    expect(css).toMatch(/\.app-chrome \.tab\s*\{[^}]*text-transform:\s*none/);
    expect(css).toMatch(/body:has\(#terrain\.panel\.visible\)\s*\{[^}]*background-color:\s*#0b0e14/);
    expect(css).toMatch(/#0b0e14/);
  });

  it('flushes Mission under tabs and brands chrome as AIRVIX', () => {
    expect(html).toMatch(/<title>AIRVIX v__APP_VERSION__<\/title>/);
    expect(html).toMatch(/class="app-chrome-brand"[^>]*>AIRVIX</);
    expect(html).not.toContain('Vision Landing Console');
    expect(js).toContain('document.title = `AIRVIX v${v}`');
    expect(css).toMatch(/body:has\(#terrain\.panel\.visible\) \.layout\s*\{[^}]*padding:\s*0/);
    expect(css).toMatch(/\.mission-ops-chrome\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.mission-ops-chrome\s*\{[^}]*min-height:\s*22px/);
    expect(css).toMatch(/\.mission-workspace\[data-mission-layout="ops-v1"\]\s*\{[^}]*gap:\s*4px/);
    expect(css).toMatch(/--mission-ah-col:\s*20%/);
    expect(css).toMatch(/--mission-map-min:\s*65%/);
    expect(css).toMatch(/--mission-msg-h:\s*40px/);
    expect(css).toMatch(/--mission-c3:\s*minmax\(240px, min\(28%, var\(--mission-talk-col\)\)\)/);
    expect(css).toMatch(/--mission-r1:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.mission-region\s*\{[^}]*border-radius:\s*4px/);
  });

  it('keeps the artificial horizon smaller than map and Assist by default', () => {
    expect(js).toContain('return { c1: 0.20, c2: 1.20, c3: 0.24, r1: 0.78, r2: 0.22, r3: 0.00 }');
    const size = new Function(`${sliceFunction(js, 'defaultMissionSize')}; return defaultMissionSize();`)();
    expect(size.c2).toBeGreaterThan(size.c1);
    expect(size.c1).toBeLessThanOrEqual(0.22);
    expect(size.r3).toBe(0);
    expect(css).toMatch(/minmax\(132px, min\(22%, var\(--mission-ah-col\)\)\)/);
    expect(css).toMatch(/minmax\(0, 1fr\)/);
    expect(css).toMatch(/minmax\(240px, min\(28%, var\(--mission-talk-col\)\)\)/);
    expect(css).toMatch(/\.mission-region-horizon \.pfd-horizon-shell\s*\{[^}]*aspect-ratio:\s*auto/);
    expect(css).toMatch(/\.pfd-horizon-instrument\s*\{[^}]*grid-template-columns:\s*46px minmax\(0, 1fr\) 46px/);
    expect(css).toMatch(/\.pfd-side-tape\s*\{[^}]*position:\s*static/);
  });

  it('keeps three primary Mission surfaces and quiets extra chrome', () => {
    expect(css).toMatch(/\.mission-identity,\s*\.mission-layout-hint,\s*\.mission-data-hint,\s*\.mission-talk-hint\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/);
    expect(css).toMatch(/#missionTalkHost \.assist-rail-head,\s*#missionTalkHost \.assist-rail-hint,\s*#missionTalkHost \.assist-context-chip\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.terrain-map-overlay-toolbar \.terrain-toolbar-label\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.mission-region-title\s*\{[^}]*position:\s*static/);
    expect(html).toMatch(/id="missionIdentity"[^>]*>הטסה · מרחב טיסה</);
    expect(html).toContain('id="missionSwapHorizonMapBtn"');
    expect(html).toContain('id="missionResetLayoutBtn"');
    expect(html).not.toContain('Vision Landing Console');
  });

  it('raises הטסה into the primary tab row and removes Lab chrome', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/class="tab tab-fly[^"]*"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(chrome.indexOf('data-tab="terrain"')).toBeLessThan(chrome.indexOf('data-tab="pulse"'));
    expect(chrome).not.toContain('tabLabMenu');
    expect(chrome).not.toContain('tabLabToggle');
    expect(chrome).not.toContain('מעבדה');
    expect(chrome).not.toMatch(/data-tab="simLab"/);
    expect(html).not.toContain('id="tabLabMenu"');
    expect(html).not.toContain('id="tabLabToggle"');
    expect(html).not.toContain('מעבדה');
    expect(html).not.toContain('id="simLab"');
    expect(html).not.toContain('sim-lab.mjs');
    expect(js).toMatch(/ASSIST_SHELF_PANELS = new Set\(\['advisor', 'featureDesigner', 'flightEngineer'\]\)/);
    expect(js).not.toMatch(/ASSIST_SHELF_PANELS = new Set\(\[[^\]]*simLab/);
    expect(findAssistRoute('מעבדה')).toBeNull();
    expect(findAssistRoute('סימולציה')).toBeNull();
    expect(findAssistRoute('sitl')).toBeNull();
    expect(findAssistRoute('lab')).toBeNull();
    expect(js).toContain('function isAssistShelfPanel(');
    expect(js).not.toContain('LAB_SHELF_TABS');
    expect(js).not.toContain('function initLabTabGroup(');
    expect(js).not.toContain('function syncLabTabGroup(');
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
    expect(html).toContain('id="missionTalkHost"');
    expect(html).toMatch(/id="missionTalkHint"[^>]*>הטסה\. הערה ותצפית בלבד\.</);
    expect(css).toMatch(/data-mission-region="horizon\|map\|data\|messages\|talk"/);
    expect(css).toMatch(/grid-template-areas:/);
  });

  it('keeps empty GPS honest and does not invent a number', () => {
    expect(html).toMatch(/id="liveGpsVisionDelta"[^>]*>--</);
    expect(html).toMatch(/class="mission-data-unit">m</);
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

  it('pins APP_VERSION at 1.02.266', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.266'");
    expect(pkg.version).toBe('1.02.266');
  });

  it('keeps a rectangular glass artificial horizon with video HUD mode', () => {
    expect(html).toContain('id="horizonCanvas"');
    const start = js.indexOf('function drawHorizon(');
    expect(start).toBeGreaterThanOrEqual(0);
    const draw = js.slice(start, start + 16000);
    expect(draw).toContain('#163e86');
    expect(draw).toContain('#8a5724');
    expect(draw).toContain('#3DFF6A');
    expect(draw).toContain('createLinearGradient');
    expect(draw).toContain("if (!videoMode)");
    expect(draw).toContain('ctx.rect(att.x, att.y, att.w, att.h)');
    expect(draw).toContain('drawVTape');
    expect(draw).toContain("value == null ? '--'");
    expect(draw).toContain("heading == null ? '--'");
    expect(draw).toContain('fillRect(cx - 4.5, cy - 4.5, 9, 9)');
    expect(draw).toContain('formatHudAngleLabel');
    expect(draw).not.toMatch(/FLIGHT_ACTION|PARAM_SET|\/apply|\/restart/);
  });

  it('toggles video under the artificial horizon and stays honest with no feed', () => {
    expect(html).toContain('id="horizonVideoEl"');
    expect(html).toContain('id="horizonVideoToggle"');
    expect(html).toMatch(/id="horizonVideoEmpty"[^>]*>אין וידאו</);
    expect(css).toMatch(/\.pfd-horizon-shell--video-active canvas\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/\.pfd-horizon-video-empty\s*\{/);
    expect(js).toContain('function setHorizonVideoActive(');
    expect(js).toContain('function syncHorizonVideoEmpty(');
    expect(js).toContain("HORIZON_VIDEO_URL_KEY = 'vlc.horizon.videoUrl'");
    expect(js).toContain("HORIZON_VIDEO_ON_KEY = 'vlc.horizon.videoOn'");
    const videoFns = [
      sliceFunction(js, 'horizonVideoHasPlayableSource'),
      sliceFunction(js, 'syncHorizonVideoEmpty'),
      sliceFunction(js, 'setHorizonVideoActive'),
      sliceFunction(js, 'initHorizonVideo'),
    ].join('\n');
    expect(videoFns).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
    expect(videoFns).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
    const store = {};
    const localStorage = {
      getItem(key) { return store[key] ?? null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const videoEl = {
      src: '',
      classList: { add() {}, remove() {} },
      play() { return Promise.resolve(); },
      removeAttribute() {},
    };
    const emptyEl = { classList: { hidden: true, toggle(_name, forceOff) { this.hidden = !!forceOff; } } };
    const toggleBtn = { classList: { toggle() {} } };
    const shell = { classList: { toggle() {} } };
    const document = {
      getElementById(id) {
        if (id === 'horizonVideoEl') return videoEl;
        if (id === 'horizonVideoEmpty') return emptyEl;
        if (id === 'horizonVideoToggle') return toggleBtn;
        return null;
      },
    };
    const src = [
      'const HORIZON_VIDEO_ON_KEY = "vlc.horizon.videoOn";',
      'let _horizonVideoMode = false;',
      'let _lastRoll = null;',
      'let _lastPitch = null;',
      'let _horizonTape = { airspeed: null, altitude: null, heading: null };',
      'function currentHorizonDrawOpts() { return { videoMode: _horizonVideoMode, ..._horizonTape }; }',
      'const pfdHorizonShell = shell;',
      'const horizonCanvas = null;',
      'function drawHorizon() {}',
      sliceFunction(js, 'horizonVideoHasPlayableSource'),
      sliceFunction(js, 'syncHorizonVideoEmpty'),
      sliceFunction(js, 'setHorizonVideoActive'),
      'setHorizonVideoActive(true, "");',
      'const emptyOn = emptyEl.classList.hidden;',
      'const onFlag = localStorage.getItem("vlc.horizon.videoOn");',
      'setHorizonVideoActive(false, "");',
      'return { emptyOn, onFlag, off: !_horizonVideoMode, emptyOff: emptyEl.classList.hidden };',
    ].join('\n');
    const result = new Function('localStorage', 'document', 'shell', 'emptyEl', src)(localStorage, document, shell, emptyEl);
    expect(result.emptyOn).toBe(false);
    expect(result.onFlag).toBe('1');
    expect(result.off).toBe(true);
    expect(result.emptyOff).toBe(true);
  });

  it('collapses Mission messages by default and persists expand in localStorage', () => {
    expect(html).toMatch(/data-mission-region="messages"[^>]*data-messages-expanded="0"/);
    expect(html).toContain('id="missionMessagesToggle"');
    expect(html).toMatch(/id="pfcMsgScroll" hidden/);
    expect(js).toContain('function readMissionMessagesExpanded(');
    expect(js).toContain('function writeMissionMessagesExpanded(');
    expect(js).toContain('function toggleMissionMessages(');
    expect(js).toContain('visionLandingMissionMessagesV1');
    const store = {};
    const localStorage = {
      getItem(key) { return store[key] ?? null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const region = { dataset: { messagesExpanded: '0' } };
    const scroll = { hidden: true };
    const toggle = { textContent: 'הרחב', setAttribute() {} };
    const document = {
      querySelector() { return region; },
      getElementById(id) { return id === 'pfcMsgScroll' ? scroll : toggle; },
    };
    const src = [
      'const MISSION_MESSAGES_KEY = "visionLandingMissionMessagesV1";',
      sliceFunction(js, 'missionLayoutStoreGet'),
      sliceFunction(js, 'missionLayoutStoreSet'),
      sliceFunction(js, 'readMissionMessagesExpanded'),
      sliceFunction(js, 'writeMissionMessagesExpanded'),
      sliceFunction(js, 'applyMissionMessagesExpanded'),
      sliceFunction(js, 'toggleMissionMessages'),
      'const before = readMissionMessagesExpanded();',
      'toggleMissionMessages();',
      'const after = readMissionMessagesExpanded();',
      'toggleMissionMessages();',
      'return { before, after, collapsedAgain: readMissionMessagesExpanded(), stored: localStorage.getItem("visionLandingMissionMessagesV1"), hidden: scroll.hidden };',
    ].join('\n');
    const result = new Function('localStorage', 'document', 'scroll', src)(localStorage, document, scroll);
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(result.collapsedAgain).toBe(false);
    expect(result.stored).toBe('0');
    expect(result.hidden).toBe(true);
  });

  it('restyles data tiles and persists a free-text picker choice', () => {
    expect(html).toContain('id="missionDataGrid"');
    expect(html).toContain('id="missionDataPicker"');
    expect(html).toContain('id="missionDataPickerInput"');
    expect(html).toContain('id="missionDataPickerChips"');
    expect(html).toContain('data-mission-data-slot="0"');
    expect(css).toMatch(/\.mission-data-tile\b/);
    expect(css).toMatch(/\.mission-data-picker\b/);
    expect(js).toContain('function suggestMissionDataFields(');
    expect(js).toContain('function readMissionDataSlots(');
    expect(js).toContain('visionLandingMissionDataSlotsV1');
    expect(js).toContain('const MISSION_DATA_CATALOG = Object.freeze([');
    expect(js).toContain('const DEFAULT_MISSION_DATA_SLOTS = Object.freeze([');
    expect(sliceFunction(js, 'suggestMissionDataFields')).not.toMatch(/FLIGHT_ACTION|PARAM_SET|\/apply|\/restart/);
    const catalogStart = js.indexOf('const MISSION_DATA_CATALOG = Object.freeze([');
    const defaultsStart = js.indexOf('const DEFAULT_MISSION_DATA_SLOTS = Object.freeze([');
    const catalog = js.slice(catalogStart, js.indexOf(']);', catalogStart) + 3);
    const defaults = js.slice(defaultsStart, js.indexOf(']);', defaultsStart) + 3);
    const suggest = new Function(`${catalog}; ${sliceFunction(js, 'suggestMissionDataFields')}; return suggestMissionDataFields;`)();
    const air = suggest('מהירות אוויר');
    expect(air.exact?.key).toBe('mavlink.airspeed');
    const bare = suggest('מהירות');
    expect(bare.chips.some((c) => c.key === 'mavlink.airspeed')).toBe(true);
    expect(bare.chips.some((c) => c.key === 'mavlink.groundspeed')).toBe(true);
    const store = {};
    const localStorage = {
      getItem(key) { return store[key] ?? null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const persist = [
      'const MISSION_DATA_SLOTS_KEY = "visionLandingMissionDataSlotsV1";',
      catalog,
      defaults,
      sliceFunction(js, 'missionLayoutStoreGet'),
      sliceFunction(js, 'missionLayoutStoreSet'),
      sliceFunction(js, 'defaultMissionDataSlots'),
      sliceFunction(js, 'readMissionDataSlots'),
      sliceFunction(js, 'writeMissionDataSlots'),
      'const slots = defaultMissionDataSlots();',
      'slots[2] = { key: "mavlink.groundspeed", label: "מהירות קרקעית", unit: "m/s" };',
      'writeMissionDataSlots(slots);',
      'return readMissionDataSlots()[2];',
    ].join('\n');
    const saved = new Function('localStorage', persist)(localStorage);
    expect(saved.key).toBe('mavlink.groundspeed');
  });

  it('brightens Mission Assist and shows an honest microphone control', () => {
    expect(html).toContain('id="assistMicBtn"');
    expect(html).toMatch(/id="assistMicBtn"[^>]*aria-label="שיחה עם AIRVIX Ask של הממשק\. לא פקודות טיסה\."/);
    expect(html).toMatch(/class="assist-mic-label">שיחה עם AIRVIX Ask</);
    expect(css).toMatch(/\.mission-region-talk\s*\{[^}]*background:\s*#0f141c/);
    expect(css).toMatch(/#missionTalkHost \.assist-rail-title\s*\{[^}]*color:\s*#e8edf6/);
    expect(css).toMatch(/\.assist-mic-btn\b/);
    expect(js).toContain('function initAssistMic(');
    const mic = sliceFunction(js, 'initAssistMic');
    const label = sliceFunction(js, 'assistMicTalkLabel');
    expect(mic).toContain('SpeechRecognition');
    expect(label).toContain('שיחה עם AIRVIX Ask אינה זמינה בדפדפן זה');
    expect(mic + label).not.toMatch(/FLIGHT_ACTION|PARAM_SET|\/apply|\/restart/);
    expect(mic + label).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});

describe('AIRVIX Mission chrome — default open + layout policy', () => {
  it('opens הטסה first and keeps סטטוס מחשבים as the Pulse tab name', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/class="tab tab-fly active"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(chrome).toMatch(/class="tab tab-ops"[^>]*data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(chrome).not.toMatch(/class="tab tab-ops active"[^>]*data-tab="pulse"/);
    expect(html).toMatch(/<section id="terrain" class="panel visible"/);
    expect(html).toMatch(/<section id="pulse" class="panel"/);
    expect(html).not.toMatch(/<section id="pulse" class="panel visible"/);
    expect(js).toContain("function appDefaultWorkspaceTab(");
    expect(sliceFunction(js, 'appDefaultWorkspaceTab')).toContain("return 'terrain'");
    expect(sliceFunction(js, 'restoreLastUiTab')).toContain('applyMainTab(appDefaultWorkspaceTab(), { save: false })');
    expect(sliceFunction(js, 'pulseDefaultHomeTab')).toContain("pulseReadHomePref() === 'telemetry' ? 'telemetry' : 'pulse'");
  });

  it('keeps Mission regions rearrangeable on the ground and in the air', () => {
    expect(html).toContain('id="missionSwapHorizonMapBtn"');
    expect(html).toContain('id="missionResetLayoutBtn"');
    expect(html).toContain('id="missionLayoutHint"');
    expect(html).toContain('id="missionColSplit"');
    expect(html).toContain('id="missionColSplitB"');
    expect(html).toContain('id="missionRowSplit"');
    expect(html).toMatch(/data-mission-swap="horizon-map"/);
    expect(html).toMatch(/data-mission-edit="on"/);
    expect(html).toMatch(/class="mission-region-title" draggable="true"/);
    expect(css).toMatch(/data-mission-swap="map-horizon"/);
    expect(css).toMatch(/--mission-c1/);
    expect(css).toMatch(/cursor:\s*col-resize/);
    expect(css).toMatch(/cursor:\s*row-resize/);
    expect(js).toContain('function swapMissionRegions(');
    expect(js).toContain('function resetMissionLayout(');
    expect(js).toContain('function toggleMissionHorizonMapSwap(');
    expect(js).toContain('function bindMissionRegionDrag(');
    expect(js).toContain('function initMissionLayout(');
    expect(sliceFunction(js, 'toggleMissionHorizonMapSwap')).not.toContain('flight');
    expect(sliceFunction(js, 'bindMissionSplitters')).not.toContain('flight');
    expect(sliceFunction(js, 'toggleMissionHorizonMapSwap')).toContain("swapMissionRegions('horizon', 'map')");
    expect(sliceFunction(js, 'syncMissionLayoutChrome')).toContain('גררו קצה לשינוי גודל. גררו כותרת להחלפה. גם בטיסה.');
    expect(html).toMatch(/id="missionLayoutHint"[^>]*>גררו קצה לשינוי גודל\. גררו כותרת להחלפה\. גם בטיסה\.</);
    expect(js.slice(js.indexOf('function applyMainTab('), js.indexOf('const PARAM_SUBTAB_IDS'))).not.toMatch(/armed|airborne|inFlight/);
  });

  it('docks Assist as a full Mission panel, not a PFD overlay rail', () => {
    expect(html).toContain('id="missionTalkHost"');
    expect(html).toMatch(/data-mission-region="talk"[^>]*aria-label="AIRVIX Ask"/);
    expect(html).toContain('id="assistRail"');
    expect(html).toContain('id="assistRailDock"');
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).not.toContain('assistToggleBtn');
    expect(html).toMatch(/<\/header>\s*<button type="button" id="assistToggleBtn" class="assist-toggle-btn assist-toggle-float"/);
    expect(css).toMatch(/assist-rail--mission/);
    expect(css).toMatch(/body\.mission-assist-docked/);
    expect(css).toMatch(/\.assist-toggle-btn\.assist-toggle-float\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/body\.mission-assist-docked \.assist-toggle-btn/);
    expect(css).toMatch(/#missionTalkHost \.assist-rail/);
    expect(css).toMatch(/body\.mission-assist-docked\.assist-open \.layout/);
    const missionRail = capture(
      css,
      /\.assist-rail\.assist-rail--mission\s*\{[^}]+\}/,
      'missing .assist-rail--mission block',
    )[0];
    expect(missionRail).toMatch(/position:\s*relative/);
    expect(missionRail).not.toMatch(/position:\s*fixed/);
    expect(missionRail).not.toMatch(/height:\s*100vh/);
    expect(js).toContain('function placeAssistSurface(');
    expect(js).toContain('function isMissionAssistDocked(');
    const place = sliceFunction(js, 'placeAssistSurface');
    expect(place).toContain("tabId === 'terrain'");
    expect(place).toContain('missionTalkHost');
    expect(place).toContain('host.appendChild(rail)');
    expect(place).toContain('assist-rail--mission');
    expect(place).toContain("document.body.classList.remove('assist-open')");
    expect(place).toContain('ASSIST_OPEN_KEY');
    expect(place).toContain('rail.hidden = !overlayOpen');
    const setOpen = sliceFunction(js, 'assistSetOpen');
    const dockedSlice = setOpen.slice(setOpen.indexOf('isMissionAssistDocked()'), setOpen.indexOf('rail.hidden = !open'));
    expect(dockedSlice).toContain("document.body.classList.remove('assist-open')");
    expect(dockedSlice).not.toContain('sessionStorage.setItem');
    expect(place).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
    expect(place).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
    expect(sliceFunction(js, 'assistSetOpen')).toContain('isMissionAssistDocked()');
    expect(js).toMatch(/function applyMainTab\([\s\S]*?placeAssistSurface\(tabId\)/);
  });

  it('does not add flight writes from layout or Assist chrome', () => {
    const layout = [
      sliceFunction(js, 'swapMissionRegions'),
      sliceFunction(js, 'resetMissionLayout'),
      sliceFunction(js, 'toggleMissionHorizonMapSwap'),
      sliceFunction(js, 'syncMissionLayoutChrome'),
      sliceFunction(js, 'bindMissionSplitters'),
      sliceFunction(js, 'placeAssistSurface'),
      sliceFunction(js, 'assistSetOpen'),
      sliceFunction(js, 'initMissionLayout'),
    ].join('\n');
    expect(layout).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
    expect(layout).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });

  it('swaps any two panes and reset restores the default map', () => {
    const store = {};
    const localStorage = {
      getItem(key) { return store[key] ?? null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const regions = {
      horizon: { dataset: { missionRegion: 'horizon' }, style: {} },
      map: { dataset: { missionRegion: 'map' }, style: {} },
      data: { dataset: { missionRegion: 'data' }, style: {} },
      messages: { dataset: { missionRegion: 'messages' }, style: {} },
      talk: { dataset: { missionRegion: 'talk' }, style: {} },
    };
    const document = {
      querySelector() { return null; },
      querySelectorAll() { return Object.values(regions); },
      getElementById() { return null; },
    };
    const src = [
      'const MISSION_AREAS_KEY = "visionLandingMissionAreasV2";',
      'const MISSION_SIZE_KEY = "visionLandingMissionSizeV4";',
      'const MISSION_SWAP_KEY = "visionLandingMissionSwapV1";',
      'const MISSION_REGION_IDS = Object.freeze(["horizon", "map", "data", "messages", "talk"]);',
      'let _missionSize = { c1: 0.20, c2: 1.20, c3: 0.24, r1: 0.78, r2: 0.22, r3: 0.00 };',
      'function requestAnimationFrame(fn) { fn(); }',
      sliceFunction(js, 'defaultMissionSize'),
      sliceFunction(js, 'defaultMissionAreas'),
      sliceFunction(js, 'missionLayoutStoreGet'),
      sliceFunction(js, 'missionLayoutStoreSet'),
      sliceFunction(js, 'readMissionAreas'),
      sliceFunction(js, 'writeMissionAreas'),
      sliceFunction(js, 'writeMissionSwap'),
      sliceFunction(js, 'writeMissionSize'),
      sliceFunction(js, 'applyMissionAreas').replace('requestAnimationFrame(placeMissionSplits);', ''),
      sliceFunction(js, 'applyMissionSize').replace('requestAnimationFrame(placeMissionSplits);', ''),
      sliceFunction(js, 'swapMissionRegions'),
      sliceFunction(js, 'resetMissionLayout').replace('syncMissionLayoutChrome();', ''),
      'swapMissionRegions("map", "talk");',
      'const swapped = { map: regions.map.style.gridArea, talk: regions.talk.style.gridArea };',
      'resetMissionLayout();',
      'return { swapped, restored: { map: regions.map.style.gridArea, talk: regions.talk.style.gridArea } };',
    ].join('\n');
    const result = new Function('localStorage', 'document', 'regions', src)(localStorage, document, regions);
    expect(result.swapped).toEqual({ map: 'talk', talk: 'map' });
    expect(result.restored).toEqual({ map: 'map', talk: 'talk' });
  });

  it('persists drag-resize sizes and reset restores defaults', () => {
    const store = {};
    const localStorage = {
      getItem(key) { return store[key] ?? null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const regions = {
      horizon: { dataset: { missionRegion: 'horizon' }, style: {} },
      map: { dataset: { missionRegion: 'map' }, style: {} },
      data: { dataset: { missionRegion: 'data' }, style: {} },
      messages: { dataset: { missionRegion: 'messages' }, style: {} },
      talk: { dataset: { missionRegion: 'talk' }, style: {} },
    };
    const document = {
      querySelector() { return { style: { setProperty() {} } }; },
      querySelectorAll() { return Object.values(regions); },
      getElementById() { return null; },
    };
    const src = [
      'const MISSION_AREAS_KEY = "visionLandingMissionAreasV2";',
      'const MISSION_SIZE_KEY = "visionLandingMissionSizeV4";',
      'const MISSION_SWAP_KEY = "visionLandingMissionSwapV1";',
      'const MISSION_REGION_IDS = Object.freeze(["horizon", "map", "data", "messages", "talk"]);',
      'let _missionSize = { c1: 0.20, c2: 1.20, c3: 0.24, r1: 0.78, r2: 0.22, r3: 0.00 };',
      'function requestAnimationFrame(fn) { fn(); }',
      sliceFunction(js, 'clampMissionFr'),
      sliceFunction(js, 'defaultMissionSize'),
      sliceFunction(js, 'defaultMissionAreas'),
      sliceFunction(js, 'missionLayoutStoreGet'),
      sliceFunction(js, 'missionLayoutStoreSet'),
      sliceFunction(js, 'readMissionSize'),
      sliceFunction(js, 'writeMissionSize'),
      sliceFunction(js, 'readMissionAreas'),
      sliceFunction(js, 'writeMissionAreas'),
      sliceFunction(js, 'writeMissionSwap'),
      sliceFunction(js, 'applyMissionAreas').replace('requestAnimationFrame(placeMissionSplits);', ''),
      sliceFunction(js, 'applyMissionSize').replace('requestAnimationFrame(placeMissionSplits);', ''),
      sliceFunction(js, 'resetMissionLayout').replace('syncMissionLayoutChrome();', ''),
      'writeMissionSize({ c1: 0.18, c2: 1.1, c3: 0.26, r1: 0.70, r2: 0.22, r3: 0.00 });',
      'const saved = JSON.parse(localStorage.getItem("visionLandingMissionSizeV4"));',
      'resetMissionLayout();',
      'return { saved, restored: JSON.parse(localStorage.getItem("visionLandingMissionSizeV4")), read: readMissionSize() };',
    ].join('\n');
    const result = new Function('localStorage', 'document', 'regions', src)(localStorage, document, regions);
    expect(result.saved).toEqual({ c1: 0.18, c2: 1.1, c3: 0.26, r1: 0.70, r2: 0.22, r3: 0.00 });
    expect(result.restored).toEqual({ c1: 0.20, c2: 1.20, c3: 0.24, r1: 0.78, r2: 0.22, r3: 0.00 });
    expect(result.read).toEqual({ c1: 0.20, c2: 1.20, c3: 0.24, r1: 0.78, r2: 0.22, r3: 0.00 });
  });
});

describe('AIRVIX Mission chrome — operator naming', () => {
  it('uses locked סטטוס מחשבים for Pulse home and Jetson / מחשב משימה for the computer', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(chrome).not.toMatch(/>סקירה</);
    expect(chrome).not.toMatch(/>תמונת מצב</);
    expect(html).toMatch(/<h3 class="pulse-title">סטטוס מחשבים<\/h3>/);
    expect(html).toMatch(/class="pulse-purpose">סטטוס מחשבים</);
    expect(html).toMatch(/id="pulseHomePulseBtn"[^>]*>סטטוס מחשבים</);
    expect(html).toMatch(/data-pulse-kind="aircraft"/);
    expect(html).toMatch(/<h4>מחשב משימה<\/h4>/);
    expect(html).toMatch(/class="pulse-computer-who">Jetson</);
    expect(html).toMatch(/<h4>הכלי<\/h4>/);
    expect(html).toMatch(/data-pulse-kind="assist"/);
    expect(html).toMatch(/id="pulseTalkBtn"[^>]*>שאלו את AIRVIX Ask</);
    expect(html).toMatch(/data-first-action="companion">חברו Jetson</);
    expect(html).toMatch(/id="teleNextStep"[^>]*>חברו מחשב משימה\. כתובת לבד לא מספיקה\.</);
    expect(html).not.toContain('מלווה');
    expect(html).not.toContain('תמונת מצב');
    expect(html).not.toMatch(/>סקירה</);
    expect(html).not.toMatch(/>Companion</);
    expect(js).toMatch(/PULSE:\s*'סטטוס מחשבים'/);
    expect(js).toMatch(/companion:\s*'Jetson'/);
    expect(findAssistRoute('בית')?.tab).toBe('pulse');
    expect(findAssistRoute('סטטוס מחשבים')?.tab).toBe('pulse');
    expect(findAssistRoute('תמונת מצב')?.tab).toBe('pulse');
    expect(findAssistRoute('סקירה')?.tab).toBe('pulse');
    expect(findAssistRoute('Jetson')?.id).toBe('companion');
    expect(findAssistRoute('מחשב משימה')?.id).toBe('companion');
    expect(findAssistRoute('Companion')?.id).toBe('companion');
    expect(findAssistRoute('מלווה')?.id).toBe('companion');
  });
});

describe('AIRVIX Mission chrome — no air/ground tab gate', () => {
  it('keeps Develop, Params, and Settings reachable airborne and on the ground', () => {
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="control"[^>]*>פרמטרים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="development"[^>]*>פיתוח</);
    expect(html).toContain('id="globalSettingsBtn"');
    expect(html).toContain('id="globalSettingsModal"');
    expect(html).not.toMatch(/data-tab="control"[^>]*\bdisabled\b/);
    expect(html).not.toMatch(/data-tab="development"[^>]*\bdisabled\b/);
    expect(html).not.toMatch(/id="globalSettingsBtn"[^>]*\bdisabled\b/);
    expect(js).toContain('function opsChromeAlwaysReachable(');
    expect(sliceFunction(js, 'opsChromeAlwaysReachable')).toContain('return true');
    expect(sliceFunction(js, 'opsChromeAlwaysReachable')).not.toMatch(/armed|airborne|inFlight|DISARMED/);
    const applyMain = js.slice(js.indexOf('function applyMainTab('), js.indexOf('const PARAM_SUBTAB_IDS'));
    expect(applyMain).toContain('opsChromeAlwaysReachable(tabId)');
    expect(applyMain).not.toMatch(/armed|airborne|inFlight|DISARMED/);
    expect(js).toContain("opsChromeAlwaysReachable('settings')");
    const reachable = new Function(`${sliceFunction(js, 'opsChromeAlwaysReachable')}; return opsChromeAlwaysReachable;`)();
    expect(reachable('control')).toBe(true);
    expect(reachable('development')).toBe(true);
    expect(reachable('settings')).toBe(true);
    expect(reachable('control', { armed: true, armedKnown: true })).toBe(true);
    expect(reachable('development', { armed: false, armedKnown: true })).toBe(true);
  });

  it('does not add Assist flight commands', () => {
    expect(MISSION_AVAILABLE_ACTIONS).not.toContain('FLIGHT_ACTION');
    expect(MISSION_AVAILABLE_ACTIONS).not.toContain('ARM');
    expect(MISSION_AVAILABLE_ACTIONS).not.toContain('DISARM');
    expect(MISSION_AVAILABLE_ACTIONS).not.toContain('LANDING_COMMAND');
    expect(ASSIST_PROHIBITED_ACTIONS).toEqual(expect.arrayContaining(['ARM', 'DISARM', 'LANDING_COMMAND', 'FC_COMMAND']));
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });
});
