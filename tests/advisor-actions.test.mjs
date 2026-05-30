/**
 * Unit tests for lib/advisor-actions.mjs
 * Covers: allowlist, denylist, safe range, validator, ID assignment, schema block.
 */
import { describe, it, expect } from 'vitest';
import {
  validateOptions,
  validateSingleForApply,
  assignActionIds,
  resolveParam,
  PARAM_DENYLIST,
  JETSON_PARAM_ALLOWLIST,
  FC_PARAM_ALLOWLIST_GROUND,
  ENABLED_ACTION_KINDS,
  buildLLMActionSchemaBlock,
  parseStructuredReply,
  buildParamAlternatives,
  isValueInParamProposalFamily,
  isDiscreteArduParam,
  snapDiscreteParamValue,
  formatDiscreteParamLabel,
} from '../lib/advisor-actions.mjs';
import { FC_ADVISOR_WRITE_BOUNDS } from '../lib/param-schema.mjs';

// ── resolveParam ──────────────────────────────────────────────────────────

describe('FC_PARAM_ALLOWLIST_GROUND vs FC_ADVISOR_WRITE_BOUNDS', () => {
  it('keeps min/max identical to param-schema (no drift)', () => {
    for (const [param, spec] of FC_PARAM_ALLOWLIST_GROUND) {
      const b = FC_ADVISOR_WRITE_BOUNDS[param];
      expect(b, `missing FC_ADVISOR_WRITE_BOUNDS.${param}`).toBeDefined();
      expect(spec.min).toBe(b.min);
      expect(spec.max).toBe(b.max);
    }
    expect(FC_PARAM_ALLOWLIST_GROUND.size).toBe(Object.keys(FC_ADVISOR_WRITE_BOUNDS).length);
  });
});

describe('resolveParam', () => {
  it('resolves a known Jetson param', () => {
    const r = resolveParam('flare_alt_m');
    expect(r).not.toBeNull();
    expect(r.target).toBe('jetson');
    expect(r.spec.min).toBeGreaterThan(0);
    expect(r.spec.max).toBeGreaterThan(r.spec.min);
  });

  it('resolves a known FC param', () => {
    const r = resolveParam('LAND_SPEED');
    expect(r).not.toBeNull();
    expect(r.target).toBe('fc');
  });

  it('returns null for denylisted param', () => {
    expect(resolveParam('ARMING_CHECK')).toBeNull();
    expect(resolveParam('FS_THR_ENABLE')).toBeNull();
  });

  it('returns null for unknown param', () => {
    expect(resolveParam('TOTALLY_FAKE_PARAM')).toBeNull();
  });

  it('returns null for empty / bad input', () => {
    expect(resolveParam('')).toBeNull();
    expect(resolveParam(null)).toBeNull();
    expect(resolveParam(42)).toBeNull();
  });
});

// ── ENABLED_ACTION_KINDS ─────────────────────────────────────────────────

describe('ENABLED_ACTION_KINDS', () => {
  it('contains no_action and param_change in phase 3', () => {
    expect(ENABLED_ACTION_KINDS.has('no_action')).toBe(true);
    expect(ENABLED_ACTION_KINDS.has('param_change')).toBe(true);
  });

  it('does not contain future kinds', () => {
    expect(ENABLED_ACTION_KINDS.has('param_change_group')).toBe(false);
    expect(ENABLED_ACTION_KINDS.has('read_log')).toBe(false);
  });
});

// ── validateOptions ───────────────────────────────────────────────────────

describe('validateOptions — no_action', () => {
  it('accepts a valid no_action', () => {
    const { accepted, rejected } = validateOptions([
      { kind: 'no_action', title: 'בדוק לוג', detail: 'פתח את הלוג ובדוק' },
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
    expect(accepted[0].kind).toBe('no_action');
    expect(accepted[0].title).toBe('בדוק לוג');
  });

  it('rejects a no_action with empty title', () => {
    const { accepted, rejected } = validateOptions([
      { kind: 'no_action', title: '', detail: 'test' },
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it('truncates a very long title to MAX_TITLE', () => {
    const longTitle = 'א'.repeat(200);
    const { accepted } = validateOptions([{ kind: 'no_action', title: longTitle }]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].title.length).toBeLessThanOrEqual(80 + 1); // +1 for ellipsis
  });
});

describe('validateOptions — param_change (FC ground bounds)', () => {
  it('rejects LAND_SPEED below FC_ADVISOR_WRITE_BOUNDS.min', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'too slow',
      change: { param: 'LAND_SPEED', from: 100, to: 49 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/out of safe range/);
  });

  it('accepts LAND_SPEED at FC_ADVISOR_WRITE_BOUNDS.min', () => {
    const { accepted, rejected } = validateOptions([{
      kind: 'param_change',
      title: 'min land speed',
      change: { param: 'LAND_SPEED', from: 80, to: FC_ADVISOR_WRITE_BOUNDS.LAND_SPEED.min },
    }]);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].change.to).toBe(FC_ADVISOR_WRITE_BOUNDS.LAND_SPEED.min);
  });
});

describe('validateOptions — param_change (Jetson)', () => {
  it('accepts a valid Jetson param change within range', () => {
    const spec = JETSON_PARAM_ALLOWLIST.get('flare_alt_m');
    const validValue = (spec.min + spec.max) / 2;
    const { accepted, rejected } = validateOptions([{
      kind: 'param_change',
      title: 'שנה flare_alt_m',
      change: { param: 'flare_alt_m', from: 8, to: validValue },
    }]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
    expect(accepted[0].target).toBe('jetson');
    expect(accepted[0].change.to).toBe(validValue);
  });

  it('rejects a value below safe range', () => {
    const spec = JETSON_PARAM_ALLOWLIST.get('flare_alt_m');
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'too low',
      change: { param: 'flare_alt_m', from: 8, to: spec.min - 5 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/out of safe range/);
  });

  it('rejects a value above safe range', () => {
    const spec = JETSON_PARAM_ALLOWLIST.get('approach_speed_ms');
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'too high',
      change: { param: 'approach_speed_ms', from: 16, to: spec.max + 20 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/out of safe range/);
  });

  it('rejects a denylisted param', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'try arming_check',
      change: { param: 'ARMING_CHECK', from: 1, to: 0 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/denylisted/);
  });

  it('rejects an unknown param', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'fake param',
      change: { param: 'FAKE_PARAM_XYZ', from: 1, to: 2 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/not in allowlist/);
  });

  it('rejects a no-op (from == to)', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'no-op',
      change: { param: 'flare_alt_m', from: 8, to: 8 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/no-op/);
  });

  it('rejects a non-finite to value', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'nan value',
      change: { param: 'flare_alt_m', from: 8, to: NaN },
    }]);
    expect(rejected).toHaveLength(1);
  });

  it('rejects future kinds (param_change_group)', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change_group',
      title: 'future',
      changes: [],
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/disabled or unknown kind/);
  });
});

describe('validateOptions — max options cap', () => {
  it('silently caps at 6 options', () => {
    const opts = Array.from({ length: 10 }, (_, i) => ({
      kind: 'no_action',
      title: `Option ${i}`,
    }));
    const { accepted } = validateOptions(opts);
    expect(accepted.length).toBeLessThanOrEqual(6);
  });
});

// ── validateSingleForApply ────────────────────────────────────────────────

describe('validateSingleForApply', () => {
  it('validates a clean param_change for apply', () => {
    const r = validateSingleForApply({
      kind: 'param_change',
      title: 'test',
      change: { param: 'abort_conf_min', from: 0.7, to: 0.75 },
    });
    expect(r.ok).toBe(true);
    expect(r.option.change.param).toBe('abort_conf_min');
  });

  it('rejects corrupt action object', () => {
    expect(validateSingleForApply(null).ok).toBe(false);
    expect(validateSingleForApply({ kind: 'read_log' }).ok).toBe(false);
  });
});

// ── assignActionIds ───────────────────────────────────────────────────────

describe('assignActionIds', () => {
  it('assigns unique IDs with issue prefix', () => {
    const opts = [
      { kind: 'no_action', title: 'A' },
      { kind: 'no_action', title: 'B' },
    ];
    const assigned = assignActionIds(opts, 42);
    expect(assigned[0].id).toMatch(/^a-42-/);
    expect(assigned[1].id).toMatch(/^a-42-/);
    expect(assigned[0].id).not.toBe(assigned[1].id);
  });

  it('uses "x" prefix when issueId is null', () => {
    const assigned = assignActionIds([{ kind: 'no_action', title: 'X' }], null);
    expect(assigned[0].id).toMatch(/^a-x-/);
  });
});

// ── buildParamAlternatives + apply value family ─────────────────────────

describe('buildParamAlternatives — discrete enum', () => {
  it('SERIAL3_PROTOCOL returns single enum option, not cautious/assertive', () => {
    expect(isDiscreteArduParam('SERIAL3_PROTOCOL')).toBe(true);
    const spec = { min: -1e9, max: 1e9 };
    const alts = buildParamAlternatives({
      param: 'SERIAL3_PROTOCOL',
      from: 5,
      primaryTo: 2,
      spec,
    });
    expect(alts).toHaveLength(1);
    expect(alts[0].to).toBe(2);
    expect(alts[0].enumLabel).toMatch(/MAVLink2/i);
    expect(formatDiscreteParamLabel('SERIAL3_PROTOCOL', 2)).toMatch(/MAVLink2/i);
  });

  it('rejects fractional enum value at validation', () => {
    const { rejected } = validateOptions([{
      kind: 'param_change',
      title: 'bad enum',
      change: { param: 'SERIAL3_PROTOCOL', from: 5, to: 2.38 },
    }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/enum/);
  });
});

describe('buildParamAlternatives — continuous', () => {
  it('produces 3 steps when from differs from primary', () => {
    const spec = JETSON_PARAM_ALLOWLIST.get('xtrack_gain');
    const alts = buildParamAlternatives({ from: 1.25, primaryTo: 1.05, spec });
    expect(alts.length).toBeGreaterThanOrEqual(2);
    const primary = alts.find((a) => a.isPrimary);
    expect(primary).toBeDefined();
    expect(primary.to).toBeCloseTo(1.05, 2);
  });

  it('returns only primary when from equals primary (no move)', () => {
    const spec = JETSON_PARAM_ALLOWLIST.get('vision_conf_min');
    const alts = buildParamAlternatives({ from: 0.7, primaryTo: 0.7, spec });
    expect(alts).toHaveLength(1);
    expect(alts[0].isPrimary).toBe(true);
  });
});

describe('isValueInParamProposalFamily', () => {
  it('accepts each graded to for the same (from, primaryTo)', () => {
    const spec = JETSON_PARAM_ALLOWLIST.get('xtrack_gain');
    const alts = buildParamAlternatives({ from: 1.2, primaryTo: 1.0, spec });
    for (const a of alts) {
      expect(
        isValueInParamProposalFamily('xtrack_gain', 1.2, 1.0, a.to),
      ).toBe(true);
    }
  });

  it('rejects arbitrary in-range value not in the tier list', () => {
    expect(
      isValueInParamProposalFamily('xtrack_gain', 1.25, 1.05, 1.12),
    ).toBe(false);
  });
});

// ── buildLLMActionSchemaBlock ─────────────────────────────────────────────

describe('buildLLMActionSchemaBlock', () => {
  it('mentions all Jetson params in the allowlist', () => {
    const block = buildLLMActionSchemaBlock();
    for (const param of JETSON_PARAM_ALLOWLIST.keys()) {
      expect(block).toContain(param);
    }
  });

  it('mentions FC ground params', () => {
    const block = buildLLMActionSchemaBlock();
    for (const param of FC_PARAM_ALLOWLIST_GROUND.keys()) {
      expect(block).toContain(param);
    }
  });

  it('does NOT mention denylisted params', () => {
    const block = buildLLMActionSchemaBlock();
    for (const p of PARAM_DENYLIST) {
      expect(block).not.toContain(p);
    }
  });
});

// ── parseStructuredReply ──────────────────────────────────────────────────

describe('parseStructuredReply', () => {
  it('parses a clean JSON reply', () => {
    const text = JSON.stringify({ reply: 'שלום', options: [{ kind: 'no_action', title: 'test' }] });
    const r = parseStructuredReply(text);
    expect(r).not.toBeNull();
    expect(r.reply).toBe('שלום');
    expect(r.options).toHaveLength(1);
  });

  it('extracts JSON embedded in markdown fences', () => {
    const text = 'Some prefix\n```json\n{"reply":"hello","options":[]}\n```\nSuffix';
    const r = parseStructuredReply(text);
    expect(r).not.toBeNull();
    expect(r.reply).toBe('hello');
  });

  it('returns null for empty string', () => {
    expect(parseStructuredReply('')).toBeNull();
    expect(parseStructuredReply(null)).toBeNull();
  });

  it('returns null for non-JSON string', () => {
    expect(parseStructuredReply('just some text with no JSON')).toBeNull();
  });

  it('returns null when reply and options are both empty', () => {
    expect(parseStructuredReply('{"reply":"","options":[]}')).toBeNull();
  });
});
