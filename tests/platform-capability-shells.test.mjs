import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { hebrewLookingAtAnswer } from '../lib/assist/assist-hebrew.mjs';

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

describe('C10.5b Platform capability shells', () => {
  it('adds one Hebrew Platform overview without deleting existing tabs', () => {
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="platform"[^>]*>פלטפורמה</);
    expect(tag('platform')).toMatch(/aria-label="פלטפורמה"/);
    expect(tag('platform')).not.toMatch(/\bvisible\b/);
    expect(tag('pulse')).toMatch(/\bvisible\b/);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="control"[^>]*>פרמטרים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="recordings"[^>]*>תחקור</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="telemetry"[^>]*>טלמטריה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="maintenance"[^>]*>תחזוקה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="development"[^>]*>פיתוח</);
    expect(html).toMatch(/id="tabLabToggle"[^>]*>מעבדה</);
    expect(html).toContain('id="platformCompanionStatus"');
    expect(html).toContain('id="platformMaintStatus"');
    expect(html).toMatch(/data-platform-go="companion"/);
    expect(html).toMatch(/data-platform-go="params"/);
    expect(html).toMatch(/data-platform-go="maintenance"/);
    expect(html).not.toContain('platform-lede');
    expect(html).not.toContain('מה שחשוב עכשיו בלבד');
    expect(css).toMatch(/#platform\.panel\.visible\b/);
    expect(css).toMatch(/\.platform-shells\b/);
  });

  it('navigates shells to existing Companion, Params, and Maintenance surfaces', () => {
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
      'const tabs = { platform: false, control: false, telemetry: false, maintenance: false };',
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
    expect(result.tabs).toEqual({
      platform: true,
      control: true,
      telemetry: true,
      maintenance: true,
    });
    expect(result.teleSub).toBe('dash');
    expect(result.focused).toBe(true);
    expect(sliceFunction(js, 'applyMainTab')).toMatch(/tabId === 'platform'/);
    expect(sliceFunction(js, 'initPlatformShell')).toMatch(/operatorOpenFirstAction\(go\.dataset\.platformGo\)/);
  });

  it('reuses Companion status labels and a one-line Maintenance readout', () => {
    const document = {
      getElementById(id) {
        if (id === 'maintStatusBadge') return { textContent: 'תקין' };
        return null;
      },
    };
    const src = [
      sliceFunction(js, 'pulseCompanionLabel'),
      sliceFunction(js, 'platformMaintLabel'),
      'return { companion: pulseCompanionLabel({ connected: false, mode: "off" }), mock: pulseCompanionLabel({ connected: false, mode: "mock" }), live: pulseCompanionLabel({ connected: true, mode: "real", token_hint: "••••ab12" }), maint: platformMaintLabel() };',
    ].join('\n');
    const result = new Function('document', src)(document);
    expect(result.companion).toBe('מנותק');
    expect(result.mock).toBe('מדומה');
    expect(result.live).toBe('מחובר ••••ab12');
    expect(result.maint).toBe('תקין');
    const platformJs = [
      sliceFunction(js, 'platformMaintLabel'),
      sliceFunction(js, 'platformRefresh'),
      sliceFunction(js, 'initPlatformShell'),
    ].join('\n');
    expect(platformJs).not.toMatch(/cpu_percent|ram_used|temperature_c|gpsLat|mockGps/i);
    expect(html).not.toMatch(/id="platform".*tele-card|id="platformCompanionStatus"[^>]*>\s*\d/);
  });

  it('keeps Assist chrome on the Platform shell and does not add write paths', () => {
    expect(findAssistRoute('פלטפורמה')?.tab).toBe('platform');
    expect(findAssistRoute('platform')?.tab).toBe('platform');
    expect(findAssistRoute('תחזוקה')?.tab).toBe('maintenance');
    expect(findAssistRoute('פרמטרים')?.tab).toBe('control');
    expect(hebrewLookingAtAnswer('PLATFORM', 'companion', 'platform')).toContain('מסך נוכחי: פלטפורמה.');
    const platformSrc = [
      sliceFunction(js, 'platformRefresh'),
      sliceFunction(js, 'initPlatformShell'),
      sliceFunction(js, 'operatorOpenFirstAction'),
    ].join('\n');
    expect(platformSrc).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="platform".*id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('pins APP_VERSION at 1.02.255', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.255'");
    expect(pkg.version).toBe('1.02.255');
  });
});
