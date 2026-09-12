import { describe, expect, it } from 'vitest';
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

describe('Status custom widgets match locked gauge cards', () => {
  it('renders added Pulse fields with the locked gauge card structure', () => {
    expect(html).toContain('id="pulseAddWidgetInput"');
    expect(html).toContain('class="pulse-gauge is-empty"');
    expect(html).toContain('class="pulse-gauge-svg"');
    expect(js).toContain('function createPulseExtraGauge(');
    expect(js).toContain("tile.className = 'pulse-gauge pulse-extra-gauge'");
    expect(js).toContain("svg.setAttribute('class', 'pulse-gauge-svg')");
    expect(js).toContain("fill.setAttribute('class', 'pulse-gauge-fill')");
    expect(js).toContain('PULSE_GAUGE_ARC');
    expect(sliceFunction(js, 'createPulseExtraGauge')).toContain("createElement('dd')");
    expect(sliceFunction(js, 'refreshPulseExtraWidgets')).toContain('createPulseExtraGauge');
    expect(sliceFunction(js, 'refreshPulseExtraWidgets')).not.toContain('pulse-extra-tile');
    expect(css).toMatch(/\.pulse-extra-metrics \.pulse-gauge/);
    expect(css).toMatch(/\.pulse-extra-row \.pulse-gauge/);
    expect(css).toMatch(/\.pulse-extra-metrics\s*\{\s*grid-template-columns:\s*repeat\(3/);
    expect(css).toMatch(/\.pulse-extra-row\s*\{\s*grid-template-columns:\s*repeat\(auto-fill/);
  });

  it('maps catalog keys to the same gauge kinds without inventing numbers', () => {
    const src = [
      sliceFunction(js, 'pulseWidgetGaugeKind'),
      sliceFunction(js, 'pulseWidgetGaugeState'),
      sliceFunction(js, 'pulseGaugePct'),
      'return { pulseWidgetGaugeKind, pulseWidgetGaugeState };',
    ].join('\n');
    const fns = new Function(src)();
    expect(fns.pulseWidgetGaugeKind('jetson.cpuLoadPct')).toBe('load');
    expect(fns.pulseWidgetGaugeKind('mavlink.fcMemPct')).toBe('mem');
    expect(fns.pulseWidgetGaugeKind('jetson.tempC')).toBe('temp');
    expect(fns.pulseWidgetGaugeKind('mavlink.altitude')).toBe('value');
    expect(fns.pulseWidgetGaugeState({ key: 'jetson.cpuLoadPct' }, '41%')).toEqual({
      kind: 'load',
      empty: false,
      pct: 41,
    });
    expect(fns.pulseWidgetGaugeState({ key: 'mavlink.altitude' }, '--')).toEqual({
      kind: 'value',
      empty: true,
      pct: 0,
    });
    expect(fns.pulseWidgetGaugeState({ key: 'mavlink.altitude' }, '120 m')).toEqual({
      kind: 'value',
      empty: true,
      pct: 0,
    });
  });

  it('does not add flight writes from the Pulse add-widget path', () => {
    const src = [
      sliceFunction(js, 'createPulseExtraGauge'),
      sliceFunction(js, 'refreshPulseExtraWidgets'),
      sliceFunction(js, 'addPulseWidget'),
      sliceFunction(js, 'formatPulseWidgetValue'),
    ].join('\n');
    expect(src).not.toMatch(/FLIGHT_ACTION|PARAM_SET|\/apply|\/restart/);
    expect(src).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});

describe('Mission AH fills the center stage', () => {
  it('draws sky and ground across the whole canvas, not an inset PFD', () => {
    const start = js.indexOf('function drawHorizon(');
    expect(start).toBeGreaterThanOrEqual(0);
    const draw = js.slice(start, start + 16000);
    expect(draw).toContain('const att = { x: 0, y: 0, w: W, h: H }');
    expect(draw).toContain('ctx.rect(att.x, att.y, att.w, att.h)');
    expect(draw).toContain('#163e86');
    expect(draw).toContain('#8a5724');
    expect(draw).not.toContain('drawVTape');
    expect(draw).not.toContain('tapeW');
    expect(draw).not.toContain('hdgH');
    expect(draw).toContain('formatHudAngleLabel');
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/padding:\s*0/);
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/"ias horizon alt"/);
    expect(cssBlock(css, '.pfd-horizon-stage')).toMatch(/align-self:\s*stretch/);
    expect(cssBlock(css, '.pfd-horizon-shell canvas')).toMatch(/inset:\s*0/);
    expect(cssBlock(css, '.pfd-horizon-shell canvas')).toMatch(/background:\s*transparent/);
    expect(cssBlock(css, '.pfd-side-tape')).toMatch(/position:\s*static/);
    expect(cssBlock(css, '.pfd-heading-lane')).toMatch(/position:\s*static/);
    expect(html).toContain('id="pfdAirspeedVal"');
    expect(html).toContain('id="pfdAltVal"');
    expect(html).toContain('id="pfdHdgVal"');
  });

  it('pins APP_VERSION at 1.02.293', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.293'");
    expect(pkg.version).toBe('1.02.293');
  });
});
