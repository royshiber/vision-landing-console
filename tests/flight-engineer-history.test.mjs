import { describe, it, expect } from 'vitest';
import { normalizeEngineerClientHistory } from '../lib/flight-engineer.mjs';

describe('normalizeEngineerClientHistory', () => {
  it('removes trailing user turn when it duplicates current text', () => {
    const h = [
      { role: 'user', content: 'שלום' },
      { role: 'engineer', content: 'היי' },
      { role: 'user', content: 'מה המצב?' },
    ];
    expect(normalizeEngineerClientHistory(h, 'מה המצב?')).toEqual([
      { role: 'user', content: 'שלום' },
      { role: 'engineer', content: 'היי' },
    ]);
  });

  it('keeps history when last turn is not a duplicate of current text', () => {
    const h = [{ role: 'user', content: 'קודם' }, { role: 'engineer', content: 'סבבה' }];
    expect(normalizeEngineerClientHistory(h, 'משהו אחר')).toEqual(h);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeEngineerClientHistory([], 'x')).toEqual([]);
  });
});
