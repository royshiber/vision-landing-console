import { describe, expect, it } from 'vitest';
import { formatGpsVisionDeltaMeters, gpsVisionDeltaMeters } from '../lib/gps-vision-delta.mjs';

describe('gpsVisionDeltaMeters', () => {
  it('returns null when any coordinate is missing or non-finite', () => {
    expect(gpsVisionDeltaMeters(32.1, 34.8, 32.1, null)).toBeNull();
    expect(gpsVisionDeltaMeters(32.1, 34.8, 32.1, undefined)).toBeNull();
    expect(gpsVisionDeltaMeters(NaN, 34.8, 32.1, 34.8)).toBeNull();
    expect(gpsVisionDeltaMeters(32.1, Infinity, 32.1, 34.8)).toBeNull();
    expect(gpsVisionDeltaMeters('', 34.8, 32.1, 34.8)).toBeNull();
    expect(gpsVisionDeltaMeters(32.1, 34.8, 'x', 34.8)).toBeNull();
  });

  it('returns 0 when GPS and Vision are the same finite point', () => {
    expect(gpsVisionDeltaMeters(32.0853, 34.7818, 32.0853, 34.7818)).toBe(0);
  });

  it('returns a finite meter distance for a known 1° latitude span at the equator', () => {
    const meters = gpsVisionDeltaMeters(0, 0, 1, 0);
    expect(Number.isFinite(meters)).toBe(true);
    expect(meters).toBeCloseTo(111194.9, 0);
  });
});

describe('formatGpsVisionDeltaMeters', () => {
  it('keeps the topbar placeholder when there is no number', () => {
    expect(formatGpsVisionDeltaMeters(null)).toBe('-- m');
    expect(formatGpsVisionDeltaMeters(undefined)).toBe('-- m');
    expect(formatGpsVisionDeltaMeters(NaN)).toBe('-- m');
  });

  it('formats a finite distance in meters', () => {
    expect(formatGpsVisionDeltaMeters(0)).toBe('0.0 m');
    expect(formatGpsVisionDeltaMeters(12.44)).toBe('12.4 m');
  });
});
