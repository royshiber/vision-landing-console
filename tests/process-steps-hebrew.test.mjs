import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function sliceConstArray(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed const ${name}`);
}

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

function processStepTitles(block) {
  return [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const HEBREW_LETTER = /[\u0590-\u05FF]/;
const LATIN_KEEP = /GPS|לייזר/;

const ENGLISH_LEFTOVERS = [
  'Vision',
  'Confidence',
  'Final',
  'Cross Track',
  'Abort',
  'Flare',
];

describe('PROCESS_STEPS Hebrew leftover copy', () => {
  const stepsBlock = sliceConstArray(js, 'PROCESS_STEPS');
  const titles = processStepTitles(stepsBlock);

  it('keeps the landing checklist length and Hebrew titles', () => {
    expect(titles).toHaveLength(14);
    expect(titles).toContain('כניסה לנתיב נחיתה');
    expect(titles).toContain('הפעלת ראייה לנחיתה');
    expect(titles).toContain('בדיקת ביטחון לפני גישה סופית');
    expect(titles).toContain('מעבר לגישה סופית');
    expect(titles).toContain('תיקוני סטייה רוחבית עדינים');
    expect(titles).toContain('בדיקת תנאי ביטול');
    expect(titles).toContain('כניסה להצפה');
    expect(titles).toContain('עצירה סופית');
  });

  it('does not keep leftover English fragments in PROCESS_STEPS', () => {
    for (const leftover of ENGLISH_LEFTOVERS) {
      expect(titles.some((title) => title.includes(leftover)), `leftover step: ${leftover}`).toBe(false);
    }
  });

  it('keeps every PROCESS_STEPS title in Hebrew', () => {
    for (const title of titles) {
      const withoutKeep = title.replace(LATIN_KEEP, '').trim();
      expect(withoutKeep.length, `empty title after keep: ${title}`).toBeGreaterThan(0);
      expect(HEBREW_LETTER.test(withoutKeep), `non-Hebrew step: ${title}`).toBe(true);
    }
  });

  it('uses Hebrew leftover copy in nearby checklist chrome', () => {
    const checklist = sliceFunction(js, 'computeChecklist');
    const labels = [...checklist.matchAll(/label:\s*`([^`]*)`/g)].map((m) => m[1]);
    expect(labels.some((label) => label.includes('ביטחון ראייה מעל סף ביטול'))).toBe(true);
    expect(labels.some((label) => label.includes('ביטחון Vision מעל סף Abort'))).toBe(false);
    for (const leftover of ENGLISH_LEFTOVERS) {
      expect(labels.some((label) => label.includes(leftover)), `leftover checklist: ${leftover}`).toBe(false);
    }
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    expect(stepsBlock).not.toMatch(/\/apply|\/restart|PARAM_SET|JETSON_COMPANION|CURSOR_API_KEY|ARM|DISARM|LAND/);
    const checklist = sliceFunction(js, 'computeChecklist');
    expect(checklist).not.toMatch(/\/apply|\/restart|PARAM_SET|JETSON_COMPANION|CURSOR_API_KEY/);
  });
});
