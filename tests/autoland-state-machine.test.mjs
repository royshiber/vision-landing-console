import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('auto-land state machine', () => {
  it('covers every transition and abort without sending', () => {
    const script = path.join(repoRoot, 'tests', 'autoland_state_machine_test.py');
    const result = spawnSync('python3', [script], { encoding: 'utf8' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/ok/);
  });
});
