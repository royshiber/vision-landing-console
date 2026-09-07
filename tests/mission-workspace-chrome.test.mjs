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

describe('AIRVIX Mission chrome — operator naming', () => {
  it('uses תמונת מצב for Pulse home and Companion as the product term', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/data-tab="pulse"[^>]*>תמונת מצב</);
    expect(chrome).not.toMatch(/>סקירה</);
    expect(html).toMatch(/<h3 class="pulse-title">תמונת מצב<\/h3>/);
    expect(html).toMatch(/id="pulseHomePulseBtn"[^>]*>תמונת מצב</);
    expect(html).toMatch(/<dt>Companion<\/dt>/);
    expect(html).toMatch(/data-first-action="companion">חברו Companion</);
    expect(html).not.toContain('מלווה');
    expect(html).not.toMatch(/>סקירה</);
    expect(js).toMatch(/PULSE:\s*'תמונת מצב'/);
    expect(js).toMatch(/companion:\s*'Companion'/);
    expect(findAssistRoute('תמונת מצב')?.tab).toBe('pulse');
    expect(findAssistRoute('סקירה')?.tab).toBe('pulse');
    expect(findAssistRoute('Companion')?.id).toBe('companion');
    expect(findAssistRoute('מלווה')?.id).toBe('companion');
  });
});
