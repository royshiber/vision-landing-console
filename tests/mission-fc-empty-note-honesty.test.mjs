import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

const EMPTY_NOTE = 'אין חיבור לבקר. אין הודעות נכנסות.';
const EMPTY_PRIMARY = 'אין חיבור לבקר — לא מתקבלות הודעות MAVLink.';
const RELAY_HINT = 'דופק חי בבקר. ממסר הטלמטריה לא נפתח.';

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

function liveFcSnapshot(overrides = {}) {
  return {
    connected: true,
    listening: true,
    heartbeatCount: 18,
    armed: false,
    armedKnown: true,
    autopilotName: 'ArduPilot',
    vehicleType: 'Fixed Wing',
    flightMode: 0,
    airspeed: null,
    altitude: null,
    heading: 240,
    rollDeg: 0.4,
    pitchDeg: -22.7,
    batteryV: null,
    gpsFixType: null,
    gpsSats: null,
    recentStatusTexts: [{ severity: 6, text: 'AHRS: waiting for GPS', receivedAt: '2026-09-12T07:00:00.000Z' }],
    ...overrides,
  };
}

function disconnectedSnapshot(overrides = {}) {
  return {
    connected: false,
    listening: false,
    heartbeatCount: 0,
    armed: null,
    armedKnown: false,
    autopilotName: null,
    vehicleType: null,
    flightMode: null,
    rollDeg: null,
    pitchDeg: null,
    recentStatusTexts: [],
    ...overrides,
  };
}

function loadHonestyUi() {
  const note = { textContent: EMPTY_NOTE };
  const pfc = { textContent: EMPTY_PRIMARY };
  const pfcScroll = { innerHTML: '' };
  const armed = { textContent: '', className: '', title: '' };
  const mode = { textContent: '' };
  const src = [
    `const MISSION_FC_EMPTY_PRIMARY_HE = ${JSON.stringify(EMPTY_PRIMARY)};`,
    `const MISSION_FC_EMPTY_NOTE_HE = ${JSON.stringify(EMPTY_NOTE)};`,
    `const MISSION_FC_RELAY_HINT_HE = ${JSON.stringify(RELAY_HINT)};`,
    'const GPS_FIX_LABELS = [];',
    "const ARDUPILOT_PLANE_MODES = { 0: 'MANUAL' };",
    "const VLC_TOOLTIP_IAS_FROM_GS = '';",
    "const VLC_TOOLTIP_HUD_TIME_SKEW = '';",
    "const VLC_TOOLTIP_ALT_WAITING = 'אין גובה מהבקר עדיין';",
    sliceFunction(js, 'altitudeIsFinite'),
    sliceFunction(js, 'altitudeTileHonestyTitle'),
    'let latestHudMavlink = null;',
    'let latestLiveRadioStatus = null;',
    'let latestCompanionFromServer = null;',
    'let _lastRoll = null;',
    'let _lastPitch = null;',
    'let _horizonTape = { airspeed: null, altitude: null, heading: null };',
    "let _statustextSig = '';",
    'let _statustextTimer = null;',
    'let _assistLastMav = null;',
    'const document = { querySelector(sel) { return sel === ".mission-horizon-filler-note" ? note : null; } };',
    'const pfcMsgPrimaryHe = pfc;',
    'const pfcMsgScroll = pfcScroll;',
    'const pfdArmedBadge = armed;',
    'const pfdModeVal = mode;',
    'const horizonCanvas = null;',
    'const pfdHdgVal = null;',
    'const pfdHdgArrow = null;',
    'const pfdAirspeedVal = null;',
    'const pfdHorizonShell = null;',
    'const pfdAltVal = null;',
    'const pfdBattVal = null;',
    'const hudNavGpsPill = null;',
    'const hudNavGpsVal = null;',
    'const hudAirspeedEl = null;',
    'const hudAltitudeEl = null;',
    'const hudFlightModeEl = null;',
    'function syncMissionLayoutChrome() {}',
    'function drawHorizon() {}',
    'function currentHorizonDrawOpts() { return {}; }',
    'function finiteHorizonTape(n) { return typeof n === "number" && Number.isFinite(n) ? n : null; }',
    'function pulseRefresh() {}',
    'function translateAndRenderFcStatustext() {}',
    sliceFunction(js, 'finiteHudAngleDeg'),
    sliceFunction(js, 'isHudMavlinkLive'),
    sliceFunction(js, 'companionReportsFcHeartbeat'),
    sliceFunction(js, 'missionFcEmptyPrimaryHe'),
    sliceFunction(js, 'missionFcEmptyNoteHe'),
    sliceFunction(js, 'liveStatusToHudMavlink'),
    sliceFunction(js, 'resolveHudMavlink'),
    sliceFunction(js, 'rememberLiveRadioStatus'),
    sliceFunction(js, 'hudReflectsLiveFc'),
    sliceFunction(js, 'resolveLiveHudMavlinkForNote'),
    sliceFunction(js, 'syncMissionFcEmptyNote'),
    sliceFunction(js, 'applyFlightHud'),
    sliceFunction(js, 'applyFcStatustextHud'),
    sliceFunction(js, 'applyTopbarFlightData'),
    sliceFunction(js, 'applySseMissionHud'),
    sliceFunction(js, 'hydrateMissionHudFromLiveLink'),
    `return {
      note, pfc, armed, mode,
      isHudMavlinkLive, hudReflectsLiveFc,
      syncMissionFcEmptyNote, applyFlightHud, applyFcStatustextHud,
      applySseMissionHud, hydrateMissionHudFromLiveLink,
      rememberLiveRadioStatus, resolveHudMavlink,
      get latestHudMavlink() { return latestHudMavlink; },
      get lastRoll() { return _lastRoll; },
      get lastPitch() { return _lastPitch; },
      setCompanion(c) { latestCompanionFromServer = c; },
    };`,
  ].join('\n');
  return new Function('note', 'pfc', 'pfcScroll', 'armed', 'mode', src)(note, pfc, pfcScroll, armed, mode);
}

function expectNoteNotEmptyDefault(ui) {
  expect(ui.note.textContent).not.toBe(EMPTY_NOTE);
  expect(ui.note.textContent).not.toMatch(/אין חיבור לבקר/);
}

describe('Mission FC empty-note honesty', () => {
  it('live connected attitude replaces the HTML empty-default note', () => {
    const ui = loadHonestyUi();
    expect(ui.note.textContent).toBe(EMPTY_NOTE);
    ui.applyFlightHud(liveFcSnapshot());
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    expect(ui.armed.textContent).toBe('DISARMED');
    expect(ui.mode.textContent).toBe('MANUAL');
    expect(ui.lastRoll).toBeCloseTo(0.4);
    expect(ui.lastPitch).toBeCloseTo(-22.7);
  });

  it('finite roll/pitch alone is HUD-live so the note is not אין חיבור לבקר', () => {
    const ui = loadHonestyUi();
    ui.applyFlightHud({
      connected: false,
      listening: false,
      heartbeatCount: 0,
      rollDeg: 4.2,
      pitchDeg: -1.1,
      autopilotName: null,
      vehicleType: null,
    });
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר לבקר.');
  });

  it('applyFlightHud(null) after a live paint must not regress the note or wipe retained HUD', () => {
    const ui = loadHonestyUi();
    ui.applyFlightHud(liveFcSnapshot());
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    const roll = ui.lastRoll;
    const pitch = ui.lastPitch;
    ui.applyFlightHud(null);
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    expect(ui.latestHudMavlink).toBeTruthy();
    expect(ui.isHudMavlinkLive(ui.latestHudMavlink)).toBe(true);
    expect(ui.lastRoll).toBe(roll);
    expect(ui.lastPitch).toBe(pitch);
    expect(ui.armed.textContent).toBe('DISARMED');
    expect(ui.mode.textContent).toBe('MANUAL');
  });

  it('applyFcStatustextHud(null / non-live) must not regress a previously-live note', () => {
    const ui = loadHonestyUi();
    ui.applyFlightHud(liveFcSnapshot());
    ui.applyFcStatustextHud(null);
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    ui.applyFcStatustextHud(disconnectedSnapshot());
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    expect(ui.lastRoll).toBeCloseTo(0.4);
    expect(ui.lastPitch).toBeCloseTo(-22.7);
  });

  it('SSE payload missing mavlink after a live tick keeps the connected note', () => {
    const ui = loadHonestyUi();
    ui.applySseMissionHud({ mavlink: liveFcSnapshot() });
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    ui.applySseMissionHud({});
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    ui.applySseMissionHud({ mavlink: null });
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    expect(ui.lastRoll).toBeCloseTo(0.4);
    expect(ui.armed.textContent).toBe('DISARMED');
  });

  it('hydrate after rememberLiveRadioStatus(null) does not reset a live note', () => {
    const ui = loadHonestyUi();
    ui.applyFlightHud(liveFcSnapshot());
    ui.rememberLiveRadioStatus(null);
    ui.hydrateMissionHudFromLiveLink();
    expectNoteNotEmptyDefault(ui);
    expect(ui.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
  });

  it('true disconnect still writes honest empty copy, including ממסר hint', () => {
    const ui = loadHonestyUi();
    ui.applyFlightHud(liveFcSnapshot());
    ui.applyFlightHud(disconnectedSnapshot());
    expect(ui.note.textContent).toBe(EMPTY_NOTE);
    expect(ui.lastRoll).toBeNull();
    expect(ui.lastPitch).toBeNull();
    ui.setCompanion({ fc_heartbeat: true });
    ui.syncMissionFcEmptyNote(null);
    expect(ui.note.textContent).toBe(RELAY_HINT);
  });

  it('source contract: missing snapshot is not treated as disconnect', () => {
    const hud = sliceFunction(js, 'applyFlightHud');
    expect(hud).not.toMatch(/latestHudMavlink = null/);
    expect(hud).toMatch(/syncMissionFcEmptyNote\(latestHudMavlink\)/);
    const statustext = sliceFunction(js, 'applyFcStatustextHud');
    expect(statustext).toMatch(/hudReflectsLiveFc/);
    const resolve = sliceFunction(js, 'resolveHudMavlink');
    expect(resolve).toMatch(/latestHudMavlink/);
  });
});
