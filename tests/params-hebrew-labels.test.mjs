import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

function paramLabels(block) {
  return [...block.matchAll(/label:\s*'([^']*)'/g)].map((m) => m[1]);
}

function paramKeys(block) {
  return [...block.matchAll(/key:\s*'([^']*)'/g)].map((m) => m[1]);
}

const HEBREW_LETTER = /[\u0590-\u05FF]/;
const UNIT_ONLY = /^\((?:m|s|deg|m\/s)\)$/;

const ENGLISH_LEFTOVERS = [
  'Cross Track Gain',
  'Yaw Align Gain',
  'Takeoff Rotate Speed',
  'Takeoff Pitch',
  'Crosswind Max',
  'Abort אם',
  'לפני Abort',
  'מ-Abort',
  '(Recover)',
  'הפעלת Vision',
  'תיקון Vision',
  'ספול מנוע',
];

describe('PARAMS Hebrew leftover labels', () => {
  const paramsBlock = sliceConstArray(js, 'PARAMS');
  const labels = paramLabels(paramsBlock);
  const keys = paramKeys(paramsBlock);

  it('keeps wire keys in English', () => {
    expect(keys).toContain('xtrack_gain');
    expect(keys).toContain('yaw_align_gain');
    expect(keys).toContain('abort_conf_hold_s');
    expect(keys).toContain('to_rotate_speed_ms');
    expect(keys).toContain('vision_enable_alt_m');
  });

  it('uses Hebrew operator labels for leftover English phrases', () => {
    expect(labels).toContain('הגבר סטייה רוחבית');
    expect(labels).toContain('הגבר יישור כיוון');
    expect(labels).toContain('גובה הפעלת ראייה (m)');
    expect(labels).toContain('סף מינימום לתיקון ראייה');
    expect(labels).toContain('משך זמן מתחת לסף לפני ביטול (s)');
    expect(labels).toContain('סף יציאה מביטול (חזרה)');
    expect(labels).toContain('ביטול אם סטייה רוחבית גבוהה (m)');
    expect(labels).toContain('ביטול אם שגיאת כיוון גבוהה (deg)');
    expect(labels).toContain('מהירות הרמה בהמראה (m/s)');
    expect(labels).toContain('זווית עלייה בהמראה (deg)');
    expect(labels).toContain('רוח צד מקסימלית להמראה (m/s)');
    expect(labels).toContain('משך האצת מנוע לפני שחרור (s)');
    expect(labels).toContain('ביטול אם איבוד מהירות (m/s)');
  });

  it('does not keep leftover English phrases in operator-visible PARAMS labels', () => {
    for (const leftover of ENGLISH_LEFTOVERS) {
      expect(labels.some((label) => label.includes(leftover)), `leftover label: ${leftover}`).toBe(false);
    }
    for (const leftover of ENGLISH_LEFTOVERS) {
      expect(paramsBlock.includes(`label: '${leftover}`) || labels.includes(leftover), `exact leftover: ${leftover}`).toBe(false);
    }
  });

  it('keeps every PARAMS label in Hebrew (units may stay Latin)', () => {
    expect(labels.length).toBeGreaterThanOrEqual(16);
    for (const label of labels) {
      const withoutUnits = label.replace(/\((?:m|s|deg|m\/s)\)/g, '').trim();
      expect(withoutUnits.length, `empty label after units: ${label}`).toBeGreaterThan(0);
      expect(HEBREW_LETTER.test(withoutUnits) || UNIT_ONLY.test(withoutUnits), `non-Hebrew label: ${label}`).toBe(true);
    }
  });

  it('uses Hebrew abort-tab chrome next to the PARAMS list', () => {
    expect(html).toContain('בטיחות וביטול');
    expect(html).not.toContain('בטיחות ו-ABORT');
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    expect(paramsBlock).not.toMatch(/\/apply|\/restart|PARAM_SET|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });
});
