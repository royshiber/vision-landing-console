import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heDateMarkup, isoFromParts } from '../public/modules/he-date.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NATIVE = /type\s*=\s*["'](?:date|datetime-local)["']/i;

function files(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'vendor' || name === 'node_modules') continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...files(full));
    else if (/\.(html|js|mjs|css|json|svg)$/i.test(name)) out.push(full);
  }
  return out;
}

describe('native date inputs', () => {
  it('fails if public still has a native date input', () => {
    const hits = [];
    for (const file of files(root)) {
      const text = fs.readFileSync(file, 'utf8');
      if (NATIVE.test(text)) hits.push(path.relative(root, file));
    }
    expect(hits).toEqual([]);
  });

  it('orders the Hebrew control as day, month, year', () => {
    const html = heDateMarkup({ id: 'fbFrom', label: 'מתאריך' });
    const day = html.indexOf('data-part="day"');
    const month = html.indexOf('data-part="month"');
    const year = html.indexOf('data-part="year"');
    expect(day).toBeGreaterThan(-1);
    expect(day).toBeLessThan(month);
    expect(month).toBeLessThan(year);
    expect(html).toContain('placeholder="יום"');
    expect(html).toContain('placeholder="חודש"');
    expect(html).toContain('placeholder="שנה"');
    expect(html).not.toMatch(NATIVE);
    expect(isoFromParts('26', '9', '2026')).toBe('2026-09-26');
    expect(isoFromParts('31', '2', '2026')).toBe('');
    expect(isoFromParts('', '', '')).toBe('');
  });
});
