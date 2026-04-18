import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase } from '../lib/db.mjs';
import { buildRetrievalContext, getLatestCodeDigest } from '../lib/retrieval.mjs';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('buildRetrievalContext', () => {
  const tmpPath = path.join(os.tmpdir(), `test-retrieval-${Date.now()}.sqlite`);
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
    const flight = db.prepare(`INSERT INTO flights (title) VALUES (?)`).run('טיסת בדיקה');
    db.prepare(`INSERT INTO flight_notes (flight_id, body) VALUES (?, ?)`).run(flight.lastInsertRowid, 'בעיית נדנוד בסוף הגישה');
    db.prepare(`INSERT INTO flight_notes (flight_id, body) VALUES (?, ?)`).run(flight.lastInsertRowid, 'ירידה בביטחון גילוי');
  });

  it('מוצא הערות רלוונטיות לשאלה', () => {
    const { block, meta } = buildRetrievalContext(db, 'נדנוד בגישה');
    expect(meta.notes).toBeGreaterThan(0);
    expect(block).toContain('נדנוד');
  });

  it('מוצא הערות לפי מילה אחרת', () => {
    const { block, meta } = buildRetrievalContext(db, 'ביטחון גילוי');
    expect(meta.notes).toBeGreaterThan(0);
    expect(block).toContain('ביטחון');
  });

  it('מחזיר הודעת "אין מילות מפתח" כשהשאלה ריקה', () => {
    const { block } = buildRetrievalContext(db, '');
    expect(block).toContain('אין מילות מפתח');
  });

  it('מסנן לפי flightId', () => {
    const { meta } = buildRetrievalContext(db, 'נדנוד', { flightId: 9999 });
    expect(meta.notes).toBe(0);
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
  });
});

describe('getLatestCodeDigest', () => {
  const tmpPath = path.join(os.tmpdir(), `test-digest-${Date.now()}.sqlite`);
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  it('מחזיר undefined כשאין digest', () => {
    const result = getLatestCodeDigest(db);
    expect(result).toBeUndefined();
  });

  it('מחזיר את ה-digest האחרון', () => {
    db.prepare(`INSERT INTO code_digest (commit_sha, branch, files_changed_text, payload_json) VALUES (?,?,?,?)`).run(
      'abc123', 'main', 'server.js\napp.js', '{"files":["server.js"]}',
    );
    db.prepare(`INSERT INTO code_digest (commit_sha, branch, files_changed_text, payload_json) VALUES (?,?,?,?)`).run(
      'def456', 'main', 'lib/db.mjs', '{}',
    );
    const result = getLatestCodeDigest(db);
    expect(result).toBeDefined();
    expect(result.commit_sha).toBe('def456');
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
  });
});
