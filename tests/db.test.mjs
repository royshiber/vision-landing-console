import { describe, it, expect, afterAll } from 'vitest';
import { openDatabase } from '../lib/db.mjs';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('openDatabase', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-db-${Date.now()}.sqlite`);
  let db;

  it('פותח DB ויוצר את כל הטבלאות', () => {
    db = openDatabase(tmpPath);
    expect(db).toBeDefined();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('flights');
    expect(tables).toContain('flight_notes');
    expect(tables).toContain('log_artifacts');
    expect(tables).toContain('code_digest');
  });

  it('מכניס ומוציא טיסה', () => {
    db.prepare(`INSERT INTO flights (title) VALUES (?)`).run('טיסת בדיקה');
    const row = db.prepare(`SELECT * FROM flights WHERE title = ?`).get('טיסת בדיקה');
    expect(row).toBeDefined();
    expect(row.title).toBe('טיסת בדיקה');
  });

  it('מכניס הערת טייס ומוציא אותה', () => {
    const flight = db.prepare(`INSERT INTO flights (title) VALUES (?)`).run('טיסה 2');
    db.prepare(`INSERT INTO flight_notes (flight_id, body) VALUES (?, ?)`).run(flight.lastInsertRowid, 'בעיית נדנוד');
    const note = db.prepare(`SELECT * FROM flight_notes WHERE flight_id = ?`).get(flight.lastInsertRowid);
    expect(note.body).toBe('בעיית נדנוד');
  });

  it('מכניס code_digest ומוציא אותו', () => {
    db.prepare(`INSERT INTO code_digest (commit_sha, branch, files_changed_text, payload_json) VALUES (?,?,?,?)`).run(
      'abc123', 'main', 'server.js', '{}',
    );
    const row = db.prepare(`SELECT * FROM code_digest ORDER BY id DESC LIMIT 1`).get();
    expect(row.commit_sha).toBe('abc123');
    expect(row.branch).toBe('main');
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
  });
});
