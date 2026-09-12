import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  EXPERIMENT_PURPOSE_HE,
  EXPERIMENT_SUCCESS_HE,
  VISION_LANDING_READINESS_IDS,
} from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const EMPTY_NOTE = 'אין חיבור לבקר. אין הודעות נכנסות.';

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function makeFillerDom() {
  const note = { textContent: EMPTY_NOTE };
  const filler = {
    dataset: {},
    classList: {
      live: false,
      toggle(name, on) {
        if (name === 'mission-horizon-filler--live') this.live = !!on;
      },
    },
  };
  const document = {
    querySelector(sel) {
      if (sel === '.mission-horizon-filler-note') return note;
      if (sel === '.mission-horizon-filler') return filler;
      return null;
    },
  };
  return { document, note, filler };
}

function loadNoteFns(document) {
  const src = [
    sliceFunction(js, 'isHudMavlinkLive'),
    sliceFunction(js, 'syncMissionFcEmptyNote'),
    'return { isHudMavlinkLive, syncMissionFcEmptyNote };',
  ].join('\n');
  return new Function('document', src)(document);
}

function makeHost(id) {
  const host = {
    id: id || '',
    className: '',
    children: [],
    dataset: {},
    textContent: '',
    get innerHTML() {
      return this.children.map((c) => c.textContent || '').join('');
    },
    set innerHTML(value) {
      if (value === '') this.children = [];
    },
    appendChild(node) {
      this.children.push(node);
    },
    append(...nodes) {
      nodes.forEach((n) => this.appendChild(n));
    },
  };
  return host;
}

function loadRender() {
  const src = [
    sliceFunction(js, 'renderVisionLandingReadiness'),
    'return { renderVisionLandingReadiness };',
  ].join('\n');
  const document = {
    createElement(tag) {
      const node = {
        tagName: String(tag).toUpperCase(),
        className: '',
        dataset: {},
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); },
        append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
        setAttribute() {},
      };
      return node;
    },
  };
  return new Function('document', src)(document);
}

describe('Mission FC empty-note honesty', () => {
  it('pins APP_VERSION at 1.02.285', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.285'");
    expect(pkg.version).toBe('1.02.285');
  });

  it('treats connected, heartbeat, or listening attitude as live', () => {
    const { isHudMavlinkLive } = loadNoteFns({ querySelector() { return null; } });
    expect(isHudMavlinkLive(null)).toBe(false);
    expect(isHudMavlinkLive({ connected: false, heartbeatCount: 0 })).toBe(false);
    expect(isHudMavlinkLive({ connected: true })).toBe(true);
    expect(isHudMavlinkLive({ connected: false, heartbeatCount: 4 })).toBe(true);
    expect(isHudMavlinkLive({
      connected: false,
      listening: true,
      rollDeg: 1.2,
      pitchDeg: -0.4,
    })).toBe(true);
    expect(isHudMavlinkLive({
      connected: false,
      listening: true,
      rollDeg: null,
      pitchDeg: null,
    })).toBe(false);
  });

  it('replaces the HTML empty-connection sentence when a live mavlink snapshot arrives', () => {
    const connected = makeFillerDom();
    const connectedFns = loadNoteFns(connected.document);
    connectedFns.syncMissionFcEmptyNote({
      connected: true,
      heartbeatCount: 18,
      autopilotName: 'ArduPilot',
      vehicleType: 'Fixed Wing',
      rollDeg: 2.1,
      pitchDeg: -1.4,
    });
    expect(connected.note.textContent).toBe('מחובר · ArduPilot · Fixed Wing');
    expect(connected.note.textContent).not.toBe(EMPTY_NOTE);
    expect(connected.filler.dataset.state).toBe('live');
    expect(connected.filler.classList.live).toBe(true);

    const heartbeat = makeFillerDom();
    const heartbeatFns = loadNoteFns(heartbeat.document);
    heartbeatFns.syncMissionFcEmptyNote({
      connected: false,
      heartbeatCount: 3,
      autopilotName: 'ArduPilot',
    });
    expect(heartbeat.note.textContent).toMatch(/^מחובר · /);
    expect(heartbeat.note.textContent).not.toContain('אין חיבור לבקר');

    const attitude = makeFillerDom();
    const attitudeFns = loadNoteFns(attitude.document);
    attitudeFns.syncMissionFcEmptyNote({
      connected: false,
      listening: true,
      rollDeg: 0,
      pitchDeg: 0,
    });
    expect(attitude.note.textContent).toBe('מחובר · בקר טיסה');
    expect(attitude.note.textContent).not.toBe(EMPTY_NOTE);

    const dead = makeFillerDom();
    dead.note.textContent = 'מחובר · ArduPilot';
    const deadFns = loadNoteFns(dead.document);
    deadFns.syncMissionFcEmptyNote({ connected: false, heartbeatCount: 0 });
    expect(dead.note.textContent).toBe(EMPTY_NOTE);
    expect(dead.filler.dataset.state).toBe('empty');
  });

  it('keeps applyFlightHud as an owner of the filler note', () => {
    const hud = sliceFunction(js, 'applyFlightHud');
    expect(hud).toMatch(/syncMissionFcEmptyNote\(null\)/);
    expect(hud).toMatch(/syncMissionFcEmptyNote\(mav\)/);
    expect(sliceFunction(js, 'applyFcStatustextHud')).toMatch(/syncMissionFcEmptyNote\(mavlink\)/);
    expect(css).toMatch(/\.mission-horizon-filler\[data-state="live"\] \.mission-horizon-filler-note/);
    expect(html).toContain(EMPTY_NOTE);
  });
});

describe('Vision Landing Exp#1 readiness popover', () => {
  it('renders purpose, success, and Exp#1 rows into the Mission popover host', () => {
    const { renderVisionLandingReadiness } = loadRender();
    const host = makeHost('pfdReadinessBody');
    const snapshot = {
      ok: true,
      purposeHe: EXPERIMENT_PURPOSE_HE,
      successHe: EXPERIMENT_SUCCESS_HE,
      rows: VISION_LANDING_READINESS_IDS.map((id) => ({
        id,
        nameHe: id === 'runway_detect' ? 'זיהוי מסלול' : id,
        stateHe: id === 'fc_heartbeat' ? 'יש דופק' : 'לא ידוע',
        state: id === 'fc_heartbeat' ? 'heartbeat' : 'unknown',
        tone: id === 'fc_heartbeat' ? 'ok' : 'off',
        missingHe: '',
        successCriterion: id === 'runway_detect',
      })),
    };
    renderVisionLandingReadiness(host, snapshot);
    const classes = host.children.map((c) => c.className);
    expect(classes).toContain('vlr-purpose');
    expect(classes).toContain('vlr-success');
    expect(host.children.find((c) => c.className === 'vlr-purpose').textContent).toBe(EXPERIMENT_PURPOSE_HE);
    expect(host.children.find((c) => c.className === 'vlr-success').textContent).toBe(EXPERIMENT_SUCCESS_HE);
    const rows = host.children.filter((c) => c.className === 'vlr-row');
    expect(rows.map((r) => r.dataset.id)).toEqual([...VISION_LANDING_READINESS_IDS]);
    expect(rows.find((r) => r.dataset.id === 'runway_detect').dataset.success).toBe('true');
    expect(host.innerHTML).not.toMatch(/PreArm|DISARM/);
  });

  it('lets refresh + render own the popover body and keeps Status #visionLandingReadiness visible', () => {
    expect(js).toContain('function refreshVisionLandingReadiness');
    expect(js).toContain('function renderVisionLandingReadiness');
    expect(js).toContain("fetch('/api/vision/landing-readiness'");
    expect(sliceFunction(js, 'paintVisionLandingReadiness')).toMatch(
      /renderVisionLandingReadiness\(pfdReadinessBody,\s*snapshot\)/,
    );
    expect(sliceFunction(js, 'paintVisionLandingReadiness')).not.toMatch(/popoverOpen/);
    const builder = sliceFunction(js, 'buildReadinessListHtml');
    expect(builder).toMatch(/renderVisionLandingReadiness\(pfdReadinessBody,\s*latestVisionLandingReadiness\)/);
    expect(builder).toMatch(/refreshVisionLandingReadiness\(\)/);
    expect(builder).not.toMatch(/PreArm|DISARM|ARMED|checklistList/);
    expect(html).toContain('id="pfdReadinessBody"');
    expect(html).toContain('id="visionLandingReadiness"');
    expect(html.indexOf('id="visionLandingReadiness"')).toBeGreaterThan(html.indexOf('data-computer="fc"'));
    expect(html.indexOf('id="visionLandingReadiness"')).toBeLessThan(html.indexOf('pulse-talk-card'));
    expect(css).toMatch(/#pulse\.panel\.visible #visionLandingReadiness/);
    expect(css).toMatch(/#visionLandingReadiness\.vlr-panel/);
  });
});
