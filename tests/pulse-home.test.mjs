import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

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

function tag(id) {
  const re = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`);
  const m = html.match(re);
  expect(m, `missing #${id}`).toBeTruthy();
  return m[0];
}

function loadPulseLogic() {
  const src = [
    sliceFunction(js, 'pulseIsPlaceholder'),
    sliceFunction(js, 'pulseCompanionLabel'),
    sliceFunction(js, 'pulseBuildAttention'),
    sliceFunction(js, 'pulseEvolveLine'),
    'return { pulseIsPlaceholder, pulseCompanionLabel, pulseBuildAttention, pulseEvolveLine };',
  ].join('\n');
  return new Function(src)();
}

describe('C10.3 Pulse home', () => {
  const pulse = loadPulseLogic();

  it('ships Pulse as the default Hebrew home without deleting existing tabs', () => {
    expect(html).toMatch(/data-tab="pulse"[^>]*>סקירה</);
    expect(tag('pulse')).toMatch(/\bvisible\b/);
    expect(tag('control')).not.toMatch(/\bvisible\b/);
    expect(html).toMatch(/data-tab="telemetry"[^>]*\btab-ops\b|class="tab tab-ops"[^>]*data-tab="telemetry"/);
    expect(html).toMatch(/data-tab="maintenance"/);
    expect(html).toMatch(/data-tab="development"/);
    expect(html).toMatch(/data-tab="control"/);
    expect(html).toMatch(/data-tab="simLab"/);
    expect(html).toMatch(/id="pulseVersion"[^>]*>--</);
    expect(html).toMatch(/id="pulseLink"[^>]*>--</);
    expect(html).toMatch(/id="pulseAircraft"[^>]*>--</);
    expect(html).toMatch(/data-first-action="companion"/);
    expect(html).toMatch(/data-first-action="assist"/);
    expect(html).toMatch(/data-first-action="params"/);
    expect(html).toMatch(/data-first-action="develop"/);
    expect(html).toMatch(/data-first-action="telemetry"/);
    expect(css).toMatch(/#pulse\.panel\.visible\b/);
    expect(css).toMatch(/\.pulse-attention\b/);
    expect(css).toMatch(/\.pulse-status\b/);
  });

  it('keeps link and aircraft as placeholders and never invents GPS', () => {
    expect(pulse.pulseIsPlaceholder('--')).toBe(true);
    expect(pulse.pulseIsPlaceholder('-- m')).toBe(true);
    expect(pulse.pulseIsPlaceholder('-- m/s')).toBe(true);
    expect(pulse.pulseIsPlaceholder('AUTO')).toBe(false);
    const pulseJs = [
      sliceFunction(js, 'pulseIsPlaceholder'),
      sliceFunction(js, 'pulseHudText'),
      sliceFunction(js, 'pulseCompanionLabel'),
      sliceFunction(js, 'pulseBuildAttention'),
      sliceFunction(js, 'pulseEvolveLine'),
      sliceFunction(js, 'pulseRefresh'),
    ].join('\n');
    expect(pulseJs).not.toMatch(/setView\s*\(/);
    expect(pulseJs).not.toMatch(/31\.5|34\.85/);
    expect(pulseJs).not.toMatch(/latitude|longitude|gpsLat|mockGps/i);
    expect(html).not.toMatch(/id="pulse(?:Link|Aircraft)"[^>]*>\s*\d/);
  });

  it('compresses Companion to disconnected or connected last-4 only', () => {
    expect(pulse.pulseCompanionLabel({ connected: false, mode: 'off' })).toBe('מנותק');
    expect(pulse.pulseCompanionLabel({ connected: true, mode: 'real', token_hint: '••••ab12' })).toBe('מחובר ••••ab12');
    expect(pulse.pulseCompanionLabel({ connected: true, mode: 'real' })).toBe('מחובר');
    expect(pulse.pulseCompanionLabel({ connected: false, mode: 'mock' })).toBe('מדומה');
  });

  it('builds at most three calm attention items and a one-line Evolve glance', () => {
    const disconnected = pulse.pulseBuildAttention({
      companionLive: false,
      assistConnected: false,
      evolveActive: false,
    });
    expect(disconnected).toHaveLength(3);
    expect(disconnected.map((item) => item.id)).toEqual(['companion', 'assist', 'evolve']);
    const quiet = pulse.pulseBuildAttention({
      companionLive: true,
      assistConnected: true,
      evolveActive: false,
    });
    expect(quiet).toEqual([]);
    expect(pulse.pulseEvolveLine({ hidden: true })).toBeNull();
    expect(pulse.pulseEvolveLine({ hidden: false, dataset: { kind: 'run' } })).toBe('משימה רצה');
    expect(pulse.pulseEvolveLine({ hidden: false, dataset: { kind: 'result' } })).toBe('משימה הסתיימה');
    expect(pulse.pulseEvolveLine({ hidden: false, dataset: { kind: 'unavailable' } })).toBeNull();
  });

  it('reuses first-open navigation and prefers Pulse home unless Telemetry is stored', () => {
    const store = {};
    const localStorage = {
      getItem(key) { return store[key] ?? null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const document = {
      getElementById() { return null; },
      querySelectorAll() { return []; },
    };
    const src = [
      'const PULSE_HOME_KEY = "visionLandingHomeSurfaceV1";',
      'const tabs = { pulse: false, control: false, development: false, telemetry: false };',
      'let openedAssist = false;',
      'let openedCompanion = false;',
      sliceFunction(js, 'pulseReadHomePref'),
      sliceFunction(js, 'pulseDefaultHomeTab'),
      sliceFunction(js, 'pulseWriteHomePref').replace('pulseSyncHomePrefChrome();', ''),
      sliceFunction(js, 'operatorOpenFirstAction')
        .replace('assistSetOpen(true);', 'openedAssist = true;')
        .replaceAll(/applyMainTab\('([^']+)'\);/g, "tabs['$1'] = true;")
        .replace("applyTeleSubtab('dash');", 'openedCompanion = true;'),
      'const first = pulseDefaultHomeTab();',
      'pulseWriteHomePref("telemetry");',
      'const telemetryHome = pulseDefaultHomeTab();',
      'pulseWriteHomePref("pulse");',
      'operatorOpenFirstAction("assist");',
      'operatorOpenFirstAction("params");',
      'operatorOpenFirstAction("develop");',
      'operatorOpenFirstAction("telemetry");',
      'operatorOpenFirstAction("companion");',
      'return { first, telemetryHome, restored: pulseDefaultHomeTab(), openedAssist, openedCompanion, tabs };',
    ].join('\n');
    const result = new Function('localStorage', 'document', src)(localStorage, document);
    expect(result.first).toBe('pulse');
    expect(result.telemetryHome).toBe('telemetry');
    expect(result.restored).toBe('pulse');
    expect(result.openedAssist).toBe(true);
    expect(result.openedCompanion).toBe(true);
    expect(result.tabs).toEqual({
      pulse: false,
      control: true,
      development: true,
      telemetry: true,
    });
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const pulseSrc = [
      sliceFunction(js, 'pulseCompanionLabel'),
      sliceFunction(js, 'pulseBuildAttention'),
      sliceFunction(js, 'pulseEvolveLine'),
      sliceFunction(js, 'pulseRefresh'),
      sliceFunction(js, 'operatorOpenFirstAction'),
      sliceFunction(js, 'initPulseHome'),
    ].join('\n');
    expect(pulseSrc).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="pulse".*id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(findAssistRoute('סקירה')?.tab).toBe('pulse');
    expect(findAssistRoute('pulse')?.tab).toBe('pulse');
  });
});
