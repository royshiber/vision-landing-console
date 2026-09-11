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

describe('Orphan #processes dead DOM REMOVE', () => {
  it('drops the orphan processes tab and panel', () => {
    expect(html).not.toMatch(/data-tab=["']processes["']/);
    expect(html).not.toMatch(/<section\b[^>]*\bid="processes"/);
    expect(html).not.toContain('id="processFlow"');
    expect(html).not.toContain('id="processPrevBtn"');
    expect(html).not.toContain('id="processNextBtn"');
    expect(html).not.toContain('id="preflightStatus"');
  });

  it('drops dead stepper hooks and keeps live telemetry checklist', () => {
    expect(js).not.toContain('const PROCESS_STEPS');
    expect(js).not.toContain('function renderProcessFlow');
    expect(js).not.toContain("getElementById('processFlow')");
    expect(js).not.toContain("getElementById('processPrevBtn')");
    expect(js).not.toContain("getElementById('processNextBtn')");
    expect(js).not.toContain('let processIndex');
    expect(js).toContain('function computeChecklist');
    expect(js).toContain('function renderChecklist');
    expect(js).toContain("getElementById('checklistList')");
    expect(js).toContain("getElementById('preflightCard')");
    const restore = sliceFunction(js, 'restoreLastUiTab');
    expect(restore).toMatch(/if \(main === 'processes'\) main = 'control'/);
  });

  it('drops orphan process chrome CSS', () => {
    expect(css).not.toMatch(/\.process-flow\b/);
    expect(css).not.toMatch(/\.process-card\b/);
    expect(css).not.toMatch(/#preflightStatus\b/);
    expect(css).not.toMatch(/@keyframes activePulse/);
  });

  it('pins APP_VERSION at 1.02.272', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.272'");
    expect(pkg.version).toBe('1.02.272');
  });
});
