import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { coerceArduTargetPatch } from '../lib/param-schema.mjs';
import {
  FC_PARAM_GROUPS,
  coerceGroupWriteValue,
  fcParamPresence,
  listFcParamGroups,
} from '../lib/fc-param-groups.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dump = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/arduplane-params.json'), 'utf8'));
const html = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
const names = new Set(Object.keys(dump.params || {}));

describe('FC parameter groups', () => {
  it('uses only real ArduPlane names and the requested groups', () => {
    const ids = FC_PARAM_GROUPS.map((group) => group.id);
    expect(ids).toEqual([
      'ekf', 'plnd', 'land', 'tecs', 'nav', 'failsafe', 'serial',
      'battery', 'rc', 'rangefinder', 'gps', 'arming', 'logs', 'all',
    ]);
    const keys = FC_PARAM_GROUPS.flatMap((group) => group.keys);
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) expect(names.has(key), key).toBe(true);
    expect(FC_PARAM_GROUPS.find((group) => group.id === 'all').keys).toEqual([]);
  });

  it('shows unknown, missing, or the read value and never a default', () => {
    expect(fcParamPresence(null, 'EK3_ENABLE')).toEqual({ state: 'unknown', text: 'לא ידוע' });
    expect(fcParamPresence({ AHRS_EKF_TYPE: 3 }, 'EK3_ENABLE')).toEqual({ state: 'missing', text: 'חסר' });
    expect(fcParamPresence({ EK3_ENABLE: 1 }, 'EK3_ENABLE')).toEqual({ state: 'present', text: '1' });
    expect(fcParamPresence({ EK3_ENABLE: '' }, 'EK3_ENABLE').text).toBe('לא ידוע');
  });

  it('accepts a catalog number on the existing write validator and rejects an unknown key', () => {
    expect(coerceGroupWriteValue('NOT_A_PARAM', 1)).toBeNull();
    expect(coerceGroupWriteValue('NAVL1_PERIOD', 'nope').ok).toBe(false);
    const ok = coerceArduTargetPatch({ NAVL1_PERIOD: 17 });
    expect(ok.accepted.NAVL1_PERIOD).toBe(17);
    expect(ok.rejected.NAVL1_PERIOD).toBeUndefined();
    const bad = coerceArduTargetPatch({ NOT_A_PARAM: 1 });
    expect(bad.rejected.NOT_A_PARAM).toBe('unknown_key');
  });

  it('binds the dropdown, the search filter, and the honesty card to the selected group', () => {
    const groups = listFcParamGroups();
    for (const group of groups) {
      expect(html).toContain(`value="ardu-${group.id}"`);
    }
    expect(html).toContain('id="fcGroupPane"');
    expect(app).toContain('renderFcGroupList()');
    expect(app).toContain("val === 'landingParams' || val === 'visionNavParams'");
    expect(app).toContain("keys.filter((key) => key.toLowerCase().includes(query))");
    expect(app).toContain('openGuardedFcWriteConfirm');
    expect(app).toContain('void loadFcParamGroups()');
  });
});
