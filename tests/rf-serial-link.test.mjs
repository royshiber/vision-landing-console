import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateConnection,
  deactivateConnection,
  parseMavlinkStream,
} from '../lib/mavlink-connection.mjs';

const SCRIPT = `
import os, pty, sys, tty, select, time
master, slave = pty.openpty()
tty.setraw(master)
tty.setraw(slave)
path = sys.argv[1]
out = sys.argv[2]
sys.stdout.write(os.ttyname(slave) + "\\n")
sys.stdout.flush()
sys.path.insert(0, path)
from mavlink_route import build_frame
import struct
payload = struct.pack("<IBBBBB", 0, 1, 3, 0x51, 4, 3)
frame = build_frame(0, payload, 1, 1, 1)
buf = b""
deadline = time.time() + 8
while time.time() < deadline:
    os.write(master, frame)
    ready, _, _ = select.select([master], [], [], 0.2)
    if master in ready:
        buf += os.read(master, 4096)
        open(out, "wb").write(buf)
`;

describe('RF serial link', () => {
  let child = null;
  let connId = null;

  afterEach(async () => {
    if (connId) {
      try { deactivateConnection(connId); } catch { /* already closed */ }
      connId = null;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (child && !child.killed) child.kill('SIGTERM');
    child = null;
  });

  it('requests low intervals on a virtual serial pair and does not write params', async () => {
    const capture = path.join(os.tmpdir(), `vlc-rf-serial-${process.pid}.bin`);
    try { fs.unlinkSync(capture); } catch { /* fresh */ }
    child = spawn('python3', ['-c', SCRIPT, path.resolve('scripts/jetson-companion'), capture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', () => {});
    let slave = '';
    const err = [];
    child.stderr.on('data', (chunk) => err.push(chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pty did not open ${Buffer.concat(err).toString()}`)), 4000);
      child.stdout.on('data', (chunk) => {
        slave += chunk.toString();
        if (slave.includes('\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    slave = slave.trim().split('\n')[0];
    connId = `rf-serial-${process.pid}`;
    const conn = await activateConnection({
      id: connId,
      name: 'RF test',
      type: 'serial',
      serialPort: slave,
      baudRate: 57600,
      linkRole: 'radio',
      streamProfile: 'rf',
    });
    conn.on('error', () => {});
    const deadline = Date.now() + 4000;
    let frames = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (!fs.existsSync(capture)) continue;
      frames = parseMavlinkStream(fs.readFileSync(capture)).frames;
      const commands = frames.filter((frame) => frame.msgId === 76);
      if (commands.some((frame) => frame.payload.readFloatLE(4) === 1000000)) break;
    }
    const commands = frames.filter((frame) => frame.msgId === 76);
    expect(conn.streamProfile).toBe('rf');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((frame) => frame.payload.readUInt16LE(28) === 511)).toBe(true);
    expect(commands.some((frame) => frame.payload.readFloatLE(4) === 1000000)).toBe(true);
    expect(frames.some((frame) => frame.msgId === 66 || frame.msgId === 23)).toBe(false);
    deactivateConnection(connId);
    connId = null;
    await new Promise((r) => setTimeout(r, 200));
  }, 12000);
});
