import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Why: 1.02.254 is APP_VERSION. The pre-commit bump hook once prepended a
 * filename dump (Server library / app.js / changelog.json / index.html / styles.css)
 * over the Assist landing. Guard that this version stays human product copy.
 * What: assert 1.02.254 is not a bump-hook basename list. Do not lock exact titles.
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
]);

function isFilenameDumpDetail(detail) {
  const parts = String(detail || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => /^[\w.-]+\.[A-Za-z0-9]+$/.test(part));
}

describe('changelog 1.02.254', () => {
  const changelog = JSON.parse(readFileSync(changelogPath, 'utf8'));
  const entry = changelog.find((row) => row && row.version === '1.02.254');

  it('exists with at least one change', () => {
    expect(entry).toBeTruthy();
    expect(Array.isArray(entry.changes) && entry.changes.length > 0).toBe(true);
  });

  it('is Assist product copy, not a bump-hook filename dump', () => {
    const titles = entry.changes.map((change) => String(change.title || '').trim().toLowerCase());
    expect(titles.some((title) => HOOK_DUMP_TITLES.has(title))).toBe(false);

    for (const change of entry.changes) {
      expect(isFilenameDumpDetail(change.detail)).toBe(false);
    }

    expect(JSON.stringify(entry.changes).toLowerCase()).toMatch(/assist/);
  });
});
