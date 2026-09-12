import { describe, it, expect } from 'vitest';
import {
  buildParamSetPayload,
  buildParamRequestReadPayload,
  buildParamRequestListPayload,
  resolveMavParamType,
  MAV_PARAM_TYPE,
  buildMavlink1Frame,
  parseMavlinkFrames,
  MSG_PARAM_SET,
  MSG_PARAM_REQUEST_READ,
  MSG_PARAM_REQUEST_LIST,
} from '../lib/mavlink-connection.mjs';

/** pymavlink pack+decode on Jetson: SERIAL5_PROTOCOL=0 INT8 sys 51 comp 1 */
const SERIAL5_PROTOCOL_SET_HEX = '00000000330153455249414c355f50524f544f434f4c02';

function nameAt(buf, offset) {
  return buf.slice(offset, offset + 16).toString('utf8').replace(/\0/g, '');
}

describe('PARAM wire builders (pymavlink / common.xml element-size reorder)', () => {
  it('PARAM_SET matches Jetson SERIAL5_PROTOCOL INT8 hex fixture', () => {
    const p = buildParamSetPayload('SERIAL5_PROTOCOL', 0, MAV_PARAM_TYPE.INT8, 51, 1);
    expect(p.length).toBe(23);
    expect(p.toString('hex')).toBe(SERIAL5_PROTOCOL_SET_HEX);
    expect(p.readFloatLE(0)).toBe(0);
    expect(p[4]).toBe(51);
    expect(p[5]).toBe(1);
    expect(nameAt(p, 6)).toBe('SERIAL5_PROTOCOL');
    expect(p[22]).toBe(2);
  });

  it('PARAM_SET is float|target|tc|name|type — not name-first', () => {
    const p = buildParamSetPayload('LAND_SPEED', 75, MAV_PARAM_TYPE.REAL32, 51, 1);
    expect(p.readFloatLE(0)).toBeCloseTo(75, 5);
    expect(p[4]).toBe(51);
    expect(p[5]).toBe(1);
    expect(nameAt(p, 6)).toBe('LAND_SPEED');
    expect(p[22]).toBe(9);
    expect(p.slice(0, 6).toString('utf8')).not.toContain('LAND');
  });

  it('encodes INT8 / INT16 / INT32 / UINT / REAL32 values as float + type byte', () => {
    const cases = [
      { name: 'SERIAL5_PROTOCOL', value: 2, type: MAV_PARAM_TYPE.INT8 },
      { name: 'RC6_DZ', value: 20, type: MAV_PARAM_TYPE.INT16 },
      { name: 'LOG_BITMASK', value: 65535, type: MAV_PARAM_TYPE.INT32 },
      { name: 'SR1_EXT_STAT', value: 4, type: MAV_PARAM_TYPE.UINT8 },
      { name: 'RC6_MIN', value: 1000, type: MAV_PARAM_TYPE.UINT16 },
      { name: 'LAND_FLARE_SEC', value: 1.5, type: MAV_PARAM_TYPE.REAL32 },
      { name: 'WP_LOITER_RAD', value: 80, type: MAV_PARAM_TYPE.UINT32 },
    ];
    for (const c of cases) {
      const p = buildParamSetPayload(c.name, c.value, c.type, 51, 1);
      expect(p.length).toBe(23);
      expect(p.readFloatLE(0)).toBeCloseTo(c.value, 5);
      expect(p[4]).toBe(51);
      expect(p[5]).toBe(1);
      expect(nameAt(p, 6)).toBe(c.name);
      expect(p[22]).toBe(c.type);
    }
  });

  it('PARAM_REQUEST_READ is index|target|tc|name — name-first is wrong', () => {
    const p = buildParamRequestReadPayload('SERIAL5_PROTOCOL', 51, 1, -1);
    expect(p.length).toBe(20);
    expect(p.readInt16LE(0)).toBe(-1);
    expect(p[2]).toBe(51);
    expect(p[3]).toBe(1);
    expect(nameAt(p, 4)).toBe('SERIAL5_PROTOCOL');
    expect(p.slice(0, 4).toString('utf8')).not.toContain('SERIAL');
  });

  it('PARAM_REQUEST_LIST is target_system then target_component', () => {
    const p = buildParamRequestListPayload(51, 1);
    expect(p.equals(Buffer.from([51, 1]))).toBe(true);
  });

  it('uses FC-echoed paramTypes (RC6_DZ type 4) over SERIAL/REAL32 guesses', () => {
    expect(resolveMavParamType('RC6_DZ', { RC6_DZ: 4 })).toBe(MAV_PARAM_TYPE.INT16);
    expect(resolveMavParamType('rc6_dz', { RC6_DZ: 4 })).toBe(4);
    expect(resolveMavParamType('SERIAL5_PROTOCOL', { SERIAL5_PROTOCOL: 2 })).toBe(MAV_PARAM_TYPE.INT8);
    expect(resolveMavParamType('LAND_SPEED', { LAND_SPEED: 9 })).toBe(MAV_PARAM_TYPE.REAL32);
    expect(resolveMavParamType('SERIAL5_PROTOCOL', {})).toBe(MAV_PARAM_TYPE.INT8);
    expect(resolveMavParamType('LAND_SPEED', {})).toBe(MAV_PARAM_TYPE.REAL32);
  });

  it('frames CRC-validate as PARAM_SET / REQUEST_READ / REQUEST_LIST', () => {
    const set = buildParamSetPayload('SERIAL5_PROTOCOL', 0, 2, 51, 1);
    const read = buildParamRequestReadPayload('SERIAL5_PROTOCOL', 51, 1, -1);
    const list = buildParamRequestListPayload(51, 1);
    const frames = parseMavlinkFrames(Buffer.concat([
      buildMavlink1Frame(MSG_PARAM_SET, set, 1),
      buildMavlink1Frame(MSG_PARAM_REQUEST_READ, read, 2),
      buildMavlink1Frame(MSG_PARAM_REQUEST_LIST, list, 3),
    ]));
    expect(frames.map((f) => f.msgId)).toEqual([
      MSG_PARAM_SET,
      MSG_PARAM_REQUEST_READ,
      MSG_PARAM_REQUEST_LIST,
    ]);
    expect(frames[0].payload.toString('hex')).toBe(SERIAL5_PROTOCOL_SET_HEX);
  });
});
