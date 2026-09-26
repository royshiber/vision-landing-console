import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'linux', 'update-airvix.sh');

describe('Linux updater dry-run', () => {
  it('prints the temp, preserve, rollback, and restart plan without changing the tree', () => {
    const before = fs.statSync(path.join(repoRoot, 'server.js')).mtimeMs;
    const result = spawnSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, AIRVIX_APP_DIR: repoRoot },
    });
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toContain('dry-run');
    expect(out).toContain('extract=temp');
    expect(out).toContain('npm-ci=temp');
    expect(out).toContain('exclude=.env,data,var,node_modules');
    expect(out).toContain('preserve=.env,data,var');
    expect(out).toContain('rollback=previous-code');
    expect(out).toContain('swap=after-success');
    expect(out).toContain('restart=updater-owned');
    expect(out).toContain(`app-dir=${repoRoot}`);
    expect(fs.statSync(path.join(repoRoot, 'server.js')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(repoRoot, '.env'))).toBe(false);
  });

  it('points Windows updates at the in-repo installer', () => {
    const ps1 = fs.readFileSync(path.join(repoRoot, 'scripts', 'windows', 'install-airvix.ps1'), 'utf8');
    expect(ps1).toContain('http://192.168.1.122:8081');
    expect(ps1).toContain('100.82.59.45');
    expect(ps1).toContain('$needTs = $false');
    expect(ps1).toContain('IndexOfAny');
    expect(ps1).toContain('-UpdateOnly');
    expect(ps1).not.toMatch(/\$needTs = \$true/);
  });

  it('restores the previous tree when restart fails', () => {
    const text = fs.readFileSync(script, 'utf8');
    expect(text).toContain('restoring previous code');
    expect(text).toContain('ROLLBACK/console');
    expect(text).not.toMatch(/rm -rf "\$APP_DIR\/\.env"|rm -rf "\$APP_DIR\/data"|rm -rf "\$APP_DIR\/var"/);
  });
});
