import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.join(__dirname, '..');
export const dataDir = path.join(projectRoot, 'data');
export const uploadsDir = path.join(dataDir, 'uploads');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const dbPath = path.join(dataDir, 'vision-landing.sqlite');

/** Why: single process-local DB for flights, logs, notes, and GitHub code digest. What: opens SQLite and runs schema DDL once. */
export function openDatabase() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS flights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS flight_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (flight_id) REFERENCES flights(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS log_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flight_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('ardupilot','jetson')),
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime TEXT,
      size_bytes INTEGER,
      text_excerpt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (flight_id) REFERENCES flights(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS code_digest (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      commit_sha TEXT,
      branch TEXT,
      files_changed_text TEXT,
      payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_log_artifacts_flight ON log_artifacts(flight_id);
    CREATE INDEX IF NOT EXISTS idx_flight_notes_flight ON flight_notes(flight_id);
    CREATE INDEX IF NOT EXISTS idx_code_digest_received ON code_digest(received_at DESC);
  `);
  return db;
}
