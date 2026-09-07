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
    expect(css).toMatch(/body:has\(#terrain\.panel\.visible\)\s*\{[^}]*background-color:\s*#070b12/);
  });

  it('raises הטסה into the primary tab row', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/class="tab tab-fly[^"]*"[^>]*data-tab="terrain"[^>]*>הטסה</);
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
    expect(html).toContain('id="missionTalkHost"');
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
    expect(sliceFunction(js, 'syncMissionLayoutChrome')).toContain('גררו כותרת אזור. שינוי גודל תמיד, גם בטיסה.');
    expect(js.slice(js.indexOf('function applyMainTab('), js.indexOf('const PARAM_SUBTAB_IDS'))).not.toMatch(/armed|airborne|inFlight/);
  });

  it('docks Assist as a full Mission panel, not a PFD overlay rail', () => {
    expect(html).toContain('id="missionTalkHost"');
    expect(html).toMatch(/data-mission-region="talk"[^>]*aria-label="מסייע"/);
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
      'const MISSION_AREAS_KEY = "visionLandingMissionAreasV1";',
      'const MISSION_SIZE_KEY = "visionLandingMissionSizeV1";',
      'const MISSION_SWAP_KEY = "visionLandingMissionSwapV1";',
      'const MISSION_REGION_IDS = Object.freeze(["horizon", "map", "data", "messages", "talk"]);',
      'let _missionSize = { c1: 1.15, c2: 1.45, c3: 0.92, r1: 1.55, r2: 0.88 };',
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
      'swapMissionRegions("horizon", "talk");',
      'const swapped = { horizon: regions.horizon.style.gridArea, talk: regions.talk.style.gridArea };',
      'resetMissionLayout();',
      'return { swapped, restored: { horizon: regions.horizon.style.gridArea, talk: regions.talk.style.gridArea } };',
    ].join('\n');
    const result = new Function('localStorage', 'document', 'regions', src)(localStorage, document, regions);
    expect(result.swapped).toEqual({ horizon: 'talk', talk: 'horizon' });
    expect(result.restored).toEqual({ horizon: 'horizon', talk: 'talk' });
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
