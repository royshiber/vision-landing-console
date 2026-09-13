import { describe, expect, it } from 'vitest';
import {
  BIDI_FSI,
  BIDI_PDI,
  BIDI_RLM,
  isolateLtrToken,
  rtlMarkEndPunct,
  rtlSafeAskText,
} from '../lib/rtl-bidi.mjs';

describe('RTL-safe Ask string helpers', () => {
  it('isolates an LTR product name between FSI and PDI', () => {
    expect(isolateLtrToken('AIRVIX Ask')).toBe(`${BIDI_FSI}AIRVIX Ask${BIDI_PDI}`);
    expect(isolateLtrToken('GO')).toBe(`${BIDI_FSI}GO${BIDI_PDI}`);
    expect(isolateLtrToken('')).toBe('');
  });

  it('anchors trailing ASCII punctuation with RLM so it stays at the RTL end', () => {
    expect(rtlMarkEndPunct('הסוכן מנותק.')).toBe(`הסוכן מנותק${BIDI_RLM}.`);
    expect(rtlMarkEndPunct('חברו מפתח כדי לאשר שינוי.')).toBe(`חברו מפתח כדי לאשר שינוי${BIDI_RLM}.`);
    expect(rtlMarkEndPunct('שאלו את AIRVIX Ask.')).toBe(`שאלו את AIRVIX Ask${BIDI_RLM}.`);
  });

  it('keeps locked Ask / GO wording and only wraps the English tokens', () => {
    const invite = rtlSafeAskText('שאלו את AIRVIX Ask, רשמו הערה, או תצפית.');
    expect(invite).toContain(`${BIDI_FSI}AIRVIX Ask${BIDI_PDI}`);
    expect(invite.startsWith('שאלו את ')).toBe(true);
    expect(invite).toContain('רשמו הערה, או תצפית');
    expect(invite.endsWith(`${BIDI_RLM}.`)).toBe(true);
    expect(invite).not.toContain('מסייע');

    const endGo = rtlSafeAskText('סיום GO');
    expect(endGo).toBe(`סיום ${BIDI_FSI}GO${BIDI_PDI}`);
    expect(endGo).not.toMatch(/^GO/);
  });
});
