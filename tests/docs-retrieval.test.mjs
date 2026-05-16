/**
 * Unit tests for lib/docs-retrieval.mjs
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildDocsRetrievalContext, resetDocsIndexForTests } from '../lib/docs-retrieval.mjs';

describe('buildDocsRetrievalContext', () => {
  beforeEach(() => {
    resetDocsIndexForTests();
  });

  it('returns matching excerpts for advisor safety keywords', () => {
    const { block, meta } = buildDocsRetrievalContext('advisor safety trust boundary denylist', { limit: 6 });
    expect(meta.chunks).toBeGreaterThan(0);
    expect(meta.used).toBeGreaterThan(0);
    expect(block).toMatch(/ADVISOR_SAFETY|trust|denylist|Risk/i);
  });

  it('returns empty-match message for nonsense query with no overlap', () => {
    const { block, meta } = buildDocsRetrievalContext('zzzzqqqqxxxx', { limit: 6 });
    expect(meta.used).toBe(0);
    expect(block).toMatch(/לא נמצאו התאמות/);
  });
});
