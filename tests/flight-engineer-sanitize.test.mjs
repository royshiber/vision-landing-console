import { describe, it, expect } from 'vitest';
import {
  sanitizeEngineerReply,
  maybeShortCircuitUnclearPilotTurn,
  guardReplyAgainstSttHallucination,
  pilotUtteranceLocale,
  tryExtractDirectPilotNote,
  synthesizeFallbackFromEngineerActions,
} from '../lib/flight-engineer.mjs';

describe('pilotUtteranceLocale', () => {
  it('treats plain English as en', () => {
    expect(pilotUtteranceLocale('hi can you hear me')).toBe('en');
  });

  it('detects Hebrew letters', () => {
    expect(pilotUtteranceLocale('שלום')).toBe('he');
  });
});

describe('sanitizeEngineerReply', () => {
  it('treats ASCII Unknown. as shrug and returns English when pilot is English', () => {
    const out = sanitizeEngineerReply('Unknown.', 'what do you know', {
      telemetry: { connected: false },
      memory: '',
    });
    expect(out).not.toMatch(/^\.?Unknown/i);
    expect(out.length).toBeGreaterThan(20);
    expect(out).toMatch(/telemetry|FC|Jetson/i);
  });

  it('normalizes RLM + Unknown. so it is still caught', () => {
    const out = sanitizeEngineerReply('\u200fUnknown.', 'what is your name', {
      telemetry: { connected: false },
      memory: '',
    });
    expect(out).not.toContain('Unknown');
  });

  it('normalizes NFKC fullwidth stop Unknown．', () => {
    const out = sanitizeEngineerReply('Unknown．', 'hi', {
      telemetry: { connected: false },
      memory: '',
    });
    expect(out.length).toBeGreaterThan(20);
  });
});

describe('maybeShortCircuitUnclearPilotTurn', () => {
  it('short-circuits lone opaque English token', () => {
    const out = maybeShortCircuitUnclearPilotTurn('Sheltie');
    expect(out).not.toBeNull();
    expect(out.text.length).toBeGreaterThan(30);
  });

  it('allows known aviation token', () => {
    expect(maybeShortCircuitUnclearPilotTurn('RTL')).toBeNull();
    expect(maybeShortCircuitUnclearPilotTurn('GPS')).toBeNull();
  });

  it('does not block Hebrew single word', () => {
    expect(maybeShortCircuitUnclearPilotTurn('מה')).toBeNull();
  });

  it('does not block Chinese single character', () => {
    expect(maybeShortCircuitUnclearPilotTurn('飞')).toBeNull();
  });
});

describe('tryExtractDirectPilotNote', () => {
  it('captures english remember-that journaling line', () => {
    expect(tryExtractDirectPilotNote(
      'Remember that the plane banked about five degrees to the left.',
    )).toEqual({
      body: 'the plane banked about five degrees to the left.',
      category: 'general',
    });
  });

  it('captures english flight-note colon cue', () => {
    expect(tryExtractDirectPilotNote('Flight note — mild crosswind push on short final')).toEqual({
      body: 'mild crosswind push on short final',
      category: 'general',
    });
  });

  it('captures conversational save flight note wording', () => {
    expect(tryExtractDirectPilotNote(
      'I want to save a flight note — VIO jitter right before flare.',
    )).toEqual({
      body: 'VIO jitter right before flare.',
      category: 'general',
    });
  });

  it('returns null for remember-to infinitives', () => {
    expect(tryExtractDirectPilotNote('Remember to check ARSPD_USE before flight.')).toBeNull();
  });

  it('returns null when english adds a live follow-up question', () => {
    expect(
      tryExtractDirectPilotNote(
        'Remember that rollout was long — and explain what changes LAND_* first.',
      ),
    ).toBeNull();
  });
});

describe('synthesizeFallbackFromEngineerActions', () => {
  it('fills speakable acknowledgement after tool-only Gemini turn (save_note)', () => {
    expect(
      synthesizeFallbackFromEngineerActions('en', [
        { type: 'save_note', note_id: 9, content: 'banked five degrees left', category: 'general' },
      ]),
    ).toContain('banked five');
    expect(synthesizeFallbackFromEngineerActions('en', [{ type: 'save_note', content: 'x' }])).toMatch(/^Noted/);
    expect(synthesizeFallbackFromEngineerActions('he', [{ type: 'save_note', content: 'בדיקה' }])).toMatch(/פנקס/);
    expect(synthesizeFallbackFromEngineerActions('zh', [{ type: 'save_note', content: '侧风稍大' }])).toContain('记录');
  });
});

describe('guardReplyAgainstSttHallucination', () => {
  it('strips invented geography when disconnected', () => {
    const raw =
      'Hello Sheltie. Mama\'s Park in Utah — no GPS live because FC offline.';
    const out = guardReplyAgainstSttHallucination(raw, 'Sheltie', { connected: false });
    expect(out).not.toMatch(/Utah/i);
    expect(out.length).toBeGreaterThan(20);
  });

  it('allows Utah when pilot said Utah', () => {
    const raw = 'Flying near Utah border.';
    const out = guardReplyAgainstSttHallucination(raw, 'route Utah test', { connected: false });
    expect(out).toContain('Utah');
  });
});
