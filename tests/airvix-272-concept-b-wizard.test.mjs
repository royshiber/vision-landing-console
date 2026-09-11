import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  applyConceptBFreeText,
  applyConceptBHardwarePreset,
  buildConceptBSummaryHe,
  CONCEPT_B_FREE_ID,
  emptyConceptBStep,
  isConceptBStepSavable,
  listConceptBCatalog,
  normalizeConceptBStep,
} from '../lib/auto-config-hardware.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');
const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');

function wizardPanel() {
  const start = html.indexOf('id="autoConfig"');
  expect(start, 'missing #autoConfig').toBeGreaterThanOrEqual(0);
  const custom = html.indexOf('id="customParams"', start);
  expect(custom, 'missing #customParams after autoConfig').toBeGreaterThan(start);
  return html.slice(start, custom);
}

function developPanel() {
  const start = html.indexOf('id="development"');
  expect(start, 'missing #development').toBeGreaterThanOrEqual(0);
  const from = html.lastIndexOf('<section', start);
  const flights = html.indexOf('id="flights"', start);
  expect(flights, 'missing #flights after development').toBeGreaterThan(start);
  return html.slice(from, flights);
}

describe('AIRVIX 1.02.272 Concept B configuration wizard', () => {
  it('pins APP_VERSION at 1.02.272', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.272'");
    expect(pkg.version).toBe('1.02.272');
    expect(changelog).toContain('"version": "1.02.272"');
  });

  it('renders three numbered tall cards in RTL with locked titles', () => {
    const panel = wizardPanel();
    expect(panel).toContain('data-ac-model="concept-b"');
    expect(panel).toContain('id="acBCardWhat"');
    expect(panel).toContain('id="acBCardWhere"');
    expect(panel).toContain('id="acBCardExpect"');
    expect(panel).toContain('מה חיברתי');
    expect(panel).toContain('לאן חיברתי');
    expect(panel).toContain('מה אני מצפה שיקרה');
    expect(panel).toContain('data-step="1"');
    expect(panel).toContain('data-step="2"');
    expect(panel).toContain('data-step="3"');
    expect(css).toContain('.ac-b-grid');
    expect(css).toContain('direction: rtl');
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  });

  it('keeps a first-class free-text field on every card', () => {
    const panel = wizardPanel();
    expect(panel).toContain('id="acBWhatFree"');
    expect(panel).toContain('id="acBWhereFree"');
    expect(panel).toContain('id="acBExpectFree"');
    expect(panel.match(/או כתוב חופשי…/g)?.length).toBeGreaterThanOrEqual(3);
    expect(panel.match(/>אחר</g)?.length).toBeGreaterThanOrEqual(3);
    expect(js).toContain('applyHardwarePreset');
    expect(js).toContain("step.hardwareId = AC_FREE");
    expect(js).toContain("step.portId = AC_FREE");
    expect(js).toContain('step.outcomeFree');
    expect(js).toContain('el.dataset.on = on ? \'1\' : \'0\'');
  });

  it('uses FC vs mission-computer segmented control and a pin grid', () => {
    const panel = wizardPanel();
    expect(panel).toContain('id="acBHostFc"');
    expect(panel).toContain('id="acBHostJetson"');
    expect(panel).toContain('בקר טיסה');
    expect(panel).toContain('מחשב משימה');
    expect(panel).toContain('id="acBPortGrid"');
    expect(css).toContain('.ac-b-seg-btn[data-host="fc"]');
    expect(css).toContain('.ac-b-seg-btn[data-host="jetson"]');
    expect(js).toContain("setHost('jetson')");
    expect(js).toContain('acBPortGrid');
  });

  it('has an outcome checklist with live status and a footer save/next', () => {
    const panel = wizardPanel();
    expect(panel).toContain('id="acBOutcomeList"');
    expect(panel).toContain('id="acBSummary"');
    expect(panel).toContain('id="acBSave"');
    expect(panel).toContain('id="acBNext"');
    expect(panel).toMatch(/>שמור</);
    expect(panel).toMatch(/>הבא</);
    expect(js).toContain('function liveOf');
    expect(js).toContain("key === 'gps3d'");
    expect(js).toContain("key === 'heartbeat'");
    expect(css).toContain('.ac-b-live');
  });

  it('does not redesign Develop / Capability Intake', () => {
    const develop = developPanel();
    expect(html).toContain('data-cap-intake="f1"');
    expect(html).toContain('data-cap-runway="f2"');
    expect(html).toContain('data-layout-contract="v2"');
    expect(develop).toContain('data-cap-intake="f1"');
    expect(develop).toContain('data-cap-runway="f2"');
    expect(js).not.toMatch(/function initAutoConfigWizard[\s\S]*applyMainTab\('terrain'\)/);
  });

  it('uses AIRVIX Ask and Jetson / מחשב משימה naming only', () => {
    const panel = wizardPanel();
    expect(panel).not.toContain('מסייע');
    expect(panel).not.toContain('מלווה');
    expect(panel).not.toMatch(/https?:\/\//);
    expect(js).toContain('מחשב משימה');
    expect(commercial).toContain('שלוש כרטיסיות');
  });

  it('does not add companion apply/restart or flight-command chrome in the wizard', () => {
    const panel = wizardPanel();
    expect(panel).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(panel).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});

describe('Concept B catalog and free-text persistence', () => {
  it('lists Here3, TELEM2, FIX 3D, and a Jetson port grid', () => {
    const catalog = listConceptBCatalog();
    expect(catalog.hardware.some((h) => h.id === 'here3' && h.labelHe === 'Here3')).toBe(true);
    expect(catalog.ports.fc.some((p) => p.id === 'TELEM2')).toBe(true);
    expect(catalog.ports.jetson.some((p) => p.id === 'UART1')).toBe(true);
    expect(catalog.outcomes.some((o) => o.token === 'FIX 3D')).toBe(true);
    const blob = JSON.stringify(catalog);
    expect(blob).not.toContain('מסייע');
    expect(blob).not.toContain('מלווה');
  });

  it('treats typing on each card as a first-class saved value', () => {
    let step = emptyConceptBStep();
    step = applyConceptBFreeText(step, 'hardware', 'מקלט ישן');
    expect(step.hardwareId).toBe(CONCEPT_B_FREE_ID);
    expect(step.hardwareFree).toBe('מקלט ישן');
    step = applyConceptBFreeText(step, 'where', 'שקע צד');
    expect(step.portId).toBe(CONCEPT_B_FREE_ID);
    expect(step.portFree).toBe('שקע צד');
    step = applyConceptBFreeText(step, 'expect', 'נורה ירוקה');
    expect(step.outcomeFree).toBe('נורה ירוקה');
    expect(isConceptBStepSavable(step)).toBe(true);
    const summary = buildConceptBSummaryHe(step);
    expect(summary).toContain('מקלט ישן');
    expect(summary).toContain('שקע צד');
    expect(summary).toContain('נורה ירוקה');
  });

  it('fills suggested wiring and outcome from a hardware preset', () => {
    const step = applyConceptBHardwarePreset(emptyConceptBStep(), 'here3');
    expect(step.hardwareId).toBe('here3');
    expect(step.host).toBe('fc');
    expect(step.portId).toBe('GPS');
    expect(step.outcomeIds).toContain('fix-3d');
    expect(buildConceptBSummaryHe(step)).toContain('Here3');
    expect(buildConceptBSummaryHe(step)).toContain('FIX 3D');
  });

  it('keeps free text after normalize', () => {
    const raw = normalizeConceptBStep({
      hardwareId: CONCEPT_B_FREE_ID,
      hardwareFree: '  כרטיס נדיר  ',
      host: 'jetson',
      portId: CONCEPT_B_FREE_ID,
      portFree: 'UART מותאם',
      outcomeIds: ['heartbeat'],
      outcomeFree: 'דופק נוסף',
    });
    expect(raw.hardwareFree).toBe('כרטיס נדיר');
    expect(raw.host).toBe('jetson');
    expect(isConceptBStepSavable(raw)).toBe(true);
    expect(buildConceptBSummaryHe(raw)).toContain('מחשב משימה');
  });
});
