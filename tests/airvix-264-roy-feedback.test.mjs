import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');
const assistHe = fs.readFileSync(path.join(repoRoot, 'lib', 'assist', 'assist-hebrew.mjs'), 'utf8');

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

function cssBlock(src, selector) {
  const start = src.indexOf(selector);
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed selector ${selector}`);
}

describe('AIRVIX 1.02.264 Ask rename + premium horizon', () => {
  it('pins APP_VERSION at 1.02.270', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.270'");
    expect(pkg.version).toBe('1.02.270');
  });

  it('fails if מסייע appears in public UI sources', () => {
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(css.includes('מסייע')).toBe(false);
    expect(commercial.includes('מסייע')).toBe(false);
    expect(assistHe.includes('מסייע')).toBe(false);
  });

  it('labels every operator surface AIRVIX Ask', () => {
    expect(html).toMatch(/class="assist-rail-title">AIRVIX Ask</);
    expect(html).toMatch(/class="assist-toggle-he">AIRVIX Ask</);
    expect(html).toMatch(/data-mission-region="talk"[^>]*aria-label="AIRVIX Ask"/);
    expect(html).toMatch(/class="mission-region-title" draggable="true">AIRVIX Ask</);
    expect(html).toMatch(/id="pulseTalkBtn"[^>]*>שאלו את AIRVIX Ask</);
    expect(html).toMatch(/id="assistEmptyInvite"[^>]*>שאלו את AIRVIX Ask\.</);
    expect(html).toMatch(/id="assistMicBtn"[^>]*title="שיחה עם AIRVIX Ask של הממשק\. לא פקודות טיסה\."/);
    expect(html).toMatch(/class="assist-mic-label">שיחה עם AIRVIX Ask</);
    expect(html).toMatch(/נקודה ב-AIRVIX Ask/);
    expect(js).toContain("ASSIST_DEFAULT_INVITE_HE = 'שאלו את AIRVIX Ask.'");
    expect(js).toContain("ASSIST_MISSION_INVITE_HE = 'שאלו את AIRVIX Ask, רשמו הערה, או תצפית.'");
    const mic = sliceFunction(js, 'assistMicTalkLabel');
    expect(mic).toContain('שיחה עם AIRVIX Ask של הממשק. לא פקודות טיסה.');
    expect(mic).not.toMatch(/רדיו|טייס|מטוס/);
    expect(mic).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });

  it('keeps the flyable Mission layout band from 263', () => {
    const workspace = cssBlock(css, '.mission-workspace[data-mission-layout="ops-v1"]');
    expect(workspace).toMatch(/--mission-map-min:\s*65%/);
    expect(workspace).toMatch(/--mission-ah-row:\s*40%/);
    expect(workspace).toMatch(/grid-template-areas:\s*"horizon map talk"/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*min-height:\s*35%/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*max-height:\s*42%/);
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/"ias horizon alt"/);
  });

  it('polishes the PFD with gradients and instrument chrome without a new layout', () => {
    const start = js.indexOf('function drawHorizon(');
    expect(start).toBeGreaterThanOrEqual(0);
    const draw = js.slice(start, start + 16000);
    expect(draw).toContain('imageSmoothingEnabled = true');
    expect(draw).toContain('createLinearGradient');
    expect(draw).toContain('skyZenith');
    expect(draw).toContain('gndDeep');
    expect(draw).not.toMatch(/imageSmoothingEnabled = false/);
    expect(cssBlock(css, '.pfd-horizon-stage')).toMatch(/box-shadow:/);
    expect(cssBlock(css, '.pfd-horizon-stage')).toMatch(/radial-gradient/);
    expect(css).toMatch(/\.pfd-horizon-stage::after/);
    expect(cssBlock(css, '.pfd-side-tape')).toMatch(/linear-gradient/);
    expect(cssBlock(css, '.pfd-side-tape')).toMatch(/position:\s*static/);
    expect(draw).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
  });

  it('keeps operator settings selectors that persist and apply', () => {
    expect(html).toContain('id="globalSettingsBtn"');
    expect(html).toContain('id="globalSettingsModal"');
    expect(html).toContain('id="gsVolumeSlider"');
    expect(html).toContain('id="gsElevenVoice"');
    expect(html).toContain('id="gsBrowserVoice"');
    expect(html).toContain('id="gsSttLang"');
    expect(html).toContain('id="gsAttentionBadge"');
    expect(html).toMatch(/data-attention-level="off"/);
    expect(html).toMatch(/data-attention-level="attention"/);
    expect(html).toMatch(/data-attention-level="critical"/);
    expect(js).toContain("STORAGE_KEY = 'vlc_settings_v1'");
    expect(js).toContain("ATTENTION_POLICY_KEY = 'visionLandingAttentionPolicyV1'");
    expect(js).toContain('function initGlobalSettings(');
    expect(js).toContain('function initAttentionPolicyControls(');
    expect(js).toContain('window.__vlcPersistSettings');
    expect(sliceFunction(js, 'initAttentionPolicyControls')).toContain('gsAttentionBadge');
    expect(sliceFunction(js, 'initGlobalSettings')).toContain('ttsVolume');
  });
});
