import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

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

const ENGLISH_LEFTOVERS = [
  'Vision',
  'Confidence',
  'Final',
  'Cross Track',
  'Abort',
  'Flare',
];

describe('Telemetry checklist Hebrew leftover copy', () => {
  it('uses Hebrew leftover copy in nearby checklist chrome', () => {
    const checklist = sliceFunction(js, 'computeChecklist');
    const labels = [...checklist.matchAll(/label:\s*`([^`]*)`/g)]
      .map((m) => m[1].replace(/\$\{[^}]+\}/g, ''));
    expect(labels.some((label) => label.includes('ביטחון ראייה מעל סף ביטול'))).toBe(true);
    expect(labels.some((label) => label.includes('ביטחון Vision מעל סף Abort'))).toBe(false);
    for (const leftover of ENGLISH_LEFTOVERS) {
      expect(labels.some((label) => label.includes(leftover)), `leftover checklist: ${leftover}`).toBe(false);
    }
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const checklist = sliceFunction(js, 'computeChecklist');
    expect(checklist).not.toMatch(/\/apply|\/restart|PARAM_SET|JETSON_COMPANION|CURSOR_API_KEY/);
  });
});
