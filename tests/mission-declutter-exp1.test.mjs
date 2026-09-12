import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ANNOTATED_VIDEO_REASON_HE,
  ANNOTATED_VIDEO_REASON_HE_MISSION,
} from '../lib/dual-link.mjs';
import {
  VISION_LANDING_READINESS_IDS,
  FLIGHT_COMMANDS_GATE,
  buildVisionLandingReadiness,
} from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

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

function missionOpsChrome(src) {
  const start = src.indexOf('class="mission-ops-chrome"');
  expect(start).toBeGreaterThan(0);
  return src.slice(start, src.indexOf('</div>', start) + 6);
}

describe('Mission chrome declutter for Experiment #1', () => {
  it('pins APP_VERSION at 1.02.294', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.294'");
    expect(pkg.version).toBe('1.02.294');
  });

  it('keeps one מוכנות glance and does not permanently show runway or lock chips', () => {
    const chrome = missionOpsChrome(html);
    expect(chrome).toMatch(/id="missionReadinessGlance"[^>]*>מוכנות</);
    expect(chrome).not.toContain('id="missionRunwayGlance"');
    expect(chrome).not.toContain('id="missionRunwayLockGlance"');
    expect(html).not.toContain('id="missionRunwayGlance"');
    expect(html).not.toContain('id="missionRunwayLockGlance"');
    expect(js).not.toMatch(/getElementById\('missionRunwayGlance'\)/);
    expect(js).not.toMatch(/getElementById\('missionRunwayLockGlance'\)/);
    const handlers = sliceFunction(js, 'setupFlightHudChromeHandlers');
    expect(handlers).toMatch(/missionReadinessGlance/);
    expect(handlers).not.toMatch(/missionRunwayGlance/);
    expect(handlers).not.toMatch(/missionRunwayLockGlance/);
  });

  it('hides annotated empty copy until ראייה opens and keeps Mission lines short', () => {
    expect(html).toMatch(/id="annotatedVisionToggle"[^>]*>ראייה</);
    expect(html).toMatch(/id="annotatedVisionPanel"[^>]*class="mission-annotated-vision hidden"/);
    expect(html).toMatch(/id="annotatedVisionPanel"[^>]*\bhidden\b/);
    expect(html).toMatch(/id="annotatedVisionEmpty"[^>]*>אין שידור\. מודם לא מחובר\.</);
    const missionSlice = html.slice(
      html.indexOf('id="annotatedVisionPanel"'),
      html.indexOf('id="annotatedVisionFrame"'),
    );
    expect(missionSlice).not.toContain(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    expect(missionSlice).toContain(ANNOTATED_VIDEO_REASON_HE_MISSION.modem_absent);
    expect(js).toContain('ANNOTATED_VISION_REASON_HE_MISSION');
    expect(js).toMatch(/annotatedVisionReasonHe\(\{ \.\.\.video, reason \}, \{ compact: true \}\)/);
    expect(css).toMatch(/\.mission-annotated-vision\[hidden\],\s*\.mission-annotated-vision\.hidden/);
  });

  it('keeps long modem_absent honesty in Connect advanced, not Mission default chrome', () => {
    expect(html).toContain('id="connectAdvanced"');
    expect(html).toMatch(/id="annotatedVideoConnectStatus"[^>]*>ראייה מסומנת · אין שידור\. מודם סלולר לא מחובר/);
    expect(html).toContain(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    expect(js).toContain(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    expect(js).toContain("getElementById('annotatedVideoConnectStatus')");
  });

  it('tightens the readiness popover and keeps short Exp#1 missingHe lines', () => {
    const render = sliceFunction(js, 'renderVisionLandingReadiness');
    expect(render).toMatch(/const compact = container\.id === 'pfdReadinessBody'/);
    expect(render).toMatch(/if \(!compact && Array\.isArray\(row\.keys\)/);
    expect(render).toMatch(/if \(!compact && Array\.isArray\(row\.tokens\)/);
    expect(render).not.toMatch(/snapshot\?\.purposeHe/);
    expect(css).toMatch(/\.pfd-readiness-body\s*\{[^}]*max-height:\s*32vh/);
    expect(css).toMatch(/\.pfd-readiness-popover\s*\{[^}]*max-width:\s*min\(280px/);
    const empty = buildVisionLandingReadiness({});
    expect(empty.rows.map((r) => r.id)).toEqual([...VISION_LANDING_READINESS_IDS]);
    expect(rowById(empty, 'runway_lock').missingHe.length).toBeLessThan(40);
    expect(rowById(empty, 'annotated_video').missingHe.length).toBeLessThan(50);
    expect(rowById(empty, 'annotated_video').missingHe).toMatch(/מודם סלולר לא מחובר/);
    expect(rowById(empty, 'plnd_profile').missingHe).toMatch(/לא חוסם את הניסוי/);
    expect(rowById(empty, 'flight_commands_gate').state).toBe(FLIGHT_COMMANDS_GATE);
    expect(empty.sendFlightCommands).toBe(false);
    expect(empty.annotatedVideo.reason).toBe('modem_absent');
    expect(empty.annotatedVideo.available).toBe(false);
  });

  it('does not remove dual-link, PLND honesty, or the flight-command gate', () => {
    expect(html).toContain('id="plndProfileHonesty"');
    expect(html).toContain('id="cellularLinkChip"');
    expect(html).toContain('id="radioLinkChip"');
    expect(js).toContain("fetch('/api/vision/landing-readiness'");
    expect(js).toContain("fetch('/api/links'");
    expect(js).not.toMatch(/FLIGHT_ACTION/);
    expect(sliceFunction(js, 'setupFlightHudChromeHandlers')).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});
