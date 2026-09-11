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

function runwayLane() {
  const src = [
    sliceFunction(js, 'capRunwayHasPr'),
    sliceFunction(js, 'capRunwayLane'),
  ].join('\n');
  return new Function(`${src}; return capRunwayLane;`)();
}

describe('AIRVIX 1.02.268 Capability Runway Kanban F2', () => {
  it('pins APP_VERSION at 1.02.277', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.277'");
    expect(pkg.version).toBe('1.02.277');
    expect(changelog).toContain('"version": "1.02.268"');
  });

  it('keeps F1 Capability Intake Studio', () => {
    const panel = developmentPanel();
    expect(panel).toContain('data-cap-intake="f1"');
    expect(panel).toContain('class="cap-draft-card"');
    expect(panel).toContain('class="cap-studio"');
    expect(panel).toContain('<h3>יכולת חדשה</h3>');
    expect(panel).toContain('id="capStartAgentBtn"');
    expect(panel).toContain('id="devTaskCreateBtn"');
    expect(panel).toContain('id="capTaxonomyChips"');
    expect(panel).toContain('data-cap-example="precision"');
  });

  it('ships IDEA→RUNNING→VERIFY→PR→DONE runway from real task fields', () => {
    const panel = developmentPanel();
    expect(panel).toContain('data-cap-runway="f2"');
    expect(panel).toContain('id="capRunwayBoard"');
    expect(panel).toContain('data-runway-lane="IDEA"');
    expect(panel).toContain('data-runway-lane="RUNNING"');
    expect(panel).toContain('data-runway-lane="VERIFY"');
    expect(panel).toContain('data-runway-lane="PR"');
    expect(panel).toContain('data-runway-lane="DONE"');
    expect(panel).toContain('מסלול יכולות');
    expect(js).toContain('function capRunwayLane(');
    expect(js).toContain('function capRenderRunway(');
    expect(sliceFunction(js, 'capRenderRunway')).toContain('dataset.runwayCardLane');
    expect(sliceFunction(js, 'capRenderRunway')).not.toContain('dataset.runwayLane');
    expect(sliceFunction(js, 'devRenderTaskList')).toContain('capRenderRunway()');
    expect(css).toContain('.cap-runway-board');
    expect(css).toMatch(/grid-area:\s*runway/);
  });

  it('maps lanes only from existing task / agent / tests / PR / release fields', () => {
    const lane = runwayLane();
    expect(lane({ status: 'DRAFT', agent: { state: 'NOT_STARTED' }, tests: { state: 'NOT_STARTED' } })).toBe('IDEA');
    expect(lane({ status: 'QUEUED', agent: { state: 'NOT_STARTED' }, tests: { state: 'NOT_STARTED' } })).toBe('RUNNING');
    expect(lane({ status: 'IN_PROGRESS', agent: { state: 'RUNNING' }, tests: { state: 'NOT_STARTED' } })).toBe('RUNNING');
    expect(lane({ status: 'IN_PROGRESS', agent: { state: 'SUCCEEDED' }, tests: { state: 'NOT_STARTED' } })).toBe('VERIFY');
    expect(lane({ status: 'TESTING', agent: { state: 'SUCCEEDED' }, tests: { state: 'RUNNING' } })).toBe('VERIFY');
    expect(lane({
      status: 'WAITING_FOR_REVIEW',
      agent: { state: 'SUCCEEDED', pr_url: 'https://example.invalid/pull/1' },
      tests: { state: 'PASSED' },
    })).toBe('PR');
    expect(lane({
      status: 'READY_FOR_RELEASE',
      agent: { state: 'SUCCEEDED' },
      tests: { state: 'PASSED' },
      release: { state: 'READY' },
    })).toBe('PR');
    expect(lane({
      status: 'RELEASED',
      agent: { state: 'SUCCEEDED', pr_url: 'https://example.invalid/pull/2' },
      tests: { state: 'PASSED' },
      release: { state: 'READY' },
    })).toBe('DONE');
    expect(lane({
      status: 'DEPLOYED',
      deployment: { state: 'DEPLOYED' },
    })).toBe('DONE');
    expect(lane({
      status: 'IN_PROGRESS',
      agent: { state: 'SUCCEEDED', pr_url: 'javascript:alert(1)' },
      tests: { state: 'PASSED' },
    })).toBe('VERIFY');
  });

  it('does not add AH polish, flight writes, apply, restart, or secrets', () => {
    const panel = developmentPanel();
    expect(panel).not.toContain('הגדל את האופק');
    expect(panel).not.toContain('id="evolveMissionMockBefore"');
    expect(panel).not.toContain('evolve-mission-mock');
    expect(js).not.toContain('הגדל את האופק');
    const src = [
      sliceFunction(js, 'capRunwayLane'),
      sliceFunction(js, 'capRunwayHasPr'),
      sliceFunction(js, 'capRenderRunway'),
      sliceFunction(js, 'capRunwayCardMeta'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(commercial).toContain('מסלול יכולות');
    expect(commercial).toContain('אין כתיבה לבקר');
  });

  it('keeps מסייע out of public UI', () => {
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(css.includes('מסייע')).toBe(false);
  });
});
