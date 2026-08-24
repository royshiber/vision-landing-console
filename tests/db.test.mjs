import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
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
    expect(tables).toContain('aircraft_model_assets');
    expect(tables).toContain('connections');
    const connCols = db.prepare(`PRAGMA table_info(connections)`).all().map((c) => c.name);
    expect(connCols).toEqual(expect.arrayContaining([
      'id', 'name', 'type', 'host', 'port', 'serial_port', 'baud_rate', 'active', 'last_connected',
    ]));
  });

  it('שומר פרופיל חיבור ומחזיר אותו', () => {
    const empty = db.prepare(`SELECT * FROM connections ORDER BY active DESC, id DESC`).all();
    expect(empty).toEqual([]);
    const ins = db.prepare(
      `INSERT INTO connections (name, type, host, port, serial_port, baud_rate) VALUES (?,?,?,?,?,?)`,
    ).run('SITL UDP', 'udp', '127.0.0.1', 14550, null, 57600);
    expect(Number(ins.lastInsertRowid)).toBeGreaterThan(0);
    const row = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(ins.lastInsertRowid);
    expect(row.name).toBe('SITL UDP');
    expect(row.type).toBe('udp');
    expect(row.host).toBe('127.0.0.1');
    expect(row.port).toBe(14550);
    expect(row.active).toBe(0);
    db.prepare(`UPDATE connections SET
      name       = COALESCE(?, name),
      type       = COALESCE(?, type),
      host       = COALESCE(?, host),
      port       = COALESCE(?, port),
      serial_port= COALESCE(?, serial_port),
      baud_rate  = COALESCE(?, baud_rate)
      WHERE id = ?`).run('SITL UDP 2', null, null, 14551, null, null, ins.lastInsertRowid);
    const patched = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(ins.lastInsertRowid);
    expect(patched.name).toBe('SITL UDP 2');
    expect(patched.port).toBe(14551);
    expect(patched.type).toBe('udp');
    db.prepare(`DELETE FROM connections WHERE id = ?`).run(ins.lastInsertRowid);
    expect(db.prepare(`SELECT id FROM connections WHERE id = ?`).get(ins.lastInsertRowid)).toBeUndefined();
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

describe('openDatabase additive connections table', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-db-old-${Date.now()}.sqlite`);

  it('מוסיף את הטבלה למסד ישן בלי למחוק נתונים', () => {
    const raw = new Database(tmpPath);
    raw.exec(`CREATE TABLE flights (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)`);
    raw.prepare(`INSERT INTO flights (title) VALUES (?)`).run('טיסה ישנה');
    raw.close();

    const migrated = openDatabase(tmpPath);
    const tables = migrated.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('connections');
    const flight = migrated.prepare(`SELECT title FROM flights`).get();
    expect(flight.title).toBe('טיסה ישנה');
    const empty = migrated.prepare(`SELECT * FROM connections`).all();
    expect(empty).toEqual([]);
    migrated.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* wal cleanup */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* shm cleanup */ }
  });
});
