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

describe('AIRVIX 1.02.261 Roy feedback (still holds on 1.02.298)', () => {
  it('pins APP_VERSION at 1.02.298', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.298'");
    expect(pkg.version).toBe('1.02.298');
  });

  it('removes Platform from primary chrome and redirects Assist', () => {
    expect(html).not.toMatch(/data-tab="platform"/);
    expect(html).not.toContain('id="platform"');
    expect(html).not.toContain('מעבדה');
    expect(findAssistRoute('פלטפורמה')?.tab).toBe('pulse');
    expect(findAssistRoute('platform')?.tab).toBe('pulse');
    expect(sliceFunction(js, 'operatorOpenFirstAction')).toMatch(/action === 'platform'/);
    expect(sliceFunction(js, 'operatorOpenFirstAction')).toMatch(/applyMainTab\('pulse'\)/);
  });

  it('removes Maintenance from primary chrome and keeps Jetson version on computer status', () => {
    const chrome = html.match(/<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/)?.[1] || '';
    expect(chrome).not.toMatch(/data-tab="maintenance"/);
    expect(chrome).not.toMatch(/>תחזוקה</);
    expect(html).toContain('id="pulseJetsonUpdateBtn"');
    expect(html).toContain('id="pulseJetsonVersion"');
    expect(findAssistRoute('תחזוקה')?.tab).toBe('pulse');
    expect(findAssistRoute('maintenance')?.tab).toBe('pulse');
    expect(findAssistRoute('Jetson')?.tab).toBe('pulse');
    expect(js).toMatch(/if \(tabId === 'maintenance'\) \{\s*applyMainTab\('pulse'/);
    expect(js).toMatch(/if \(main === 'maintenance'\) main = 'pulse'/);
    expect(sliceFunction(js, 'operatorOpenFirstAction')).toMatch(/action === 'maintenance'/);
  });

  it('turns Develop into Capability Intake without flight writes', () => {
    expect(html).toContain('class="devtasks-panel evolve-shell cap-intake-shell develop-b-shell"');
    expect(html).toContain('data-cap-intake="f1"');
    expect(html).toContain('class="cap-composer evolve-command"');
    expect(html).toContain('class="evolve-plan"');
    expect(html).toContain('class="evolve-delivery"');
    expect(html).toContain('id="evolveLiveRuns"');
    expect(html).toContain('id="evolvePlanList"');
    expect(html).toContain('id="evolveTestChips"');
    expect(html).toContain('id="evolvePrChips"');
    expect(html).toContain('אין תוכנית עדיין.');
    expect(html).toContain('אין בדיקות עדיין.');
    expect(html).toContain('אין בקשת מיזוג עדיין.');
    expect(html).toContain('class="devtasks-list evolve-backlog"');
    expect(html).toContain('id="devTaskCreateBtn"');
    expect(html).toMatch(/id="devTaskCreateBtn"[^>]*>שמור טיוטה</);
    expect(html).toMatch(/id="capStartAgentBtn"[^>]*>התחל סוכן יכולת</);
    expect(css).toMatch(/\.evolve-shell\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/"preview chat"/);
    expect(css).toMatch(/\.evolve-run-grid\s*\{[^}]*grid-auto-flow:\s*row/);
    expect(js).toContain('function isEvolvePreviewFrame(');
    expect(js).toContain('function capStartCapabilityAgent(');
    expect(js).toContain('function capRenderDraftCard(');
    expect(js).toContain('function devEvolvePlanSteps(');
    expect(js).toContain('function devSafePrUrl(');
    expect(js).toContain('function devRenderEvolveLiveRuns(');
    expect(js).toContain('function devTaskIsLive(');
    const evolve = [
      sliceFunction(js, 'devCreateTask'),
      sliceFunction(js, 'capStartCapabilityAgent'),
      sliceFunction(js, 'devRenderEvolveLiveRuns'),
      sliceFunction(js, 'devRenderEvolveWorkspace'),
      sliceFunction(js, 'devRenderEvolvePreview'),
      sliceFunction(js, 'devRenderEvolvePlan'),
      sliceFunction(js, 'devRenderEvolvePr'),
      sliceFunction(js, 'devEvolvePlanSteps'),
      sliceFunction(js, 'devSafePrUrl'),
      sliceFunction(js, 'devTaskIsLive'),
      sliceFunction(js, 'isEvolvePreviewFrame'),
      sliceFunction(js, 'evolvePreviewAllowedTab'),
    ].join('\n');
    expect(evolve).not.toMatch(/FLIGHT_ACTION|\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b/);
    expect(evolve).not.toMatch(/capture_amount|Default environment|סביבת ברירת מחדל/);
    expect(sliceFunction(js, 'evolvePreviewAllowedTab')).toMatch(/development.*terrain/);
    const planSrc = [
      sliceFunction(js, 'devEvolvePlanSteps'),
      sliceFunction(js, 'devAgentStateKind'),
      'return { empty: devEvolvePlanSteps(null), one: devEvolvePlanSteps({ description: "only title", agent: { state: "NOT_STARTED" } }), many: devEvolvePlanSteps({ description: "title\\nstep a\\nstep b", agent: { state: "RUNNING" } }) };',
    ].join('\n');
    const planned = new Function(planSrc)();
    expect(planned.empty).toEqual([]);
    expect(planned.one).toEqual([{ text: 'only title', kind: 'wait' }]);
    expect(planned.many.map((s) => s.text)).toEqual(['step a', 'step b']);
  });

  it('adds a computer-status widget composer with a growing grid', () => {
    expect(html).toContain('id="pulseAddWidgetInput"');
    expect(html).toContain('id="pulseAddWidgetBtn"');
    expect(html).toContain('id="pulseJetsonExtra"');
    expect(html).toContain('id="pulseFcExtra"');
    expect(html).toContain('id="pulseExtraRow"');
    expect(html).toMatch(/data-pulse-place="auto"/);
    expect(html).toMatch(/data-pulse-place="jetson"/);
    expect(html).toMatch(/data-pulse-place="fc"/);
    expect(html).toMatch(/data-pulse-place="row"/);
    expect(css).toMatch(/\.pulse-extra-metrics,\s*\.pulse-extra-row\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/\.pulse-extra-row\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill/);
    expect(css).toMatch(/\.pulse-extra-metrics:empty,\s*\.pulse-extra-row:empty/);
    expect(js).toContain("PULSE_WIDGETS_KEY = 'visionLandingPulseWidgetsV1'");
    expect(js).toContain('function suggestPulseWidgetFields(');
    expect(js).toContain('function addPulseWidget(');
    expect(js).toContain('function resolvePulseWidgetPlace(');
    const suggest = [
      sliceFunction(js, 'suggestPulseWidgetFields'),
      'const PULSE_WIDGET_CATALOG = [{ key: "mavlink.altitude", label: "גובה", unit: "m", place: "fc", tokens: ["alt", "גובה"] }, { key: "jetson.cpuLoadPct", label: "עומס CPU", unit: "%", place: "jetson", tokens: ["cpu", "עומס"] }];',
      'return suggestPulseWidgetFields("גובה");',
    ].join('\n');
    const result = new Function(suggest)();
    expect(result.exact?.key).toBe('mavlink.altitude');
    const placeSrc = [
      sliceFunction(js, 'resolvePulseWidgetPlace'),
      'return { auto: resolvePulseWidgetPlace({ place: "jetson" }, "auto"), row: resolvePulseWidgetPlace({ place: "jetson" }, "row"), fc: resolvePulseWidgetPlace({ place: "jetson" }, "fc") };',
    ].join('\n');
    const places = new Function(placeSrc)();
    expect(places.auto).toBe('jetson');
    expect(places.row).toBe('row');
    expect(places.fc).toBe('fc');
  });

  it('never invents pulse widget numbers and adds no flight writes', () => {
    const src = [
      sliceFunction(js, 'formatPulseWidgetValue'),
      sliceFunction(js, 'formatComputerMetric'),
      sliceFunction(js, 'pulseComputerMetricValue'),
      sliceFunction(js, 'pulseIsPlaceholder'),
      'function pulseResolveComputerHonesty() { return { jetsonLive: false }; }',
      'function companionFiniteMetric() { return null; }',
      'function formatMissionDataValue() { return "--"; }',
      'return formatPulseWidgetValue("jetson.cpuLoadPct", { jetson: { cpuLoadPct: 41, online: false } });',
    ].join('\n');
    const document = { getElementById() { return { dataset: { state: 'disconnected' } }; } };
    const shown = new Function('document', src)(document);
    expect(shown).toBe('--');
    const addSrc = [
      sliceFunction(js, 'addPulseWidget'),
      sliceFunction(js, 'resolvePulseWidgetPlace'),
      sliceFunction(js, 'refreshPulseExtraWidgets'),
      sliceFunction(js, 'operatorOpenFirstAction'),
    ].join('\n');
    expect(addSrc).not.toMatch(/FLIGHT_ACTION|\/apply|\/restart|ARM|DISARM|LAND/);
  });

  it('makes the Mission map the tall primary cell and keeps messages tiny', () => {
    expect(css).toMatch(/grid-template-areas:\s*"horizon map talk"/);
    expect(css).not.toMatch(/"data\s+map talk"/);
    expect(css).not.toMatch(/"messages map talk"/);
    expect(css).toMatch(/--mission-map-min:\s*65%/);
    expect(css).toMatch(/--mission-msg-h:\s*40px/);
    expect(html).toMatch(/data-mission-region="messages"[^>]*data-messages-expanded="0"/);
    expect(css).toMatch(/\.mission-region-messages\[data-messages-expanded="0"\] \.pfc-msg-primary/);
    expect(js).toContain('return { c1: 0.18, c2: 1.20, c3: 0.22, r1: 0.88, r2: 0.18, r3: 0.00 }');
  });

  it('keeps a clean rectangular PFD without overlay tapes', () => {
    expect(html).toContain('id="pfdHorizonStage"');
    expect(html).toContain('class="pfd-horizon-instrument"');
    expect(html).toContain('class="pfd-horizon-chrome"');
    expect(html).toContain('class="pfd-heading-lane"');
    expect(css).toMatch(/\.pfd-side-tape\s*\{[^}]*position:\s*static/);
    expect(css).toMatch(/\.pfd-video-toggle\s*\{[^}]*position:\s*static/);
    expect(css).toMatch(/\.pfd-video-panel\s*\{[^}]*position:\s*static/);
    expect(css).toMatch(/\.mission-data-grid\s*\{[^}]*flex-flow:\s*row nowrap/);
    expect(css).toMatch(/\.mission-data-grid\s*\{[^}]*align-items:\s*stretch/);
    expect(html).not.toContain('Vision Landing Console');
  });
});
