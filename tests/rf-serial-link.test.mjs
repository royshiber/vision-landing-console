import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMavlink1Frame,
  deactivateRfSerialConnections,
  MavlinkConnection,
} from '../lib/mavlink-connection.mjs';

const MSG_HEARTBEAT = 0;
const MSG_REQUEST_DATA_STREAM = 66;

function mavCrc(data) {
  let crc = 0xffff;
  for (const b of data) {
    let tmp = (b ^ (crc & 0xff)) & 0xff;
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

function vehicleHeartbeat() {
  const payload = Buffer.alloc(9);
  payload[4] = 1;
  payload[5] = 3;
  payload[6] = 0x51;
  payload[7] = 3;
  payload[8] = 3;
  const seq = 1;
  const sys = 1;
  const comp = 1;
  const header = Buffer.from([0xfe, payload.length, seq, sys, comp, MSG_HEARTBEAT]);
  const crcBuf = Buffer.concat([header.subarray(1), payload, Buffer.from([50])]);
  const crc = mavCrc(crcBuf);
  return Buffer.concat([header, payload, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

function streamRates(buf) {
  const rates = [];
  for (let i = 0; i + 8 < buf.length; i += 1) {
    if (buf[i] !== 0xfe || buf[i + 1] !== 6 || buf[i + 5] !== MSG_REQUEST_DATA_STREAM) continue;
    rates.push(buf.readUInt16LE(i + 6));
  }
  return rates;
}

function startPtyPair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-rf-'));
  const pathFile = path.join(dir, 'slave');
  const readyFile = path.join(dir, 'ready');
  const capFile = path.join(dir, 'cap');
  const hbFile = path.join(dir, 'hb');
  fs.writeFileSync(hbFile, vehicleHeartbeat());
  const child = spawn('python3', ['-c', `
import os, select, sys, time
import pty, tty
master, slave = pty.openpty()
tty.setraw(master)
open(sys.argv[1], "w", encoding="utf-8").write(os.ttyname(slave))
deadline = time.time() + 8
while time.time() < deadline and not os.path.exists(sys.argv[2]):
    time.sleep(0.02)
hb = open(sys.argv[4], "rb").read()
os.write(master, hb)
buf = b""
end = time.time() + 1.2
while time.time() < end:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        buf += os.read(master, 4096)
open(sys.argv[3], "wb").write(buf)
`, pathFile, readyFile, capFile, hbFile], { stdio: 'ignore' });
  return { child, pathFile, readyFile, capFile, dir };
}

describe('RF serial MAVLink on a virtual pair', () => {
  let opened = null;

  afterEach(async () => {
    deactivateRfSerialConnections();
    if (opened) {
      try { opened.disconnect(); } catch { /* already closed */ }
      opened = null;
    }
  });

  it('reads a vehicle heartbeat and requests the low RF rate', async () => {
    const pair = startPtyPair();
    const slave = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pty path missing')), 4000);
      const wait = () => {
        if (fs.existsSync(pair.pathFile)) {
          const name = fs.readFileSync(pair.pathFile, 'utf8').trim();
          if (name) {
            clearTimeout(timer);
            resolve(name);
            return;
          }
        }
        setTimeout(wait, 20);
      };
      wait();
    });
    const conn = new MavlinkConnection({
      id: 9101,
      name: 'RF test',
      type: 'serial',
      serialPort: slave,
      baudRate: 57600,
      linkRole: 'radio',
      streamProfile: 'rf',
    });
    opened = conn;
    const beat = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no heartbeat')), 4000);
      conn.once('heartbeat', (hb) => {
        clearTimeout(timer);
        resolve(hb);
      });
    });
    await conn.connect();
    fs.writeFileSync(pair.readyFile, '1');
    const hb = await beat;
    expect(hb.sysId).toBe(1);
    expect(hb.autopilotName).toBe('ArduPilot');
    conn.on('error', () => {});
    conn.requestHudMessageRates();
    await new Promise((resolve) => setTimeout(resolve, 200));
    conn.disconnect();
    opened = null;
    await new Promise((resolve, reject) => {
      pair.child.on('exit', () => resolve());
      setTimeout(() => reject(new Error('pty capture hung')), 4000);
    });
    const cap = fs.readFileSync(pair.capFile);
    const rates = streamRates(cap);
    expect(rates.length).toBeGreaterThan(0);
    expect(rates).toContain(1);
    expect(rates).not.toContain(4);
    expect(rates).not.toContain(10);
    expect(buildMavlink1Frame).toBeTypeOf('function');
  }, 12000);
});
