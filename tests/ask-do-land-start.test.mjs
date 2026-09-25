import { describe, it, expect } from 'vitest';
import {
  buildDoLandStartPayload,
  buildMavlink1Frame,
  MavlinkConnection,
  parseMavlinkFrames,
  parseMissionWaypoint,
} from '../lib/mavlink-connection.mjs';
import { applyAskFlightOp } from '../lib/flight-actions-service.mjs';
import { ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';
import { MAV_CMD_DO_LAND_START, MAV_CMD_NAV_LAND } from '../lib/do-land-start.mjs';

function missionItemIntFrame({ seq, command, lat = 32.1, lon = 34.8 }) {
  const payload = Buffer.alloc(38);
  payload.writeFloatLE(0, 0);
  payload.writeFloatLE(0, 4);
  payload.writeFloatLE(0, 8);
  payload.writeFloatLE(0, 12);
  payload.writeInt32LE(Math.round(lat * 1e7), 16);
  payload.writeInt32LE(Math.round(lon * 1e7), 20);
  payload.writeFloatLE(100, 24);
  payload.writeUInt16LE(seq, 28);
  payload.writeUInt16LE(command, 30);
  payload[32] = 1;
  payload[33] = 1;
  payload[34] = 3;
  payload[35] = 0;
  payload[36] = 1;
  payload[37] = 0;
  return buildMavlink1Frame(73, payload, seq & 0xff);
}

function missionCountFrame(count) {
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(count, 0);
  payload[2] = 255;
  payload[3] = 190;
  return buildMavlink1Frame(44, payload, 1);
}

function mav1Frame({ msgId, payload, sysId, compId, seq = 1, crcExtra }) {
  const mid = Buffer.from([payload.length, seq & 0xff, sysId & 0xff, compId & 0xff, msgId & 0xff]);
  const crcData = Buffer.concat([mid, payload, Buffer.from([crcExtra & 0xff])]);
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

function commandAckFrame(command, result, { sysId = 1, compId = 1 } = {}) {
  const payload = Buffer.alloc(3);
  payload.writeUInt16LE(command, 0);
  payload[2] = result;
  return mav1Frame({ msgId: 77, payload, sysId, compId, seq: 2, crcExtra: 143 });
}

function autopilotHeartbeat() {
  const payload = Buffer.alloc(9);
  payload.writeUInt32LE(10, 0);
  payload[4] = 1;
  payload[5] = 3;
  payload[6] = 0x81;
  payload[7] = 4;
  payload[8] = 3;
  return mav1Frame({ msgId: 0, payload, sysId: 1, compId: 1, crcExtra: 50 });
}

function scriptedConnection(items, { ackResult = 0, ack = true } = {}) {
  const outbound = [];
  const conn = new MavlinkConnection({
    id: 3,
    name: 'land',
    type: 'tcp',
    host: '127.0.0.1',
    port: 5760,
  });
  conn.connected = true;
  conn.mavType = 1;
  conn.vehicleType = 'Fixed Wing';
  conn._handleData(autopilotHeartbeat());
  conn._socket = {
    write(buf) {
      const frames = parseMavlinkFrames(buf);
      for (const frame of frames) {
        if (frame.msgId === 43) {
          outbound.push({ msgId: 43 });
          conn._handleData(missionCountFrame(items.length));
        } else if (frame.msgId === 40) {
          const seq = frame.payload.readUInt16LE(0);
          const item = items.find((row) => row.seq === seq);
          if (item) conn._handleData(missionItemIntFrame(item));
        } else if (frame.msgId === 76) {
          const command = frame.payload.readUInt16LE(28);
          outbound.push({ msgId: 76, command, payload: Buffer.from(frame.payload) });
          if (ack && command === MAV_CMD_DO_LAND_START) {
            conn._handleData(commandAckFrame(MAV_CMD_DO_LAND_START, ackResult));
          }
        } else if (frame.msgId === 11) {
          outbound.push({ msgId: 11, mode: frame.payload.readUInt32LE(0) });
        } else {
          outbound.push({ msgId: frame.msgId });
        }
      }
    },
  };
  return { conn, outbound };
}

function sentModes(outbound) {
  return outbound.filter((row) => row.msgId === 11).map((row) => row.mode);
}

function sentCommands(outbound) {
  return outbound.filter((row) => row.msgId === 76).map((row) => row.command);
}

describe('DO_LAND_START landing', () => {
  it('reads the command at the MAVLink wire offset, not the old guessed offset', () => {
    const frame = parseMavlinkFrames(missionItemIntFrame({ seq: 4, command: 189, lat: 31.5, lon: 35.25 }))[0];
    const wp = parseMissionWaypoint(frame);
    expect(wp).toMatchObject({ seq: 4, command: 189 });
    expect(wp.lat).toBeCloseTo(31.5, 5);
    expect(wp.lon).toBeCloseTo(35.25, 5);
    const decoy = Buffer.alloc(38);
    decoy.writeUInt16LE(189, 5);
    expect(parseMissionWaypoint({ msgId: 73, payload: decoy }).command).not.toBe(189);
  });

  it('sends DO_LAND_START when the downloaded mission contains the marker', async () => {
    const { conn, outbound } = scriptedConnection([
      { seq: 0, command: 16, lat: 32.0, lon: 34.8 },
      { seq: 1, command: MAV_CMD_DO_LAND_START, lat: 32.1, lon: 34.9 },
      { seq: 2, command: MAV_CMD_NAV_LAND, lat: 32.2, lon: 34.9 },
    ]);
    const result = await applyAskFlightOp(null, {
      kind: 'LAND',
      mavConn: conn,
      missionTimeoutMs: 1000,
      ackTimeoutMs: 500,
    });
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.command).toBe(189);
    expect(result.customMode).toBe(null);
    expect(result.note).toBe(ASSIST_HE.landAckAccepted);
    expect(sentCommands(outbound)).toEqual([189]);
    expect(sentModes(outbound)).not.toContain(14);
    expect(outbound.some((row) => row.msgId === 43)).toBe(true);
    const payload = buildDoLandStartPayload(1, 1, 0, 0);
    expect(payload.readUInt16LE(28)).toBe(189);
    expect(payload.readUInt32LE(0)).not.toBe(14);
  });

  it('refuses a mission that has NAV_LAND and no DO_LAND_START', async () => {
    const { conn, outbound } = scriptedConnection([
      { seq: 0, command: 16, lat: 32.0, lon: 34.8 },
      { seq: 1, command: MAV_CMD_NAV_LAND, lat: 32.2, lon: 34.9 },
    ]);
    const result = await applyAskFlightOp(null, { kind: 'LAND', mavConn: conn });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.customMode).toBe(null);
    expect(result.note).toBe(ASSIST_HE.landNavLandWithoutMarker);
    expect(sentCommands(outbound)).toEqual([]);
    expect(sentModes(outbound)).toEqual([]);
  });

  it('refuses an empty mission', async () => {
    const { conn, outbound } = scriptedConnection([]);
    const result = await applyAskFlightOp(null, { kind: 'LAND', mavConn: conn });
    expect(result.sent).toBe(false);
    expect(result.note).toBe(ASSIST_HE.landMissionEmpty);
    expect(sentCommands(outbound)).toEqual([]);
    expect(sentModes(outbound)).toEqual([]);
  });

  it('refuses an unreadable mission and ignores a stale cache that has the marker', async () => {
    const { conn, outbound } = scriptedConnection([{ seq: 0, command: 16 }]);
    conn._socket.write = () => {};
    conn.missionItems = [{ seq: 1, command: 189, lat: 1, lon: 1 }];
    const result = await applyAskFlightOp(null, {
      kind: 'LAND',
      mavConn: conn,
      missionTimeoutMs: 30,
      ackTimeoutMs: 30,
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe('mission_unreadable');
    expect(result.note).toBe(ASSIST_HE.landMissionUnreadable);
    expect(result.customMode).toBe(null);
    expect(outbound.filter((row) => row.msgId === 76 || row.msgId === 11)).toEqual([]);
  });

  it('refuses copter land and does not send mode 9 or mode 14', async () => {
    const setArduPlaneMode = () => { throw new Error('should not set mode'); };
    const sendDoLandStart = () => { throw new Error('should not send land'); };
    const result = await applyAskFlightOp(null, {
      kind: 'LAND',
      mavConn: {
        connected: true,
        mavType: 2,
        vehicleType: 'Quadrotor',
        setArduPlaneMode,
        sendDoLandStart,
        refreshMissionToCache: async () => ({ ok: true }),
        missionItems: [{ command: 189 }],
      },
    });
    expect(result.sent).toBe(false);
    expect(result.note).toBe(ASSIST_HE.landNotFixedWing);
    const numeric = await applyAskFlightOp(null, {
      kind: 'MODE_CHANGE',
      mode: '9',
      mavConn: {
        connected: true,
        mavType: 2,
        vehicleType: 'Quadrotor',
        setArduPlaneMode,
        sendDoLandStart,
        refreshMissionToCache: async () => ({ ok: true }),
        missionItems: [],
      },
    });
    expect(numeric.sent).toBe(false);
    expect(numeric.note).toBe(ASSIST_HE.flightOpNumericMode);
  });

  it('reports a rejected COMMAND_ACK and a missing ack without claiming the landing started', async () => {
    const rejected = scriptedConnection(
      [{ seq: 0, command: MAV_CMD_DO_LAND_START, lat: 32, lon: 34 }],
      { ackResult: 2 },
    );
    const denied = await applyAskFlightOp(null, { kind: 'LAND', mavConn: rejected.conn });
    expect(denied.ok).toBe(false);
    expect(denied.sent).toBe(true);
    expect(denied.note).toBe(ASSIST_HE.landAckRejected);
    expect(sentModes(rejected.outbound)).not.toContain(14);

    const silent = scriptedConnection(
      [{ seq: 0, command: MAV_CMD_DO_LAND_START, lat: 32, lon: 34 }],
      { ack: false },
    );
    const timeout = await applyAskFlightOp(null, {
      kind: 'LAND',
      mavConn: silent.conn,
      ackTimeoutMs: 20,
    });
    expect(timeout.ok).toBe(false);
    expect(timeout.sent).toBe(true);
    expect(timeout.note).toBe(ASSIST_HE.landAckTimeout);
    expect(sentCommands(silent.outbound)).toEqual([189]);
    expect(sentModes(silent.outbound)).not.toContain(14);
  });

  it('still blocks ARM and maps copter RTL to 6, and does not SET_MODE for AVOID_ADSB', async () => {
    const calls = [];
    const mavConn = {
      connected: true,
      mavType: 2,
      vehicleType: 'Quadrotor',
      setArduPlaneMode(mode, opts) { calls.push({ mode, reason: opts.reason }); return { ok: true }; },
    };
    const arm = await applyAskFlightOp(null, { kind: 'ARM', mavConn });
    expect(arm.blocked).toBe(true);
    expect(arm.sent).toBe(false);
    const rtl = await applyAskFlightOp(null, { kind: 'RTL', mavConn });
    expect(rtl.customMode).toBe(6);
    expect(calls).toEqual([{ mode: 6, reason: 'RTL' }]);

    const planeCalls = [];
    const plane = {
      connected: true,
      mavType: 1,
      vehicleType: 'Fixed Wing',
      setArduPlaneMode(mode, opts) { planeCalls.push({ mode, reason: opts.reason }); return { ok: true }; },
    };
    const avoid = await applyAskFlightOp(null, { kind: 'MODE_CHANGE', mode: 'AVOID_ADSB', mavConn: plane });
    expect(avoid.sent).toBe(false);
    expect(avoid.customMode).toBe(null);
    expect(avoid.note).toBe(ASSIST_HE.flightOpModeNotAllowed);
    expect(planeCalls).toEqual([]);
    const blocked = new MavlinkConnection({ id: 9, name: 'x', type: 'tcp', host: '127.0.0.1', port: 1 });
    blocked.connected = true;
    blocked._socket = { write() { throw new Error('sent'); } };
    expect(() => blocked.setArduPlaneMode(14, { reason: 'LAND' })).toThrow(/not a flight mode/);
  });

  it('sends nothing for numeric mode 14 and for modes that are not voice-selectable', async () => {
    const { resolveAskFlightIntent } = await import('../lib/assist/ask-flight-intents.mjs');
    const { sanitizeLlmIntent } = await import('../lib/assist/ask-llm-intent.mjs');
    const { conn, outbound } = scriptedConnection([
      { seq: 0, command: 16, lat: 32, lon: 34.8 },
    ]);
    const setModes = [];
    const guard = {
      connected: true,
      mavType: 1,
      vehicleType: 'Fixed Wing',
      setArduPlaneMode(mode) { setModes.push(mode); return { ok: true }; },
      sendDoLandStart() { throw new Error('should not send'); },
      refreshMissionToCache: async () => { throw new Error('should not read'); },
    };

    const numeric = await applyAskFlightOp(null, { kind: 'MODE_CHANGE', mode: '14', mavConn: guard });
    expect(numeric.sent).toBe(false);
    expect(numeric.note).toBe(ASSIST_HE.flightOpNumericMode);

    for (const phrase of ['mode INITIALISING', 'mode AVOID_ADSB']) {
      const intent = resolveAskFlightIntent(phrase);
      expect(intent.slots.kind).toBe('MODE_CHANGE');
      const result = await applyAskFlightOp(null, {
        kind: intent.slots.kind,
        mode: intent.slots.mode,
        mavConn: guard,
      });
      expect(result.sent).toBe(false);
      expect(result.note).toBe(ASSIST_HE.flightOpModeNotAllowed);
    }

    const qlandIntent = resolveAskFlightIntent('mode QLAND');
    expect(qlandIntent.slots.mode).toBe('QLAND');
    const qland = await applyAskFlightOp(null, {
      kind: 'MODE_CHANGE',
      mode: qlandIntent.slots.mode,
      mavConn: conn,
    });
    expect(qland.sent).toBe(false);
    expect(qland.note).toBe(ASSIST_HE.landNoDoLandStart);

    const gemini = sanitizeLlmIntent({ intent: 'FLIGHT_OP', kind: 'MODE_CHANGE', mode: 'AUTOLAND' });
    expect(gemini.slots.mode).toBe('AUTOLAND');
    const autoland = await applyAskFlightOp(null, {
      kind: 'MODE_CHANGE',
      mode: gemini.slots.mode,
      mavConn: conn,
    });
    expect(autoland.sent).toBe(false);
    expect(autoland.note).toBe(ASSIST_HE.landNoDoLandStart);
    expect(sentModes(outbound)).toEqual([]);
    expect(sentCommands(outbound)).toEqual([]);
    expect(setModes).toEqual([]);

    const flip = await applyAskFlightOp(null, {
      kind: 'MODE_CHANGE',
      mode: 'FLIP',
      mavConn: { ...guard, mavType: 2, vehicleType: 'Quadrotor' },
    });
    expect(flip.sent).toBe(false);
    expect(flip.note).toBe(ASSIST_HE.flightOpModeNotAllowed);
  });

  it('ignores a COMMAND_ACK that is not from the locked autopilot', async () => {
    const { conn, outbound } = scriptedConnection(
      [{ seq: 0, command: MAV_CMD_DO_LAND_START, lat: 32, lon: 34 }],
      { ack: false },
    );
    const original = conn._socket.write.bind(conn._socket);
    conn._socket.write = (buf) => {
      original(buf);
      const frames = parseMavlinkFrames(buf);
      for (const frame of frames) {
        if (frame.msgId === 76 && frame.payload.readUInt16LE(28) === MAV_CMD_DO_LAND_START) {
          conn._handleData(commandAckFrame(MAV_CMD_DO_LAND_START, 0, { sysId: 255, compId: 190 }));
        }
      }
    };
    const result = await applyAskFlightOp(null, {
      kind: 'LAND',
      mavConn: conn,
      ackTimeoutMs: 40,
    });
    expect(result.sent).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.note).toBe(ASSIST_HE.landAckTimeout);
    expect(sentCommands(outbound)).toEqual([189]);
  });

  it('does not join an in-flight mission refresh, and retries a lost item', async () => {
    const hung = new MavlinkConnection({ id: 4, name: 'map', type: 'tcp', host: '127.0.0.1', port: 5760 });
    hung.connected = true;
    hung._socket = { write() {} };
    const map = hung.refreshMissionToCache({ timeoutMs: 5000 });
    const land = applyAskFlightOp(null, {
      kind: 'LAND',
      mavConn: hung,
      missionTimeoutMs: 40,
      ackTimeoutMs: 20,
    });
    const [result, mapError] = await Promise.all([
      land,
      map.then(() => null, (err) => err),
    ]);
    expect(result.sent).toBe(false);
    expect(result.error).toBe('mission_unreadable');
    expect(mapError).toBeInstanceOf(Error);
    expect(String(mapError.message)).toMatch(/superseded/);

    const retryConn = new MavlinkConnection({ id: 5, name: 'retry', type: 'tcp', host: '127.0.0.1', port: 5760 });
    retryConn.connected = true;
    const seen = [];
    retryConn._socket = {
      write(buf) {
        const frames = parseMavlinkFrames(buf);
        for (const frame of frames) {
          if (frame.msgId === 43) retryConn._handleData(missionCountFrame(2));
          if (frame.msgId === 40) {
            const seq = frame.payload.readUInt16LE(0);
            seen.push(seq);
            const firstSeq1 = seen.filter((n) => n === 1).length === 1 && seq === 1;
            if (seq === 1 && firstSeq1) return;
            retryConn._handleData(missionItemIntFrame({ seq, command: seq === 1 ? 189 : 16 }));
          }
        }
      },
    };
    const downloaded = await retryConn.refreshMissionToCache({ timeoutMs: 500, retryMs: 20, retries: 2 });
    expect(downloaded.ok).toBe(true);
    expect(retryConn.missionItems.map((row) => row.seq)).toEqual([0, 1]);
    expect(seen.filter((n) => n === 1).length).toBeGreaterThan(1);

    const seqConn = new MavlinkConnection({ id: 6, name: 'seq', type: 'tcp', host: '127.0.0.1', port: 5760 });
    seqConn.connected = true;
    seqConn._socket = { write() {} };
    const pending = seqConn.refreshMissionToCache({ timeoutMs: 400, retryMs: 1000, retries: 0 });
    seqConn._handleData(missionCountFrame(1));
    const short = Buffer.alloc(30);
    short.writeUInt16LE(1, 0);
    short.writeUInt16LE(7, 28);
    seqConn._handleData(mav1Frame({ msgId: 73, payload: short, sysId: 1, compId: 1, crcExtra: 38 }));
    const done = await pending;
    expect(done.ok).toBe(true);
    expect(seqConn.missionItems[0].seq).toBe(7);
    expect(seqConn.missionItems[0].seq).not.toBe(1);
  });
});
