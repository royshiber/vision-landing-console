/**
 * Unit tests for lib/auto-config-recipes.mjs
 *
 * These tests run without a real Gemini API key — they validate:
 *   1. listComponentTypes() returns valid entries.
 *   2. buildAutoConfigRecipe() degrades gracefully when GEMINI_API_KEY is absent.
 *   3. The recipe shape matches the contract (summary, checks, param_changes, warnings).
 *   4. Static checks are always included in the fallback recipe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listComponentTypes, buildAutoConfigRecipe } from '../lib/auto-config-recipes.mjs';

// Suppress GEMINI_API_KEY so the engine always hits the graceful-fallback path.
const ORIG_KEY = process.env.GEMINI_API_KEY;
beforeAll(() => { delete process.env.GEMINI_API_KEY; });
afterAll(() => { if (ORIG_KEY) process.env.GEMINI_API_KEY = ORIG_KEY; });

// ── listComponentTypes ─────────────────────────────────────────────────────

describe('listComponentTypes', () => {
  it('returns a non-empty array', () => {
    const types = listComponentTypes();
    expect(Array.isArray(types)).toBe(true);
    expect(types.length).toBeGreaterThan(0);
  });

  it('each entry has id and labelHe', () => {
    const types = listComponentTypes();
    for (const t of types) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.labelHe).toBe('string');
      expect(t.labelHe.length).toBeGreaterThan(0);
    }
  });

  it('includes GPS and Receiver component types', () => {
    const ids = listComponentTypes().map((t) => t.id);
    expect(ids).toContain('GPS');
    expect(ids).toContain('Receiver');
  });
});

// ── buildAutoConfigRecipe – GPS, no API key (graceful fallback) ────────────

describe('buildAutoConfigRecipe – GPS fallback (no API key)', () => {
  let result;

  beforeAll(async () => {
    result = await buildAutoConfigRecipe({
      componentType: 'GPS',
      port: 'SERIAL3',
      symptoms: 'חיברתי GPS חדש ב-SERIAL3 אבל Mission Planner לא מראה Fix. LED של הGPS מהבהב כל הזמן.',
      liveParams: null,
    });
  }, 20_000);

  it('ok is true even without API key (graceful fallback)', () => {
    expect(result.ok).toBe(true);
  });

  it('recipe has a string summary', () => {
    expect(typeof result.recipe.summary).toBe('string');
    expect(result.recipe.summary.length).toBeGreaterThan(0);
  });

  it('recipe.checks is a non-empty array', () => {
    expect(Array.isArray(result.recipe.checks)).toBe(true);
    expect(result.recipe.checks.length).toBeGreaterThan(0);
  });

  it('recipe.param_changes is an array', () => {
    expect(Array.isArray(result.recipe.param_changes)).toBe(true);
  });

  it('recipe.warnings is an array', () => {
    expect(Array.isArray(result.recipe.warnings)).toBe(true);
  });

  it('static GPS checks are present (gps-serial-proto and gps-type)', () => {
    const ids = result.recipe.checks.map((c) => c.id);
    expect(ids).toContain('gps-serial-proto');
    expect(ids).toContain('gps-type');
  });

  it('each check has required fields', () => {
    for (const c of result.recipe.checks) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.title).toBe('string');
      expect(typeof c.description).toBe('string');
    }
  });
});

// ── buildAutoConfigRecipe – Receiver fallback ──────────────────────────────

describe('buildAutoConfigRecipe – Receiver fallback (no API key)', () => {
  let result;

  beforeAll(async () => {
    result = await buildAutoConfigRecipe({
      componentType: 'Receiver',
      symptoms: 'מקלט חדש חיברתי ואין PWM/RC input. Mission Planner לא רואה תנועה בסרגלי Radio Calibration.',
      liveParams: { RC_PROTOCOLS: '0', FLTMODE_CH: '5' },
    });
  }, 20_000);

  it('ok is true', () => { expect(result.ok).toBe(true); });

  it('static Receiver checks present (rc-input-visible)', () => {
    const ids = result.recipe.checks.map((c) => c.id);
    expect(ids).toContain('rc-input-visible');
    expect(ids).toContain('rc-protocol');
  });
});

// ── buildAutoConfigRecipe – Custom component ───────────────────────────────

describe('buildAutoConfigRecipe – Custom component fallback', () => {
  let result;

  beforeAll(async () => {
    result = await buildAutoConfigRecipe({
      componentType: 'Custom',
      symptoms: 'חיברתי רכיב שלא נמצא ברשימה',
    });
  }, 20_000);

  it('ok is true', () => { expect(result.ok).toBe(true); });
  it('has static Custom checks', () => {
    const ids = result.recipe.checks.map((c) => c.id);
    expect(ids).toContain('custom-serial');
  });
});

// ── buildAutoConfigRecipe – unknown component degrades to Custom ───────────

describe('buildAutoConfigRecipe – unknown component type', () => {
  let result;

  beforeAll(async () => {
    result = await buildAutoConfigRecipe({
      componentType: 'UnknownXYZ',
      symptoms: 'some problem',
    });
  }, 20_000);

  it('ok is true (does not throw)', () => { expect(result.ok).toBe(true); });
  it('recipe has summary', () => { expect(typeof result.recipe.summary).toBe('string'); });
});
