import { describe, expect, it } from 'vitest';
import { createMedianWindow, createStatusDebounce, createTelemetryHold } from '../lib/telemetry-hold.mjs';

describe('telemetry hold', () => {
  it('keeps the last good reading when a later sample omits the field', () => {
    let now = 1000;
    const hold = createTelemetryHold({ now: () => now, ttlMs: 3000, dimExtraMs: 5000 });
    expect(hold.offer('alt', '-0.60').text).toBe('-0.60');
    now = 2000;
    expect(hold.offer('alt', null).text).toBe('-0.60');
    expect(hold.offer('alt', '—').text).toBe('-0.60');
    expect(hold.offer('mode', 'MANUAL', { ttlMs: 12000 }).text).toBe('MANUAL');
    now = 4000;
    expect(hold.offer('mode', null, { ttlMs: 12000 }).text).toBe('MANUAL');
    now = 5000;
    const aged = hold.offer('alt', '');
    expect(aged.phase).toBe('aged');
    expect(aged.text).toContain('-0.60');
    expect(aged.text).toContain('לפני');
    expect(aged.dim).toBe(true);
    now = 10000;
    expect(hold.read('alt').phase).toBe('dash');
    expect(hold.read('alt').text).toBe('—');
  });

  it('smooths delay with a median and debounces a fault status', () => {
    const median = createMedianWindow(5);
    expect(median.push('home', 25)).toBe(25);
    expect(median.push('home', 450)).toBe(237.5);
    expect(median.push('home', 30)).toBe(30);
    let now = 0;
    const status = createStatusDebounce({ now: () => now, fails: 3, failMs: 10000 });
    expect(status.push('מחובר').text).toBe('מחובר');
    now = 1000;
    expect(status.push('שגיאה').text).toBe('מחובר');
    expect(status.push('שגיאה').text).toBe('מחובר');
    expect(status.push('שגיאה').text).toBe('שגיאה');
  });
});
