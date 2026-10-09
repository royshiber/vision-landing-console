import { describe, expect, it } from 'vitest';
import { fcTelemetryFields, parseGpsRawInt } from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';
import {
  flightFollowEnabled,
  formatGpsHoverTooltip,
  gpsFixChip,
  nextMapAircraftFix,
} from '../public/modules/gps-quality.mjs';

describe('GPS hover tooltip', () => {
  it('shows sats, fix, HDOP, age, and GPS2 only when those readings exist', () => {
    const text = formatGpsHoverTooltip({
      fixType: 3,
      sats: 14,
      hdop: 0.82,
      ageMs: 1200,
      gps2: { fixType: 3, sats: 8, hdop: 1.1, ageMs: 2400 },
    });
    expect(text).toContain('GPS');
    expect(text).toContain('לוויינים 14');
    expect(text).toContain('3D Fix');
    expect(text).toContain('HDOP 0.82');
    expect(text).toContain('לפני 1 שנ׳');
    expect(text).toContain('GPS2');
    expect(text).toContain('לוויינים 8');
    expect(text).toContain('HDOP 1.10');
    expect(text).toContain('לפני 2 שנ׳');
  });

  it('omits missing fields and the whole GPS2 block', () => {
    const text = formatGpsHoverTooltip({ fixType: 2, sats: null, hdop: null, ageMs: null });
    expect(text).toBe('GPS\n2D Fix');
    expect(text).not.toContain('GPS2');
    expect(text).not.toContain('HDOP');
    expect(text).not.toContain('לוויינים');
    expect(formatGpsHoverTooltip({})).toBe('');
  });
});

describe('map aircraft position', () => {
  it('follows by default and stays off only after an explicit choice', () => {
    expect(flightFollowEnabled(null)).toBe(true);
    expect(flightFollowEnabled(undefined)).toBe(true);
    expect(flightFollowEnabled('1')).toBe(true);
    expect(flightFollowEnabled('0')).toBe(false);
  });

  it('draws a 3D fix and then holds that point when the fix drops below 3D', () => {
    const live = nextMapAircraftFix({ lat: 31.5, lon: 34.8, fixType: 3, held: null });
    expect(live).toMatchObject({ lat: 31.5, lon: 34.8, draw: true, track: true, acceptHold: true });
    const held = nextMapAircraftFix({
      lat: 32.2,
      lon: 35.5,
      fixType: 1,
      held: { lat: live.lat, lon: live.lon },
    });
    expect(held).toMatchObject({ lat: 31.5, lon: 34.8, draw: true, track: false, held: true });
    expect(gpsFixChip(1)).toBe('אין');
    expect(gpsFixChip(3)).toBe('3D');
  });

  it('does not draw a jumping position when the first fix is below 3D', () => {
    const row = nextMapAircraftFix({ lat: 32.2, lon: 35.5, fixType: 2, held: null });
    expect(row.draw).toBe(false);
    expect(row.track).toBe(false);
  });

  it('still draws when the fix type has not arrived', () => {
    const row = nextMapAircraftFix({ lat: 31.51, lon: 34.86, held: null });
    expect(row.draw).toBe(true);
    expect(row.acceptHold).toBe(true);
  });
});

describe('GPS_RAW_INT HDOP and GPS2', () => {
  it('reads HDOP from eph and leaves it empty when the field is unknown or truncated', () => {
    const p = Buffer.alloc(30);
    p.writeUInt16LE(82, 20);
    p.writeUInt8(3, 28);
    p.writeUInt8(12, 29);
    p.writeInt32LE(Math.round(31.5 * 1e7), 8);
    p.writeInt32LE(Math.round(34.8 * 1e7), 12);
    const g = parseGpsRawInt(p);
    expect(g.hdop).toBeCloseTo(0.82, 2);
    expect(g.eph).toBe(82);

    const unknown = Buffer.alloc(30);
    unknown.writeUInt16LE(65535, 20);
    unknown.writeUInt8(3, 28);
    expect(parseGpsRawInt(unknown).hdop).toBeNull();

    const short = Buffer.alloc(16);
    expect(parseGpsRawInt(short).hdop).toBeNull();
    expect(parseGpsRawInt(short).eph).toBeNull();
  });

  it('publishes primary and GPS2 quality without inventing a missing receiver', () => {
    const now = Date.now();
    const fields = fcTelemetryFields({
      lastGpsRaw: { fixType: 3, satellites: 14, hdop: 0.82, receivedWallMs: now - 400 },
      lastGps2Raw: { fixType: 3, satellites: 9, hdop: 1.2, receivedWallMs: now - 800 },
    }, now);
    expect(fields.gpsHdop).toBeCloseTo(0.82, 2);
    expect(fields.gps2Sats).toBe(9);
    expect(fields.gps2Hdop).toBeCloseTo(1.2, 2);
    expect(fields.gps2AgeMs).toBeGreaterThanOrEqual(800);
    const snap = buildSseMavlinkSnapshot({
      connected: true,
      lastGpsRaw: { fixType: 3, satellites: 14, hdop: 0.82, receivedWallMs: now },
      getMapTelemetrySnapshot() { return { gpsLat: null, gpsLon: null }; },
    });
    expect(snap.gpsHdop).toBeCloseTo(0.82, 2);
    expect(snap.gps2FixType).toBeNull();
    expect(snap.gps2Sats).toBeNull();
    expect(snap.gps2Hdop).toBeNull();
  });
});
