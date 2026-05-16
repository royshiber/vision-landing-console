import { describe, it, expect } from 'vitest';
import { runParamSmartSearchV2 } from '../lib/param-smart-search-v2.mjs';

describe('runParamSmartSearchV2', () => {
  it('returns explicit editable/outside buckets and max 5', async () => {
    const r = await runParamSmartSearchV2('מה פרמטר האוטוטיון?', { liveParams: null, maxResults: 5 });
    expect(r.ok).toBe(true);
    expect(r.max_results).toBe(5);
    expect(Array.isArray(r.editable_matches)).toBe(true);
    expect(Array.isArray(r.outside_matches)).toBe(true);
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results.length).toBeLessThanOrEqual(5);
  });

  it('marks FC-live params as available_on_fc', async () => {
    const r = await runParamSmartSearchV2('אוטוטיון', {
      liveParams: { AUTOTUNE_LEVEL: 6, FOO_BAR_X: 1 },
      maxResults: 5,
    });
    expect(r.ok).toBe(true);
    const hit = r.results.find((x) => x.param_key === 'AUTOTUNE_LEVEL');
    expect(hit).toBeTruthy();
    expect(hit.available_on_fc).toBe(true);
  });

  it('keeps legacy keys/matches fields for UI compatibility', async () => {
    const r = await runParamSmartSearchV2('pitch limit');
    expect(Array.isArray(r.keys)).toBe(true);
    expect(Array.isArray(r.matches)).toBe(true);
  });

  it('maps "יציאת סרוו מספר 2" to SERVO2_FUNCTION, not EKF', async () => {
    const r = await runParamSmartSearchV2('יציאת סרוו מספר 2', { liveParams: null, maxResults: 5 });
    expect(r.ok).toBe(true);
    expect(r.source === 'hard-intent-servo' || r.source === 'hard-intent-servo-fallback').toBe(true);
    expect(r.results[0].param_key).toBe('SERVO2_FUNCTION');
    expect(r.results.map((x) => x.param_key).includes('EK3_ENABLE')).toBe(false);
  });
});

