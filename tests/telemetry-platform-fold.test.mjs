import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { hebrewLookingAtAnswer, hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';

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

function tag(id) {
  const re = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`);
  const m = html.match(re);
  expect(m, `missing #${id}`).toBeTruthy();
  return m[0];
}

describe('Telemetry dash MERGE into Pulse + Platform diagnostics', () => {
  it('keeps #telemetry reachable after Platform tab removal', () => {
    expect(html).not.toContain('data-platform-go');
    expect(html).not.toContain('id="platformDiagStatus"');
    expect(tag('telemetry')).toBeTruthy();
    expect(html).toMatch(/<section id="telemetry"[\s\S]*?<h3>טלמטריה<\/h3>/);
    expect(html).toContain('id="teleLiveParked"');
    expect(html).toContain('id="companionConnect"');
    expect(html).toContain('id="companionB2Grid"');
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
      'const tabs = { telemetry: false, platform: false, pulse: false };',
      sliceFunction(js, 'operatorOpenFirstAction')
        .replaceAll(/applyMainTab\('([^']+)'\);/g, "tabs['$1'] = true;")
        .replace("applyTeleSubtab('dash');", '')
        .replace("document.getElementById('companionBaseUrl')?.focus();", '')
        .replace('assistSetOpen(true);', ''),
      'operatorOpenFirstAction("telemetry");',
      'operatorOpenFirstAction("platform");',
      'return tabs;',
    ].join('\n');
    const tabs = new Function('localStorage', 'document', src)(localStorage, document);
    expect(tabs.telemetry).toBe(true);
    expect(tabs.platform).toBe(false);
    expect(tabs.pulse).toBe(true);
  });

  it('quiets telemetry from primary ops chrome without cliff-deleting the panel', () => {
    expect(html).not.toMatch(/class="tab tab-ops"[^>]*data-tab="telemetry"/);
    expect(html).toMatch(/class="tab tab-quiet"[^>]*\bhidden\b[^>]*data-tab="telemetry"[^>]*>אבחונים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(html).not.toMatch(/data-tab="platform"/);
    expect(html).toContain('id="pulseCompanion"');
    expect(html).toContain('id="pulseLink"');
    expect(html).toContain('id="pulseAircraft"');
    expect(css).toMatch(/\.tab-quiet\[hidden\]/);
    expect(js).toMatch(/function applyMainTab\([\s\S]*?tabId === 'telemetry'/);
  });

  it('keeps Assist diagnostics on #telemetry and does not invent GPS or write paths', () => {
    expect(findAssistRoute('אבחונים')?.tab).toBe('telemetry');
    expect(findAssistRoute('טלמטריה')?.tab).toBe('telemetry');
    expect(findAssistRoute('אבחון')?.tab).toBe('telemetry');
    expect(findAssistRoute('diagnostics')?.tab).toBe('telemetry');
    expect(hebrewOpenRouteAnswer('diagnostics')).toBe('פותחים את הטלמטריה והאבחון.');
    expect(hebrewLookingAtAnswer('PLATFORM', 'diagnostics', 'telemetry')).toContain('מסך נוכחי: טלמטריה.');
    const fold = sliceFunction(js, 'operatorOpenFirstAction');
    expect(fold).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|FLIGHT_ACTION|JETSON_COMPANION|CURSOR_API_KEY|gpsLat|mockGps/i);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(html).toContain('id="companionB2Grid"');
  });

  it('pins APP_VERSION at 1.02.262', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.262'");
    expect(pkg.version).toBe('1.02.262');
  });
});
