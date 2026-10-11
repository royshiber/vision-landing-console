import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Screenshot directory. VLC_SHOTS sets the root; otherwise the system temp dir. */
export function qaShotDir(name, env = process.env) {
  const fromEnv = String(env.VLC_SHOTS || '').trim();
  const root = fromEnv || path.join(os.tmpdir(), 'airvix-shots');
  const dir = name ? path.join(root, name) : root;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
