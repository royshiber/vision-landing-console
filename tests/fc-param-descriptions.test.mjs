import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { FC_PARAM_GROUPS } from '../lib/fc-param-groups.mjs';
import {
  FC_PARAM_DESCRIPTIONS,
  fcParamHebrew,
  fcParamPresentation,
} from '../lib/fc-param-descriptions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dump = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/arduplane-params.json'), 'utf8'));
const names = new Set(Object.keys(dump.params || {}));

describe('FC parameter Hebrew descriptions', () => {
  it('keeps one table, only for real names, and leaves unknown keys blank', () => {
    expect(FC_PARAM_DESCRIPTIONS.EK3_ENABLE).toBe('הפעלת מסנן הניווט EKF3');
    expect(FC_PARAM_DESCRIPTIONS.LAND_FLARE_ALT).toBe('גובה תחילת היישור לפני נגיעה');
    expect(FC_PARAM_DESCRIPTIONS.ARMING_CHECK).toBeUndefined();
    expect(fcParamHebrew('ARMING_CHECK')).toBe('');
    expect(fcParamHebrew('NOT_A_PARAM')).toBe('');
    for (const key of Object.keys(FC_PARAM_DESCRIPTIONS)) expect(names.has(key), key).toBe(true);
    const catalog = FC_PARAM_GROUPS.flatMap((group) => group.keys);
    for (const key of catalog) expect(FC_PARAM_DESCRIPTIONS[key], key).toBeTruthy();
  });

  it('takes unit and range from metadata and does not invent either', () => {
    const flare = fcParamPresentation('LAND_FLARE_ALT');
    expect(flare.he).toBe('גובה תחילת היישור לפני נגיעה');
    expect(flare.units).toBe('m');
    expect(flare.range).toBe('0–30');
    const approach = fcParamPresentation('TECS_LAND_ARSPD');
    expect(approach.units).toBe('');
    expect(approach.range).toBe('-1–127');
    const unknown = fcParamPresentation('NOT_A_PARAM');
    expect(unknown).toEqual({ he: '', units: '', range: '' });
  });
});
