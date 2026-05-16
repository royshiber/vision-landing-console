import { describe, it, expect } from 'vitest';
import { parseGlobalPositionInt } from '../lib/mavlink-connection.mjs';

describe('parseGlobalPositionInt', () => {
  it('extracts MSL/relative alt, horizontal speed, heading from full payload', () => {
    const b = Buffer.alloc(28);
    b.writeUInt32LE(1000, 0);
    b.writeInt32LE(Math.round(32.1 * 1e7), 4);
    b.writeInt32LE(Math.round(34.85 * 1e7), 8);
    b.writeInt32LE(500_000, 12);
    b.writeInt32LE(120_000, 16);
    b.writeInt16LE(1000, 20);
    b.writeInt16LE(0, 22);
    b.writeInt16LE(0, 24);
    b.writeUInt16LE(9000, 26);
    const g = parseGlobalPositionInt(b);
    expect(g?.lat).toBeCloseTo(32.1, 5);
    expect(g?.lon).toBeCloseTo(34.85, 5);
    expect(g?.altMslM).toBeCloseTo(500, 5);
    expect(g?.relativeAltM).toBeCloseTo(120, 5);
    expect(g?.groundspeedMs).toBeCloseTo(10, 5);
    expect(g?.hdgDeg).toBeCloseTo(90, 5);
  });
});
