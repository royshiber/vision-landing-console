import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import {
  createSessionDebrief,
  findRelevantEngineerMemory,
  formatEngineerMemoryForPrompt,
  recordEngineerEvent,
  upsertProfileFact,
} from '../lib/engineer-memory.mjs';

describe('engineer-memory', () => {
  const tmpPath = path.join(os.tmpdir(), `test-engineer-memory-${Date.now()}.sqlite`);
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  it('creates engineer memory tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('engineer_profile');
    expect(tables).toContain('engineer_events');
    expect(tables).toContain('engineer_session_debriefs');
  });

  it('stores profile facts and formats them for prompt context', () => {
    upsertProfileFact(db, 'pilot.prefers_soft_landings', 'true', { confidence: 0.9, source: 'test' });
    const memory = findRelevantEngineerMemory(db, 'אני רוצה נחיתה רכה', {});
    const block = formatEngineerMemoryForPrompt(memory);
    expect(block).toContain('pilot.prefers_soft_landings=true');
    expect(block).toContain('PROFILE FACTS');
  });

  it('retrieves relevant historical events', () => {
    const id = recordEngineerEvent(db, {
      sessionId: 's1',
      eventType: 'gps_glitch',
      summary: 'היה כשל GPS קצר בפנייה מערבית בגובה 70 מטר',
      tags: 'gps,altitude',
    });
    expect(id).toBeGreaterThan(0);
    const memory = findRelevantEngineerMemory(db, 'זה כשל GPS שקרה לנו כבר?', {});
    expect(memory.events.some((e) => e.summary.includes('כשל GPS'))).toBe(true);
    expect(formatEngineerMemoryForPrompt(memory)).toContain('RELEVANT PAST EVENTS');
  });

  it('creates session debrief without deleting notes', () => {
    db.prepare(`
      INSERT INTO engineer_notes (session_id, content, category)
      VALUES ('s2', 'הטייס ביקש התראות רק מעל 50 מטר', 'preference')
    `).run();
    const result = createSessionDebrief(
      db,
      's2',
      [
        { role: 'user', content: 'אני מעדיף נחיתות רכות' },
        { role: 'engineer', content: 'נרשם' },
      ],
      [{ content: 'הטייס ביקש התראות רק מעל 50 מטר' }],
      { telemetry: { armed: false } },
    );
    expect(result.summary).toContain('סשן s2');
    const note = db.prepare(`SELECT content FROM engineer_notes WHERE session_id = 's2'`).get();
    expect(note.content).toContain('התראות');
    const debrief = db.prepare(`SELECT summary FROM engineer_session_debriefs WHERE session_id = 's2'`).get();
    expect(debrief.summary).toContain('נחיתות רכות');
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp cleanup */ }
  });
});
