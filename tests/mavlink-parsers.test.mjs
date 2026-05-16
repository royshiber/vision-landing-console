import { describe, it, expect } from 'vitest';
import {
  parseGpsRawInt,
  parseVfrHud,
  parseAttitude,
  parseGlobalPositionInt,
  parseSysStatus,
} from '../lib/mavlink-connection.mjs';

describe('MAVLink payload parsers', () => {
  it('parseGpsRawInt uses common.xml layout (fix @8, lat @12, lon @16, sats @32)', () => {
    const p = Buffer.alloc(42);
    p.writeBigUInt64LE(BigInt(123456789), 0);
    p.writeUInt8(3, 8);
    const latE7 = Math.round(-35.281 * 1e7);
    const lonE7 = Math.round(149.1234 * 1e7);
    p.writeInt32LE(latE7, 12);
    p.writeInt32LE(lonE7, 16);
    p.writeUInt8(9, 32);
    const g = parseGpsRawInt(p);
    expect(g).not.toBeNull();
    expect(g.fixType).toBe(3);
    expect(g.satellites).toBe(9);
    expect(Math.abs(g.lat + 35.281)).toBeLessThan(1e-5);
    expect(Math.abs(g.lon - 149.1234)).toBeLessThan(1e-5);
  });

  it('parseVfrHud floats then heading/throttle (airspeed gs alt climb | heading u16 throttle)', () => {
    const p = Buffer.alloc(20);
    p.writeFloatLE(11.25, 0);
    p.writeFloatLE(22.75, 4);
    p.writeFloatLE(105.125, 8);
    p.writeFloatLE(-0.5, 12);
    p.writeInt16LE(45, 16);
    p.writeUInt16LE(73, 18);
    const v = parseVfrHud(p);
    expect(v).not.toBeNull();
    expect(v.airspeed).toBeCloseTo(11.3, 1);
    expect(v.groundspeed).toBeCloseTo(22.8, 1);
    expect(v.alt).toBeCloseTo(105.1, 1);
    expect(v.climb).toBeCloseTo(-0.5, 1);
    expect(v.heading).toBe(45);
    expect(v.throttle).toBe(73);
  });

  it('parseAttitude reads roll pitch yaw after time_boot_ms (truncated payloads ok without rates)', () => {
    const p = Buffer.alloc(16);
    p.writeUInt32LE(999, 0);
    p.writeFloatLE(-0.0872664626, 4); // -5 deg rad
    p.writeFloatLE(0.0698131701, 8); // 4 deg rad
    p.writeFloatLE(1.57, 12);
    const a = parseAttitude(p);
    expect(a).not.toBeNull();
    expect(Math.abs(a.rollDeg + 5)).toBeLessThan(0.2);
    expect(Math.abs(a.pitchDeg - 4)).toBeLessThan(0.2);
  });

  it('parseGlobalPositionInt preserves lat lon hdg', () => {
    const p = Buffer.alloc(28);
    p.writeUInt32LE(1, 0);
    p.writeInt32LE(Math.round(-37.8 * 1e7), 4);
    p.writeInt32LE(Math.round(145.05 * 1e7), 8);
    p.writeUInt16LE(Math.round(90.02 * 100), 26);
    const gpi = parseGlobalPositionInt(p);
    expect(gpi).not.toBeNull();
    expect(Math.abs(gpi.lat + 37.8)).toBeLessThan(1e-5);
    expect(gpi.hdgDeg).toBeCloseTo(90.02, 2);
  });

  it('parseSysStatus reads battery_remaining at offset 18 (MAVLink common SYS_STATUS)', () => {
    const p = Buffer.alloc(19);
    p.writeUInt32LE(1, 0);
    p.writeUInt32LE(2, 4);
    p.writeUInt32LE(3, 8);
    p.writeUInt16LE(0, 12); // load
    p.writeUInt16LE(12_620, 14); // 12620 mV
    p.writeInt16LE(-1, 16); // no current
    p.writeInt8(77, 18);
    const s = parseSysStatus(p);
    expect(s.remaining_pct).toBe(77);
    expect(s.voltage_V).toBeCloseTo(12.62, 3);
    expect(s.current_A).toBeNull();
  });
});
