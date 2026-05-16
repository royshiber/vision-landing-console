import { describe, it, expect } from 'vitest';
import {
  resolveParamSmartSearchLocal,
  resolveParamSmartSearchFuzzy,
  runParamSmartSearch,
  stringsTypoClose,
} from '../lib/param-smart-search.mjs';
import { listArduParamCenterKeys } from '../lib/param-schema.mjs';

describe('stringsTypoClose', () => {
  it('treats common Hebrew spelling variants as the same token', () => {
    expect(stringsTypoClose('מקסימלית', 'מקסימאלית')).toBe(true);
    expect(stringsTypoClose('זווית', 'זוית')).toBe(true);
  });

  it('allows adjacent-letter typos (OSA)', () => {
    expect(stringsTypoClose('נחיתה', 'נחייתה')).toBe(true);
  });
});

describe('resolveParamSmartSearchLocal', () => {
  it('maps Hebrew pitch phrasing to LIM_PITCH_CD', () => {
    const keys = resolveParamSmartSearchLocal('זווית פיץ אפ מקסימאלית');
    expect(keys).toContain('LIM_PITCH_CD');
  });

  it('maps English max pitch to LIM_PITCH_CD', () => {
    expect(resolveParamSmartSearchLocal('max pitch up angle')).toContain('LIM_PITCH_CD');
  });

  it('maps "זווית אף חיובית מקסימאלית" (nose pitch) to LIM_PITCH_CD', () => {
    expect(resolveParamSmartSearchLocal('זווית אף חיובית מקסימאלית')).toContain('LIM_PITCH_CD');
  });

  it('maps heavily misspelled Hebrew pitch phrase to LIM_PITCH_CD', () => {
    expect(resolveParamSmartSearchLocal('זוית אף חיובית מקסימלית')).toContain('LIM_PITCH_CD');
  });

  it('maps קצב and one-letter Hebrew typo to companion_sr_bucket', () => {
    expect(resolveParamSmartSearchLocal('קצב')).toContain('companion_sr_bucket');
    expect(resolveParamSmartSearchLocal('כצב')).toContain('companion_sr_bucket');
  });

  it('maps approximate Hebrew for landing speed', () => {
    expect(resolveParamSmartSearchLocal('מהירת נחיתה')).toContain('LAND_SPEED');
  });
});

describe('resolveParamSmartSearchFuzzy', () => {
  it('matches pitch intent without full regex phrase', () => {
    const wl = new Set(listArduParamCenterKeys());
    expect(resolveParamSmartSearchFuzzy('משהו אף חיובית מקסימאלית', wl)).toContain('LIM_PITCH_CD');
  });
});

describe('runParamSmartSearch', () => {
  it('returns bilingual matches for Hebrew nose pitch (local path)', async () => {
    const r = await runParamSmartSearch('זווית אף חיובית מקסימאלית');
    expect(r.ok).toBe(true);
    expect(r.keys).toContain('LIM_PITCH_CD');
    const m = r.matches.find((x) => x.param_key === 'LIM_PITCH_CD');
    expect(m).toBeTruthy();
    expect(m.label_he.length).toBeGreaterThan(5);
    expect(m.label_en).toMatch(/LIM_PITCH_CD/i);
  });

  it('does not prioritize unrelated companion params for pitch intent', async () => {
    const r = await runParamSmartSearch('מקסימום זווית אף חיובית');
    expect(r.ok).toBe(true);
    expect(r.keys[0]).toBe('LIM_PITCH_CD');
    expect(r.keys.slice(0, 3)).not.toContain('companion_serial_port');
    expect(r.keys.slice(0, 3)).not.toContain('companion_sr_bucket');
  });

  it('filters companion params out for roll intent', async () => {
    const r = await runParamSmartSearch('מגבלת זווית גלגול מקסימלית');
    expect(r.ok).toBe(true);
    expect(r.keys[0]).toBe('LIM_ROLL_CD');
    expect(r.keys).not.toContain('companion_serial_port');
    expect(r.keys).not.toContain('companion_sr_bucket');
  });

  it('maps roll-rate intent to RLL2SRV_RMAX (rate, not angle)', async () => {
    const r = await runParamSmartSearch('קצב גלגול מקסימלי');
    expect(r.ok).toBe(true);
    expect(r.keys[0]).toBe('RLL2SRV_RMAX');
    expect(r.source).toBe('hard-intent');
    expect(r.keys).not.toContain('companion_sr_bucket');
  });

  it('handles typo in roll-rate phrase and avoids companion fallback', async () => {
    const r = await runParamSmartSearch('קצב גלגול חל');
    expect(r.ok).toBe(true);
    expect(r.keys[0]).toBe('RLL2SRV_RMAX');
    expect(r.source).toBe('hard-intent');
    expect(r.keys).not.toContain('companion_sr_bucket');
  });

  it('keeps companion params for communication rate intent', async () => {
    const r = await runParamSmartSearch('קצב טלמטריה ל compaion');
    expect(r.ok).toBe(true);
    expect(r.keys[0]).toMatch(/companion_(sr_bucket|serial_port)/);
  });
});
