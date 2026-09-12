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
const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');
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

function developmentPanel() {
  const start = html.indexOf('id="development"');
  expect(start, 'missing #development').toBeGreaterThanOrEqual(0);
  const from = html.lastIndexOf('<section', start);
  const flights = html.indexOf('id="flights"', start);
  expect(flights, 'missing #flights after development').toBeGreaterThan(start);
  return html.slice(from, flights);
}

describe('AIRVIX 1.02.268 Capability Intake Studio F1', () => {
  it('pins APP_VERSION at 1.02.289', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.289'");
    expect(pkg.version).toBe('1.02.289');
    expect(changelog).toContain('"version": "1.02.268"');
  });

  it('keeps מסייע out of public UI', () => {
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(css.includes('מסייע')).toBe(false);
    expect(commercial.includes('מסייע')).toBe(false);
  });

  it('ships Capability Intake Studio instead of AH / Mission polish demos', () => {
    const panel = developmentPanel();
    expect(panel).toContain('data-cap-intake="f1"');
    expect(panel).toContain('class="cap-draft-card"');
    expect(panel).toContain('class="cap-studio"');
    expect(panel).toContain('<h3>יכולת חדשה</h3>');
    expect(panel).toContain('id="capStartAgentBtn"');
    expect(panel).toMatch(/id="capStartAgentBtn"[^>]*>התחל סוכן יכולת</);
    expect(panel).toMatch(/id="devTaskCreateBtn"[^>]*>שמור טיוטה</);
    expect(panel).toContain('id="capTaxonomyChips"');
    expect(panel).toContain('data-taxonomy="FEATURE"');
    expect(panel).toContain('data-taxonomy="REQUEST"');
    expect(panel).toContain('data-taxonomy="IDEA"');
    expect(panel).toContain('data-taxonomy="IMPROVEMENT"');
    expect(panel).toContain('data-taxonomy="BUG"');
    expect(panel).toContain('data-taxonomy="EXPERIMENT"');
    expect(panel).toContain('id="capDraftWhat"');
    expect(panel).toContain('id="capDraftWhy"');
    expect(panel).toContain('id="capDraftImpact"');
    expect(panel).toContain('id="capDraftRisks"');
    expect(panel).toContain('id="capDraftModules"');
    expect(panel).toContain('data-cap-example="precision"');
    expect(panel).toContain('data-cap-example="jetson"');
    expect(panel).toContain('data-cap-example="debrief"');
    expect(panel).toContain('data-cap-example="voice"');
    expect(panel).toContain('Precision Landing');
    expect(panel).toContain('Jetson overlay');
    expect(panel).toContain('Debrief AI');
    expect(panel).toContain('Voice Ops');
    expect(panel).not.toContain('הגדל את האופק');
    expect(panel).not.toContain('id="evolveMissionMockBefore"');
    expect(panel).not.toContain('id="evolveMissionMockAfter"');
    expect(panel).not.toContain('evolve-mission-mock');
    expect(js).not.toContain('הגדל את האופק');
    expect(js).not.toContain('evolveMissionMock');
  });

  it('keeps Development Tasks list, detail, and evidence as secondary', () => {
    const panel = developmentPanel();
    expect(panel).toContain('class="devtasks-list evolve-backlog"');
    expect(panel).toContain('id="devTaskDetailSection"');
    expect(panel).toContain('id="devEvidenceStrip"');
    expect(panel).toContain('<span>מה</span>');
    expect(panel).toContain('<span>למה</span>');
    expect(panel).toContain('id="devAgentStartBtn"');
    expect(panel).toContain('id="devTaskListBody"');
  });

  it('wires start-agent and save-draft to existing task store paths', () => {
    const start = sliceFunction(js, 'capStartCapabilityAgent');
    expect(start).toContain('devCreateTask');
    expect(start).toContain('devStartDevelopment');
    expect(start).toContain('_devAgentMeta.available');
    expect(start).toContain('devHebrewUnavailableReason');
    const create = sliceFunction(js, 'devCreateTask');
    expect(create).toContain("taxonomy = document.getElementById('devTaskTaxonomy')?.value || 'FEATURE'");
    expect(create).toContain("method: 'POST'");
    expect(create).toContain('/api/development/tasks');
    expect(js).toContain("getElementById('capStartAgentBtn')?.addEventListener('click'");
    expect(js).toContain('function capApplyExample(');
    expect(js).toContain('CAP_INTAKE_EXAMPLES');
    expect(js).toContain('precision:');
    expect(js).toContain('jetson:');
    expect(js).toContain('debrief:');
    expect(js).toContain('voice:');
  });

  it('does not add flight writes, apply, restart, or secrets', () => {
    const src = [
      sliceFunction(js, 'capStartCapabilityAgent'),
      sliceFunction(js, 'capApplyExample'),
      sliceFunction(js, 'capRenderDraftCard'),
      sliceFunction(js, 'capSetTaxonomy'),
      sliceFunction(js, 'devCreateTask'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('uses AIRVIX Ask naming only on the Develop surface', () => {
    const panel = developmentPanel();
    expect(panel).toContain('AIRVIX Ask');
    expect(panel).not.toContain('מסייע');
    expect(panel).not.toContain('מלווה');
    expect(js).toContain('חברו אותו ב-AIRVIX Ask');
  });
});
