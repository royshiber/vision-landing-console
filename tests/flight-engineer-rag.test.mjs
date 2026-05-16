import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import { buildAdvisorParityContextForEngineer } from '../lib/flight-engineer.mjs';

describe('buildAdvisorParityContextForEngineer', () => {
  const tmpPath = path.join(os.tmpdir(), `test-flight-engineer-rag-${Date.now()}.sqlite`);
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  afterAll(() => {
    try { db?.close?.(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('returns a block containing advisor-parity section headers', async () => {
    const block = await buildAdvisorParityContextForEngineer(db, 'LAND_SPEED נחיתה', { flightId: null });
    expect(block).toContain('ADVISOR KNOWLEDGE');
    expect(block).toContain('Tier A');
    expect(block).toContain('Parameter Reference');
  });
});
