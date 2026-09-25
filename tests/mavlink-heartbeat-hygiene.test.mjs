import { describe, it, expect } from 'vitest';
import { buildMavlink1Frame, IGNORED_HEARTBEAT_COMPID_HINT, MavlinkConnection } from '../lib/mavlink-connection.mjs';
import { isFcArmed } from '../lib/advisor-apply.mjs';

function heartbeatFrame({
  sysId = 1,
  compId = 1,
  customMode = 0,
  type = 1,
  autopilot = 3,
  baseMode = 0,
} = {}) {
  const payload = Buffer.alloc(9);
  payload.writeUInt32LE(customMode >>> 0, 0);
  payload[4] = type;
  payload[5] = autopilot;
  payload[6] = baseMode;
  payload[7] = 4;
  payload[8] = 3;
  const seq = 1;
  const mid = Buffer.from([payload.length, seq, sysId & 0xff, compId & 0xff, 0]);
  const crcData = Buffer.concat([mid, payload, Buffer.from([50])]);
  let crc = 0xFFFF;
  for (const b of crcData) {
    let tmp = (b ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ (tmp << 4)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return Buffer.concat([
    Buffer.from([0xfe]),
    mid,
    payload,
    Buffer.from([crc & 0xff, (crc >> 8) & 0xff]),
  ]);
}

function conn() {
  return new MavlinkConnection({ id: 1, name: 'hygiene', type: 'tcp', host: '127.0.0.1', port: 5760 });
}

describe('autopilot heartbeat hygiene', () => {
  it('does not let a GCS heartbeat with base_mode 0 clear ARMED', () => {
    const c = conn();
    c._handleData(heartbeatFrame({
      sysId: 1,
      compId: 1,
      customMode: 10,
      type: 1,
      autopilot: 3,
      baseMode: 0x81,
    }));
    expect(isFcArmed(c)).toBe(true);
    expect(c.lastCustomMode).toBe(10);
    expect(c.vehicleType).toBe('Fixed Wing');
    expect(c.heartbeatCount).toBe(1);

    c._handleData(heartbeatFrame({
      sysId: 255,
      compId: 190,
      customMode: 0,
      type: 6,
      autopilot: 8,
      baseMode: 0,
    }));
    expect(isFcArmed(c)).toBe(true);
    expect(c.lastCustomMode).toBe(10);
    expect(c.sysId).toBe(1);
    expect(c.vehicleType).toBe('Fixed Wing');
    expect(c.heartbeatCount).toBe(1);
    expect(c.getStatus().ignoredHeartbeats.count).toBe(1);
    expect(c.getStatus().ignoredHeartbeats.sysId).toBe(255);
    expect(c.getStatus().ignoredHeartbeats.compId).toBe(190);
    expect(c.getStatus().ignoredHeartbeats.hintHe).toBe(null);
  });

  it('does not let a companion heartbeat change the mode', () => {
    const c = conn();
    c._handleData(heartbeatFrame({
      sysId: 1,
      compId: 1,
      customMode: 10,
      type: 1,
      autopilot: 3,
      baseMode: 0x81,
    }));
    c._handleData(heartbeatFrame({
      sysId: 1,
      compId: 191,
      customMode: 5,
      type: 18,
      autopilot: 8,
      baseMode: 0,
    }));
    c._handleData(heartbeatFrame({
      sysId: 1,
      compId: 191,
      customMode: 4,
      type: 18,
      autopilot: 3,
      baseMode: 0,
    }));
    c._handleData(heartbeatFrame({
      sysId: 42,
      compId: 1,
      customMode: 0,
      type: 1,
      autopilot: 3,
      baseMode: 0,
    }));
    expect(isFcArmed(c)).toBe(true);
    expect(c.lastCustomMode).toBe(10);
    expect(c.sysId).toBe(1);
    expect(c.fcTargetCompId).toBe(1);
    expect(c.mavType).toBe(1);
    const ignored = c.getStatus().ignoredHeartbeats;
    expect(ignored.count).toBe(3);
    expect(ignored.sysId).toBe(42);
    expect(ignored.compId).toBe(1);
    expect(ignored.type).toBe(1);
    expect(ignored.autopilot).toBe(3);
    expect(ignored.hintHe).toBe(IGNORED_HEARTBEAT_COMPID_HINT);
  });

  it('clears the locked autopilot system id on disconnect', () => {
    const c = conn();
    c._handleData(heartbeatFrame({ sysId: 1, customMode: 10 }));
    expect(c._lockedAutopilotSysId).toBe(1);
    c.disconnect();
    expect(c._lockedAutopilotSysId).toBe(null);
    c.connected = true;
    c._handleData(heartbeatFrame({ sysId: 7, customMode: 5, baseMode: 0x81 }));
    expect(c._lockedAutopilotSysId).toBe(7);
    expect(c.sysId).toBe(7);
    expect(c.lastCustomMode).toBe(5);
  });

  it('still accepts a later autopilot heartbeat on the locked system id', () => {
    const c = conn();
    c._handleData(heartbeatFrame({ customMode: 10, baseMode: 0x81 }));
    c._handleData(heartbeatFrame({ customMode: 11, baseMode: 0x81 }));
    expect(c.lastCustomMode).toBe(11);
    expect(c.heartbeatCount).toBe(2);
    expect(buildMavlink1Frame(0, Buffer.alloc(9), 1)[0]).toBe(0xfe);
  });
});
