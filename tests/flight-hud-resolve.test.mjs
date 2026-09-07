import { describe, it, expect } from 'vitest';
import {
  rankHudParamMatches,
  resolveHudParamLocally,
  parseHudGeminiResolution,
  suggestMissionDataFields,
  FLIGHT_HUD_CATALOG,
} from '../lib/flight-hud-resolve.mjs';

describe('resolveHudParamLocally', () => {
  it('matches unambiguous Hebrew phrase', () => {
    const r = resolveHudParamLocally('מהירות אוויר');
    expect(r.kind).toBe('match');
    expect(r.key).toBe('mavlink.airspeed');
  });

  it('returns ambiguous for bare "מהירות"', () => {
    const r = resolveHudParamLocally('מהירות');
    expect(r.kind).toBe('ambiguous');
    expect(r.options.length).toBeGreaterThanOrEqual(2);
    expect(r.options.some((e) => e.key === 'mavlink.airspeed')).toBe(true);
    expect(r.options.some((e) => e.key === 'mavlink.groundspeed')).toBe(true);
  });

  it('distinguishes ground speed', () => {
    const r = resolveHudParamLocally('מהירות קרקעית');
    expect(r.kind).toBe('match');
    expect(r.key).toBe('mavlink.groundspeed');
  });

  it('matches Jetson CPU via synonym', () => {
    const r = resolveHudParamLocally('עומס מעבד של הג׳טסון');
    expect(r.kind).toBe('match');
    expect(r.key).toBe('jetson.cpuLoadPct');
  });
});

describe('rankHudParamMatches', () => {
  it('orders by score', () => {
    const ranked = rankHudParamMatches('cpu jetson');
    expect(ranked[0].entry.key).toBe('jetson.cpuLoadPct');
  });
});

describe('suggestMissionDataFields', () => {
  it('keeps a catalog of bindable console fields', () => {
    expect(FLIGHT_HUD_CATALOG.some((e) => e.key === 'mavlink.airspeed')).toBe(true);
    expect(FLIGHT_HUD_CATALOG.some((e) => e.key === 'mission.link')).toBe(true);
    expect(FLIGHT_HUD_CATALOG.some((e) => e.key === 'mission.gpsVisionDelta')).toBe(true);
    expect(FLIGHT_HUD_CATALOG.some((e) => e.key === 'vision.confidence')).toBe(true);
  });

  it('suggests chips from Hebrew or English free text', () => {
    const air = suggestMissionDataFields('מהירות אוויר');
    expect(air.exact?.key).toBe('mavlink.airspeed');
    expect(air.chips[0].key).toBe('mavlink.airspeed');
    const gs = suggestMissionDataFields('groundspeed');
    expect(gs.chips.some((c) => c.key === 'mavlink.groundspeed')).toBe(true);
    const link = suggestMissionDataFields('קישור');
    expect(link.chips.some((c) => c.key === 'mission.link')).toBe(true);
    const empty = suggestMissionDataFields('');
    expect(empty.chips.length).toBeGreaterThan(0);
    expect(empty.exact).toBeNull();
  });

  it('does not invent GPS numbers', () => {
    const miss = suggestMissionDataFields('מספר לוויינים בדוי 12.4');
    expect(miss.chips.every((c) => typeof c.key === 'string')).toBe(true);
    expect(JSON.stringify(miss)).not.toMatch(/12\.4/);
  });
});

describe('parseHudGeminiResolution', () => {
  it('parses ambiguous JSON', () => {
    const raw = JSON.stringify({
      status: 'ambiguous',
      key: null,
      keys: ['mavlink.airspeed', 'mavlink.groundspeed'],
    });
    const g = parseHudGeminiResolution(raw);
    expect(g.kind).toBe('ambiguous');
    expect(g.options).toHaveLength(2);
  });

  it('parses match JSON', () => {
    const raw = JSON.stringify({ status: 'match', key: 'mavlink.altitude', keys: [] });
    const g = parseHudGeminiResolution(raw);
    expect(g.kind).toBe('match');
    expect(g.key).toBe('mavlink.altitude');
  });
});
