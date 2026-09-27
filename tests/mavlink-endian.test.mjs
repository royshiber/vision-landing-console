import { describe, expect, it } from 'vitest';
import {
  buildRequestDataStreamPayload,
  buildSetMessageIntervalPayload,
  MAV_CMD_SET_MESSAGE_INTERVAL,
} from '../lib/mavlink-connection.mjs';

describe('MAVLink little-endian wire order', () => {
  it('packs SET_MESSAGE_INTERVAL floats and the command as little-endian', () => {
    const payload = buildSetMessageIntervalPayload(1, 1, 74, 200000);
    expect(payload.readFloatLE(0)).toBe(74);
    expect(payload.readFloatLE(4)).toBe(200000);
    expect(payload.readUInt16LE(28)).toBe(MAV_CMD_SET_MESSAGE_INTERVAL);
    expect(payload.readUInt16BE(28)).not.toBe(MAV_CMD_SET_MESSAGE_INTERVAL);
    expect(payload.subarray(28, 30)).toEqual(Buffer.from([0xff, 0x01]));
    expect(payload.readFloatBE(0)).not.toBe(74);
  });

  it('packs REQUEST_DATA_STREAM rate as a little-endian uint16 at offset 0', () => {
    const payload = buildRequestDataStreamPayload(1, 1, 10, 0x1234);
    expect(payload.readUInt16LE(0)).toBe(0x1234);
    expect(payload.readUInt16BE(0)).toBe(0x3412);
    expect(payload.readUInt16BE(0)).not.toBe(0x1234);
    expect(payload[2]).toBe(1);
    expect(payload[4]).toBe(10);
  });
});
