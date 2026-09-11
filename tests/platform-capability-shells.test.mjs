import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { hebrewLookingAtAnswer, hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

describe('Platform tab removed — redirect to computer status', () => {
  it('drops the Platform tab and hub from primary chrome', () => {
    expect(html).not.toMatch(/data-tab="platform"/);
    expect(html).not.toMatch(/>פלטפורמה</);
    expect(html).not.toContain('id="platform"');
    expect(html).not.toContain('id="platformCompanionStatus"');
    expect(html).not.toContain('data-platform-go');
    expect(html).not.toContain('id="tabLabToggle"');
    expect(html).not.toContain('מעבדה');
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="control"[^>]*>פרמטרים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(html).toMatch(/data-tab="telemetry"[^>]*>אבחונים</);
    expect(html).not.toMatch(/data-tab="maintenance"/);
  });

  it('redirects leftover platform actions to Pulse / computer status', () => {
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
      'const tabs = { platform: false, pulse: false, control: false, telemetry: false, maintenance: false };',
      'let teleSub = null;',
      'let focused = false;',
      sliceFunction(js, 'operatorOpenFirstAction')
        .replaceAll(/applyMainTab\('([^']+)'\);/g, "tabs['$1'] = true;")
        .replace("applyTeleSubtab('dash');", "teleSub = 'dash';")
        .replace("document.getElementById('companionBaseUrl')?.focus();", 'focused = true;')
        .replace('assistSetOpen(true);', ''),
      'operatorOpenFirstAction("platform");',
      'operatorOpenFirstAction("params");',
      'operatorOpenFirstAction("companion");',
      'operatorOpenFirstAction("maintenance");',
      'return { tabs, teleSub, focused };',
    ].join('\n');
    const result = new Function('localStorage', 'document', src)(localStorage, document);
    expect(result.tabs.platform).toBe(false);
    expect(result.tabs.pulse).toBe(true);
    expect(result.tabs.control).toBe(true);
    expect(result.tabs.telemetry).toBe(true);
    expect(result.tabs.maintenance).toBe(false);
    expect(result.teleSub).toBe('dash');
    expect(result.focused).toBe(true);
    expect(sliceFunction(js, 'applyMainTab')).toMatch(/tabId === 'platform'/);
    expect(sliceFunction(js, 'applyMainTab')).toMatch(/applyMainTab\('pulse'/);
    expect(sliceFunction(js, 'restoreLastUiTab')).toMatch(/main === 'platform'/);
    expect(sliceFunction(js, 'applyMainTab')).toMatch(/tabId === 'maintenance'/);
    expect(sliceFunction(js, 'restoreLastUiTab')).toMatch(/main === 'maintenance'/);
  });

  it('routes Assist platform / פלטפורמה to computer status', () => {
    expect(findAssistRoute('פלטפורמה')?.tab).toBe('pulse');
    expect(findAssistRoute('platform')?.tab).toBe('pulse');
    expect(findAssistRoute('סטטוס מחשבים')?.tab).toBe('pulse');
    expect(findAssistRoute('תחזוקה')?.tab).toBe('pulse');
    expect(findAssistRoute('maintenance')?.tab).toBe('pulse');
    expect(findAssistRoute('Jetson')?.tab).toBe('pulse');
    expect(hebrewOpenRouteAnswer('companion')).toBe('פותחים סטטוס מחשבים.');
    expect(findAssistRoute('פרמטרים')?.tab).toBe('control');
    expect(hebrewOpenRouteAnswer('platform')).toBe('פותחים סטטוס מחשבים.');
    expect(hebrewLookingAtAnswer('PULSE', 'diagnostics', 'pulse')).toContain('מסך נוכחי: סטטוס מחשבים.');
    expect(hebrewLookingAtAnswer('PLATFORM', 'companion', 'platform')).toContain('מסך נוכחי: סטטוס מחשבים.');
  });

  it('does not add write paths or Lab chrome', () => {
    const src = [
      sliceFunction(js, 'operatorOpenFirstAction'),
      sliceFunction(js, 'applyMainTab'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(html).not.toContain('מעבדה');
  });

  it('pins APP_VERSION at 1.02.269', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.269'");
    expect(pkg.version).toBe('1.02.269');
  });
});
