import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('jetson flight logger', () => {
  it('runs the companion unittest suite', () => {
    const result = spawnSync(
      'python3',
      ['-m', 'unittest', 'discover', '-s', 'scripts/jetson-companion/tests', '-v'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 180000, env: process.env },
    );
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    expect(result.status, text.slice(-2000)).toBe(0);
    expect(text).toMatch(/OK/);
  }, 180000);
});
