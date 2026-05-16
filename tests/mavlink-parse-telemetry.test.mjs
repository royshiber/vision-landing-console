import { describe, it, expect } from 'vitest';
import {
  parseAttitude,
  parseVfrHud,
  parseGpsRawInt,
  parseGlobalPositionInt,
  parseSysStatus,
  parseStatusText,
} from '../lib/mavlink-connection.mjs';

describe('MAVLink telemetry parsers (wire layout + truncation)', () => {
  it('parseAttitude: uses offsets after time_boot_ms; radians → deg (1dp)', () => {
    const p = Buffer.alloc(28);
    p.writeUInt32LE(99_000, 0);
    p.writeFloatLE(0.1, 4);
    p.writeFloatLE(-0.05, 8);
    p.writeFloatLE(1.2, 12);
    const a = parseAttitude(p);
    expect(a).not.toBeNull();
    expect(a.rollDeg).toBe(5.7);
    expect(a.pitchDeg).toBe(-2.9);
    expect(a.yawDeg).toBe(68.8);
  });

  it('parseAttitude: MAVLink2-truncated payload (no angular rates) still parses angles', () => {
    const p = Buffer.alloc(16);
    p.writeUInt32LE(1, 0);
    p.writeFloatLE(0, 4);
    p.writeFloatLE(0, 8);
    p.writeFloatLE(0, 12);
    expect(parseAttitude(p)).toEqual({ rollDeg: 0, pitchDeg: 0, yawDeg: 0 });
  });

  it('parseAttitude: rejects too-short buffer', () => {
    expect(parseAttitude(Buffer.alloc(15))).toBeNull();
  });

  it('parseAttitude: rejects non-finite floats', () => {
   const p = Buffer.alloc(16);
    p.writeUInt32LE(0, 0);
    p.writeFloatLE(Number.NaN, 4);
    p.writeFloatLE(0, 8);
    p.writeFloatLE(0, 12);
    expect(parseAttitude(p)).toBeNull();
  });

  it('parseVfrHud: float block + heading int16 + throttle uint16', () => {
    const p = Buffer.alloc(20);
    p.writeFloatLE(12.3, 0);
    p.writeFloatLE(11.1, 4);
    p.writeFloatLE(100.5, 8);
    p.writeFloatLE(0.5, 12);
    p.writeInt16LE(45, 16);
    p.writeUInt16LE(72, 18);
    const v = parseVfrHud(p);
    expect(v).toEqual({
      airspeed: 12.3,
      groundspeed: 11.1,
      alt: 100.5,
      climb: 0.5,
      heading: 45,
      throttle: 72,
    });
  });

  it('parseVfrHud: heading outside 0..360 becomes null; too-short payload rejected', () => {
    const p = Buffer.alloc(20);
    p.writeFloatLE(0, 0);
    p.writeFloatLE(0, 4);
    p.writeFloatLE(0, 8);
    p.writeFloatLE(0, 12);
    p.writeInt16LE(-99, 16);
    p.writeUInt16LE(50, 18);
    expect(parseVfrHud(p)?.heading).toBeNull();
    expect(parseVfrHud(Buffer.alloc(19))).toBeNull();
  });

  it('parseGpsRawInt: lat/lon at aligned offsets; accepts 20B truncated v2', () => {
    const p = Buffer.alloc(20);
    p.writeBigUInt64LE(0n, 0);
    p.writeUInt8(3, 8);
    p.writeInt32LE(Math.round(37.1234567 * 1e7), 12);
    p.writeInt32LE(Math.round(-122.9876543 * 1e7), 16);
    const g = parseGpsRawInt(p);
    expect(g).not.toBeNull();
    expect(g.fixType).toBe(3);
    expect(g.lat).toBeCloseTo(37.1234567, 5);
    expect(g.lon).toBeCloseTo(-122.9876543, 5);
    expect(g.satellites).toBeNull();
  });

  it('parseGlobalPositionInt: lat/lon with partial payload omits heading', () => {
    const p = Buffer.alloc(20);
    p.writeUInt32LE(0, 0);
    p.writeInt32LE(Math.round(47.5 * 1e7), 4);
    p.writeInt32LE(Math.round(8.3 * 1e7), 8);
    const g = parseGlobalPositionInt(p);
    expect(g?.hdgDeg).toBeNull();
    expect(g?.lat).toBeCloseTo(47.5, 5);
  });

  it('parseGlobalPositionInt: heading cdeg when full row present', () => {
    const p = Buffer.alloc(28);
    p.writeUInt32LE(0, 0);
    p.writeInt32LE(Math.round(1 * 1e7), 4);
    p.writeInt32LE(Math.round(1 * 1e7), 8);
    p.writeUInt16LE(9050, 26); // 90.50°
    const g = parseGlobalPositionInt(p);
    expect(g?.hdgDeg).toBeCloseTo(90.5, 5);
  });

  it('parseSysStatus: mV / cA → V / A with sentinels', () => {
    const p = Buffer.alloc(19);
    p.fill(0, 0, 14);
    p.writeUInt16LE(12_345, 14); // 12.35 V
    p.writeInt16LE(234, 16); // 23.4 A
    p.writeInt8(88, 18);
    expect(parseSysStatus(p)).toEqual({
      voltage_V: 12.35,
      current_A: 2.34,
      remaining_pct: 88,
    });
    const q = Buffer.alloc(19);
    q.fill(0, 0, 14);
    q.writeUInt16LE(0xffff, 14);
    q.writeInt16LE(-1, 16);
    q.writeInt8(-1, 18);
    expect(parseSysStatus(q)).toEqual({
      voltage_V: null,
      current_A: null,
      remaining_pct: null,
    });
  });

  it('parseStatusText: accepts MAVLink2-truncated payload (not full 51B text tail)', () => {
    const p = Buffer.from([3, ...Buffer.from('GPS glitch', 'utf8')]);
    const st = parseStatusText(p);
    expect(st).toEqual({ severity: 3, text: 'GPS glitch' });
  });

  it('parseStatusText: rejects severity-only payload', () => {
    expect(parseStatusText(Buffer.from([2]))).toBeNull();
  });
});
