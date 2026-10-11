/**
 * One ArduPlane SITL instance per opt-in test.
 * Instance 0 binds 5762, 5763, 5501, 9002, 9003, and 9005 even when
 * SERIAL0 is a free port. `-I N` adds 10*N to every one of those ports.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { freePort } from './test-server.mjs';

const root = path.join(os.tmpdir(), 'airvix-sitl-instances');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Side ports SITL binds for this instance, besides the SERIAL0 port we pass. */
export function sitlSidePorts(instance) {
  const shift = 10 * Number(instance);
  return [5762 + shift, 5763 + shift, 5501 + shift, 9002 + shift, 9003 + shift, 9005 + shift];
}

export function claimSitlInstance() {
  fs.mkdirSync(root, { recursive: true });
  for (let instance = 1; instance <= 200; instance += 1) {
    const file = path.join(root, `${instance}.lock`);
    const take = () => {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    };
    try {
      take();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let pid = 0;
      try { pid = Number(fs.readFileSync(file, 'utf8')); } catch { pid = 0; }
      if (pidAlive(pid)) continue;
      try { fs.unlinkSync(file); } catch { continue; }
      try { take(); } catch { continue; }
    }
    let released = false;
    return {
      instance,
      release() {
        if (released) return;
        released = true;
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      },
    };
  }
  throw new Error('no free SITL instance');
}

/** A loopback SERIAL0 port that is not one of this instance's side ports. */
export async function sitlMavlinkPort(instance) {
  const banned = new Set(sitlSidePorts(instance));
  for (let i = 0; i < 20; i += 1) {
    const port = await freePort();
    if (!banned.has(port)) return port;
  }
  throw new Error('no mavlink port clear of SITL side ports');
}
