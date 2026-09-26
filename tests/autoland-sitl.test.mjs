import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'sitl-autoland-shadow.py');

function sitlPresent() {
  const probe = spawnSync('python3', [script, '--probe'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === 'present';
}

describe('ArduPlane SITL auto-land shadow', () => {
  it.skipIf(!sitlPresent())('flies an approach and checks shadow decisions', () => {
    const result = spawnSync('python3', [script], {
      encoding: 'utf8',
      timeout: 180000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/RESULT pass/);
  });
});
