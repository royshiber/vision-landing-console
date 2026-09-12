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
  const start = src.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${selector}`);
}

function pulsePanel() {
  const start = html.indexOf('<section id="pulse"');
  expect(start, 'missing #pulse').toBeGreaterThanOrEqual(0);
  const next = html.indexOf('<section id="control"');
  return html.slice(start, next === -1 ? undefined : next);
}

describe('AIRVIX 1.02.268 computer-status densify', () => {
  it('pins APP_VERSION at 1.02.282', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.282'");
    expect(pkg.version).toBe('1.02.282');
  });

  it('keeps מסייע out of public UI', () => {
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(css.includes('מסייע')).toBe(false);
  });

  it('packs Jetson and FC into a tight top band with larger gauges', () => {
    const pulse = pulsePanel();
    expect(pulse).toMatch(/class="pulse-status-grid pulse-computers-band"/);
    expect(pulse).toMatch(/class="pulse-computer-who">Jetson</);
    expect(pulse).toMatch(/<h4>מחשב משימה<\/h4>/);
    expect(pulse).toMatch(/data-computer="fc"/);
    expect(pulse).not.toMatch(/מסייע|מלווה/);
    expect(pulse.indexOf('pulse-computers-band')).toBeLessThan(pulse.indexOf('pulse-talk-card'));
    expect(pulse.indexOf('pulse-talk-card')).toBeLessThan(pulse.indexOf('pulse-add-widget'));
    expect(pulse).toMatch(/pulse-computers-band"[\s\S]*?<\/article>\s*<\/div>\s*<article class="pulse-status-card pulse-talk-card"/);
    expect(cssBlock(css, '.pulse-computers-band')).toMatch(/flex:\s*0 0 auto/);
    expect(cssBlock(css, '.pulse-gauge-svg')).toMatch(/height:\s*54px/);
    expect(cssBlock(css, '.pulse-gauge-svg')).toMatch(/max-width:\s*118px/);
    expect(cssBlock(css, '.pulse-status-card')).toMatch(/padding:\s*6px 8px/);
    expect(css).toMatch(/\.pulse-gauges \.pulse-gauge,\s*\.pulse-extra-metrics \.pulse-gauge/);
    expect(css).toMatch(/\.pulse-gauges \.pulse-gauge,[\s\S]*?padding:\s*2px/);
  });

  it('keeps AIRVIX Ask as a compact row and fills leftover height with add-widgets', () => {
    const pulse = pulsePanel();
    expect(pulse).toMatch(/<h4>AIRVIX Ask<\/h4>/);
    expect(pulse).toMatch(/id="pulseTalkBtn"[^>]*>שאלו את AIRVIX Ask</);
    expect(pulse).toContain('id="pulseAddWidgetInput"');
    expect(pulse).toContain('id="pulseAddWidgetBtn"');
    expect(pulse).toContain('id="pulseAddWidgetChips"');
    expect(pulse).toMatch(/data-pulse-place="jetson"[^>]*>מחשב משימה</);
    expect(cssBlock(css, '.pulse-talk-card')).toMatch(/padding:\s*3px 8px/);
    expect(cssBlock(css, '.pulse-talk-card')).toMatch(/flex:\s*0 0 auto/);
    expect(cssBlock(css, '.pulse-talk-copy')).toMatch(/flex-direction:\s*row/);
    expect(cssBlock(css, '.pulse-add-widget')).toMatch(/flex:\s*1 1 auto/);
    expect(cssBlock(css, '.pulse-add-widget-chips')).toMatch(/flex:\s*1 1 auto/);
    expect(cssBlock(css, '.pulse-add-widget-chips')).toMatch(/grid-auto-rows:\s*1fr/);
    expect(cssBlock(css, '.pulse-add-widget-chips')).toMatch(/grid-template-columns:\s*repeat\(5/);
    expect(js).toContain("chips: PULSE_WIDGET_CATALOG.slice()");
    expect(cssBlock(css, '.pulse-home')).toMatch(/gap:\s*6px/);
    expect(cssBlock(css, '.pulse-home')).toMatch(/height:\s*100%/);
  });

  it('does not restore duplicate disconnect footers or change safety paths', () => {
    const attention = sliceFunction(js, 'pulseBuildAttention');
    expect(attention).not.toMatch(/Jetson מנותק/);
    expect(attention).not.toMatch(/AIRVIX Ask מנותק/);
    const items = new Function(`${attention}; return pulseBuildAttention({ companionLive: false, assistConnected: false });`)();
    expect(items).toEqual([]);
    const src = [
      attention,
      sliceFunction(js, 'pulseRefresh'),
      sliceFunction(js, 'initPulseHome'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b|JETSON_COMPANION|CURSOR_API_KEY/);
  });

  it('does not touch Mission layout contract', () => {
    expect(css).toMatch(/#missionTalkHost \.assist-composer\s*\{[^}]*max-height:\s*210px/);
    expect(js).toContain("MISSION_SIZE_KEY = 'visionLandingMissionSizeV4'");
    expect(html).not.toMatch(/id="evolveProductPreview"[\s\S]*pulse-gauge/);
    expect(html).not.toContain('id="evolveMissionMockBefore"');
    expect(html).not.toContain('id="evolveMissionMockAfter"');
    expect(html).toContain('data-cap-intake="f1"');
  });
});
