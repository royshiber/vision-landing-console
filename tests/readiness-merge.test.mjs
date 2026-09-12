import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';

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

describe('Preflight / readiness MERGE — Mission glance + Diagnostics', () => {
  it('unifies operator Hebrew to מוכנות on Mission popover and diagnostics strip', () => {
    expect(html).toMatch(/id="missionReadinessGlance"[^>]*>מוכנות</);
    expect(html).toMatch(/id="pfdReadinessTitle"[^>]*>מוכנות</);
    expect(html).toMatch(/class="tele-preflight-title">מוכנות</);
    expect(html).not.toContain('בדיקות מערכת');
    expect(html).not.toContain('מוכנות טיסה');
    expect(html).toContain('id="preflightCard"');
    expect(html).toContain('id="pfdReadinessPopover"');
    expect(html).toContain('id="pfdArmedBadge"');
    expect(html).toMatch(/id="pfdVoiceFlightBtn"[^>]*>🎙 פקודות</);
    const liveIdx = html.indexOf('id="teleLiveSections"');
    const stripIdx = html.indexOf('id="readinessStrip"');
    expect(stripIdx).toBeGreaterThan(0);
    expect(liveIdx).toBeGreaterThan(stripIdx);
  });

  it('keeps a quiet Mission glance that opens the same popover and a diagnostics jump', () => {
    expect(css).toMatch(/\.mission-readiness-glance\b/);
    const chrome = sliceFunction(js, 'setupFlightHudChromeHandlers');
    expect(chrome).toMatch(/missionReadinessGlance/);
    expect(chrome).toMatch(/openPfdReadinessPopover/);
    expect(chrome).toMatch(/pfdArmedBadge/);
    expect(chrome).not.toMatch(/ARM the|DISARM|LAND|FLIGHT_ACTION/);
    const jump = sliceFunction(js, 'openDiagnosticsReadiness');
    expect(jump).toMatch(/applyMainTab\('telemetry'\)/);
    expect(jump).toMatch(/preflightCard|readinessStrip/);
    expect(html).toMatch(/id="pfdReadinessDiagBtn"[^>]*>רשימה באבחונים</);
  });

  it('keeps Mission מוכנות and does not ship a Sim Lab readiness bar', () => {
    expect(html).toContain('id="missionReadinessGlance"');
    expect(html).not.toContain('id="simLabPreflightBar"');
    expect(html).not.toContain('מוכנות סימולציה');
    expect(html).not.toContain('id="simLab"');
  });

  it('routes Assist מוכנות to Mission readiness and does not invent GPS or write paths', () => {
    const route = findAssistRoute('מוכנות');
    expect(route?.id).toBe('readiness');
    expect(route?.tab).toBe('terrain');
    expect(route?.workspace).toBe('MISSION');
    expect(findAssistRoute('readiness')?.id).toBe('readiness');
    expect(findAssistRoute('אבחונים')?.tab).toBe('telemetry');
    expect(findAssistRoute('הטסה')?.id).toBe('mission');
    expect(hebrewOpenRouteAnswer('readiness')).toBe('פותחים את המוכנות.');
    expect(resolveAssistIntent('מוכנות').slots.route_id).toBe('readiness');
    expect(resolveAssistIntent('פתח מוכנות').slots.route_id).toBe('readiness');
    expect(resolveAssistIntent('ARM the plane').prohibited).toBe(true);
    expect(resolveAssistIntent('land now').prohibited).toBe(true);
    const nav = sliceFunction(js, 'assistApplyNavigation');
    expect(nav).toMatch(/route_id === 'readiness'/);
    expect(nav).toMatch(/openPfdReadinessPopover/);
    const gps = js.slice(js.indexOf('// GPS — real MAVLink'), js.indexOf('document.getElementById(\'preflightRefreshBtn\')'));
    expect(gps).toMatch(/latestHudMavlink/);
    expect(gps).toMatch(/setRow\('gps', 'pending', '—'\)/);
    expect(gps).not.toMatch(/gpsSatsInput/);
    expect(gps).not.toMatch(/gpsLat|mockGps|הזן מספר לוויינים/i);
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });

  it('pins APP_VERSION at 1.02.281', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.281'");
    expect(pkg.version).toBe('1.02.281');
  });
});
