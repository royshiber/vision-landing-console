import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildMavlink1Frame,
  buildMavlink2Frame,
  parseHeartbeat,
  parseMavlinkFrames,
  parseMavlinkStream,
  MavlinkConnection,
} from '../lib/mavlink-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentSrc = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py'),
  'utf8',
);

function hbPayload() {
  const p = Buffer.alloc(9);
  p.writeUInt32LE(0, 0);
  p[4] = 1; // fixed wing
  p[5] = 3; // ArduPilot
  p[6] = 0;
  p[7] = 3;
  p[8] = 3;
  return p;
}

function attitudePayload() {
  const p = Buffer.alloc(28);
  p.writeUInt32LE(1200, 0);
  p.writeFloatLE(0.1, 4);
  p.writeFloatLE(-0.05, 8);
  p.writeFloatLE(1.2, 12);
  return p;
}

function vfrPayload() {
  const p = Buffer.alloc(20);
  p.writeFloatLE(12.3, 0);
  p.writeFloatLE(11.1, 4);
  p.writeFloatLE(40.5, 8);
  p.writeFloatLE(0.2, 12);
  p.writeInt16LE(90, 16);
  p.writeUInt16LE(40, 18);
  return p;
}

function mavCrc(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    let tmp = (b ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ (tmp << 4)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return crc;
}

function buildFcHeartbeat(sysId = 1) {
  const payload = hbPayload();
  const seq = 7;
  const mid = Buffer.from([payload.length, seq, sysId, 1, 0]);
  const crc = mavCrc(Buffer.concat([mid, payload, Buffer.from([50])]));
  return Buffer.concat([Buffer.from([0xfe]), mid, payload, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

describe('MAVLink CRC stream parser (Jetson raw relay)', () => {
  it('finds HEARTBEAT / ATTITUDE / VFR after noise and false STX', () => {
    const hb = buildMavlink1Frame(0, hbPayload(), 1);
    const att = buildMavlink1Frame(30, attitudePayload(), 2);
    const vfr = buildMavlink1Frame(74, vfrPayload(), 3);
    const noise = Buffer.from([0x00, 0xfe, 0x20, 0x11, 0x22, 0xfd, 0x40, 0x00]);
    const buf = Buffer.concat([noise, hb, att, vfr]);
    const { frames, consumed } = parseMavlinkStream(buf);
    expect(frames.map((f) => f.msgId)).toEqual([0, 30, 74]);
    expect(parseHeartbeat(frames[0].payload)).toMatchObject({
      autopilotName: 'ArduPilot',
      vehicleType: 'Fixed Wing',
    });
    expect(consumed).toBe(buf.length);
    expect(parseMavlinkFrames(buf).length).toBe(3);
  });

  it('finds MAVLink2 HEARTBEAT', () => {
    const hb2 = buildMavlink2Frame(0, hbPayload(), 4);
    const frames = parseMavlinkFrames(hb2);
    expect(frames).toHaveLength(1);
    expect(frames[0].version).toBe(2);
    expect(frames[0].msgId).toBe(0);
    expect(parseHeartbeat(frames[0].payload)?.autopilotName).toBe('ArduPilot');
  });

  it('reassembles a HEARTBEAT split across TCP chunks', () => {
    const conn = new MavlinkConnection({
      id: 7,
      name: 'relay',
      type: 'tcp',
      host: '100.82.59.45',
      port: 5770,
    });
    const frame = buildFcHeartbeat(1);
    conn._handleData(frame.subarray(0, 6));
    expect(conn.heartbeatCount).toBe(0);
    conn._handleData(frame.subarray(6));
    expect(conn.heartbeatCount).toBe(1);
    expect(conn.lastHeartbeatAt).toBeTruthy();
    expect(conn.sysId).toBe(1);
    expect(conn.framesRx).toBe(1);
  });

  it('does not count a false STX as a frame and still counts the real HEARTBEAT', () => {
    const conn = new MavlinkConnection({
      id: 8,
      name: 'relay',
      type: 'tcp',
      host: '127.0.0.1',
      port: 5770,
    });
    const frame = buildMavlink1Frame(0, hbPayload(), 1);
    const junk = Buffer.from([0xfe, 0x09, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    conn._handleData(Buffer.concat([junk, frame]));
    expect(conn.heartbeatCount).toBe(1);
    expect(conn.crcFailCount).toBeGreaterThan(0);
    expect(conn.getStatus().crcFailCount).toBe(conn.crcFailCount);
  });
});

describe('companion_agent.py byte-level relay', () => {
  it('does not steal UART HEARTBEAT with recv_match on the relay port', () => {
    expect(agentSrc).not.toMatch(/\.recv_match\s*\(/);
    expect(agentSrc).toContain('uart_reader');
    expect(agentSrc).toContain('fanout_uart');
    expect(agentSrc).toContain('chunk_has_heartbeat');
    expect(agentSrc).toContain('never recv_match');
    expect(agentSrc).toMatch(/fc_read_only/);
    expect(agentSrc).toMatch(/relay_tcp_to_uart/);
    expect(agentSrc).toMatch(/AGENT_VERSION.*"2\.3\.4"/);
    expect(agentSrc).toContain('uart_reader → fanout_uart');
    expect(agentSrc).toContain('/dev/ttyTHS1');
    expect(agentSrc).toContain('921600');
    expect(agentSrc).toMatch(/VLC_FC_READ_ONLY", "1"/);
    expect(agentSrc).toContain('SERIAL3');
    expect(agentSrc).toContain('tcp_to_uart_suppressed');
    expect(agentSrc).toContain('/api/transport-test');
    expect(agentSrc).toContain('/api/v1/health');
    expect(agentSrc).toContain('/api/v1/status/vision');
    expect(agentSrc).toContain('/api/v1/status/optical-nav');
    expect(agentSrc).toContain('/api/v1/status/landing');
    expect(agentSrc).toContain('/api/logs');
    expect(agentSrc).toMatch(/"camera_ok": False/);
    expect(agentSrc).toMatch(/"runway_detector": False/);
    expect(agentSrc).not.toMatch(/"camera_ok": True/);
    expect(agentSrc).not.toMatch(/"runway_detected": True/);
    expect(agentSrc).not.toMatch(/lock_state['"]\s*:\s*['"]locked/);
  });
});
