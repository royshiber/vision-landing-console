import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Why: 1.02.254 and 1.02.255 landed on master with pre-commit bump-hook
 * filename skeletons instead of product copy. Guard those two existing rows.
 * What: assert they are not basename dumps. Do not lock exact titles.
 */

const changelogPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'changelog.json',
);

const HOOK_DUMP_TITLES = new Set([
  'server library',
  'ui / app.js',
  'frontend',
  'html layout',
  'styles',
  'db schema',
  'tests',
]);

function isFilenameDumpDetail(detail) {
  const parts = String(detail || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => /^[\w.-]+\.[A-Za-z0-9]+$/.test(part));
}

function assertNotFilenameDump(entry) {
  const titles = entry.changes.map((change) => String(change.title || '').trim().toLowerCase());
  expect(titles.some((title) => HOOK_DUMP_TITLES.has(title))).toBe(false);
  for (const change of entry.changes) {
    expect(isFilenameDumpDetail(change.detail)).toBe(false);
  }
}

describe('changelog 1.02.254 and 1.02.255 product copy', () => {
  const changelog = JSON.parse(readFileSync(changelogPath, 'utf8'));
  const entry254 = changelog.find((row) => row && row.version === '1.02.254');
  const entry255 = changelog.find((row) => row && row.version === '1.02.255');

  it('keeps version strings and dates', () => {
    expect(entry254).toBeTruthy();
    expect(entry255).toBeTruthy();
    expect(entry254.date).toBe('2026-08-21');
    expect(entry255.date).toBe('2026-08-24');
  });

  it('1.02.254 is Assist product copy, not a bump-hook filename dump', () => {
    expect(Array.isArray(entry254.changes) && entry254.changes.length > 0).toBe(true);
    assertNotFilenameDump(entry254);
    expect(JSON.stringify(entry254.changes).toLowerCase()).toMatch(/assist/);
  });

  it('1.02.255 is connections-schema product copy, not a bump-hook filename dump', () => {
    expect(Array.isArray(entry255.changes) && entry255.changes.length > 0).toBe(true);
    assertNotFilenameDump(entry255);
    const blob = JSON.stringify(entry255.changes).toLowerCase();
    expect(blob).toMatch(/connections/);
    expect(blob).not.toMatch(/\bdb\.mjs\b/);
  });
});
