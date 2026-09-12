#!/usr/bin/env node
/**
 * Console / CI dry-run for observe-only dual-camera ingest.
 * Absent stays camera_ok false. Synthetic reports fps/age and never claims real.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ingest = path.join(root, 'scripts', 'jetson-companion', 'camera_ingest.py');
const install = path.join(root, 'scripts', 'jetson-companion', 'install.sh');

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    cwd: root,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout || r.status}`);
  }
  return r.stdout;
}

const help = process.argv.includes('--help');
if (help) {
  console.log('npm run camera:dry-run');
  process.exit(0);
}

run('bash', [install, '--dry-run']);
const absent = JSON.parse(run('python3', [ingest, '--dry-run', '--json']));
if (absent.camera_ok !== false || absent.dry_run !== true || absent.real === true) {
  throw new Error(`absent dry-run must stay honest: ${JSON.stringify(absent)}`);
}
const synthetic = JSON.parse(run('python3', [ingest, '--dry-run-synthetic', '--seconds', '0.25', '--json']));
if (synthetic.dry_run !== true || synthetic.real === true || synthetic.source !== 'synthetic') {
  throw new Error(`synthetic must not claim real: ${JSON.stringify(synthetic)}`);
}
if (synthetic.fps == null && synthetic.last_frame_age_ms == null) {
  throw new Error(`synthetic must report fps or age: ${JSON.stringify(synthetic)}`);
}

console.log(JSON.stringify({
  ok: true,
  absent: { camera_ok: absent.camera_ok, source: absent.source, real: absent.real },
  synthetic: {
    camera_ok: synthetic.camera_ok,
    source: synthetic.source,
    real: synthetic.real,
    fps: synthetic.fps,
    last_frame_age_ms: synthetic.last_frame_age_ms,
  },
}, null, 2));
