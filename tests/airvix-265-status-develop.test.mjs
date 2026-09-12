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

function panel(id) {
  const start = html.indexOf(`id="${id}"`);
  expect(start, `missing #${id}`).toBeGreaterThanOrEqual(0);
  const from = html.lastIndexOf('<section', start);
  const next = html.indexOf('<section', start + 12);
  return html.slice(from, next === -1 ? undefined : next);
}

describe('AIRVIX 1.02.268 status densify + Develop concept A', () => {
  it('pins APP_VERSION at 1.02.298', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.298'");
    expect(pkg.version).toBe('1.02.298');
  });

  it('keeps מסייע out of public UI', () => {
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(css.includes('מסייע')).toBe(false);
  });

  it('densifies computer status without dropping add-widgets or Jetson names', () => {
    expect(html).toMatch(/class="pulse-computer-who">Jetson</);
    expect(html).toMatch(/<h4>מחשב משימה<\/h4>/);
    expect(html).toMatch(/data-pulse-place="jetson"[^>]*>מחשב משימה</);
    expect(html).toContain('id="pulseAddWidgetInput"');
    expect(html).toContain('id="pulseAddWidgetBtn"');
    expect(html).toContain('class="pulse-health-note"');
    expect(html).toMatch(/בריאות מחשב המשימה והכלי/);
    expect(css).toMatch(/\.pulse-gauges \.pulse-gauge,[\s\S]*?padding:\s*2px/);
    expect(css).toMatch(/\.pulse-gauge-svg\s*\{[^}]*height:\s*54px/);
    expect(css).toMatch(/\.pulse-home\s*\{[^}]*gap:\s*6px/);
    expect(css).toMatch(/\.pulse-purpose\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/);
    const attention = sliceFunction(js, 'pulseBuildAttention');
    expect(attention).not.toMatch(/Jetson מנותק/);
    expect(attention).not.toMatch(/AIRVIX Ask מנותק/);
    const fn = new Function(`${attention}; return pulseBuildAttention({ companionLive: false, assistConnected: false });`)();
    expect(fn).toEqual([]);
  });

  it('keeps computer-status densify and leaves Develop to Capability Intake', () => {
    expect(html).not.toContain('id="evolveMissionMockBefore"');
    expect(html).not.toContain('id="evolveMissionMockAfter"');
    expect(html).not.toContain('class="evolve-concept">שנה את המוצר');
    expect(html).toContain('data-cap-intake="f1"');
    expect(html).toContain('יכולת חדשה');
    expect(sliceFunction(js, 'evolvePreviewAllowedTab')).toMatch(/pulse.*terrain/);
    expect(sliceFunction(js, 'evolvePreviewAllowedTab')).not.toMatch(/return 'pulse'/);
  });

  it('keeps plan and PR affordances and a light Ask-only pass on params and debrief', () => {
    expect(html).toContain('id="evolvePlanList"');
    expect(html).toContain('id="evolvePrChips"');
    expect(html).toContain('id="evolvePrLink"');
    expect(html).toContain('אין תוכנית עדיין.');
    expect(html).toContain('אין בקשת מיזוג עדיין.');
    const control = panel('control');
    const recordings = panel('recordings');
    expect(control.includes('מסייע')).toBe(false);
    expect(control.includes('מלווה')).toBe(false);
    expect(control.includes('מעבדה')).toBe(false);
    expect(recordings.includes('מסייע')).toBe(false);
    expect(recordings.includes('מלווה')).toBe(false);
    expect(recordings.includes('מעבדה')).toBe(false);
    expect(commercial).toContain('שיחה ותצוגה חיה');
    expect(commercial).toContain('אין כתיבה לבקר');
  });

  it('does not add flight writes, apply, or restart', () => {
    const src = [
      sliceFunction(js, 'pulseBuildAttention'),
      sliceFunction(js, 'devRenderEvolvePreview'),
      sliceFunction(js, 'devProductIntentText'),
      sliceFunction(js, 'devEvolvePreviewTab'),
      sliceFunction(js, 'evolvePreviewAllowedTab'),
      sliceFunction(js, 'capStartCapabilityAgent'),
      sliceFunction(js, 'capRenderDraftCard'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b|JETSON_COMPANION|CURSOR_API_KEY/);
  });
});
