import { describe, it, expect } from 'vitest';
import {
  rankHudParamMatches,
  resolveHudParamLocally,
  parseHudGeminiResolution,
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
