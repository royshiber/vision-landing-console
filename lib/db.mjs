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

const defaultDbPath = path.join(dataDir, 'vision-landing.sqlite');

/**
 * Why: default path is `data/vision-landing.sqlite`; tests pass a temp file; optional env `SQLITE_PATH` or `DATABASE_PATH` for ops.
 * What: opens SQLite, ensures parent directory exists, runs schema DDL once.
 * @param {string} [dbFilePath]  when set (e.g. tests), used instead of env/default
 */
export function openDatabase(dbFilePath) {
  const resolved =
    typeof dbFilePath === 'string' && dbFilePath.length > 0
      ? dbFilePath
      : (() => {
          const fromEnv = String(process.env.SQLITE_PATH || process.env.DATABASE_PATH || '').trim();
          return fromEnv || defaultDbPath;
        })();
  if (resolved !== ':memory:') {
    const parent = path.dirname(path.resolve(resolved));
    if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 8000');
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

    /** Why: give the advisor persistent memory of previously-encountered issues + which versions they happened on.
     *  What: one row per distinct issue (auto-grouped from chat turns); linked back to chat_messages for full transcript. */
    CREATE TABLE IF NOT EXISTS chat_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      title TEXT,
      summary TEXT NOT NULL,
      resolution TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      tags TEXT,
      app_version TEXT,
      agent_version TEXT,
      internal_fw_version TEXT,
      fc_firmware_version TEXT,
      params_snapshot TEXT,
      hit_count INTEGER NOT NULL DEFAULT 1,
      last_question TEXT,
      last_reply TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER,
      role TEXT NOT NULL CHECK(role IN ('user','advisor')),
      message TEXT NOT NULL,
      is_resolved INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      app_version TEXT,
      agent_version TEXT,
      internal_fw_version TEXT,
      fc_firmware_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (issue_id) REFERENCES chat_issues(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_issue ON chat_messages(issue_id);
    CREATE INDEX IF NOT EXISTS idx_chat_issues_status ON chat_issues(status, updated_at DESC);

    /** Why: persist every proposed advisor option so the client can later refer back to it by ID
     *  (apply / dismiss / audit). Server assigns the ID; LLM has no control over it. */
    CREATE TABLE IF NOT EXISTS chat_actions (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      issue_id      INTEGER,
      message_id    INTEGER,
      kind          TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      accepted      INTEGER NOT NULL DEFAULT 1,
      reject_reason TEXT,
      state         TEXT NOT NULL DEFAULT 'proposed',
      applied_at    TEXT,
      rolled_back_at TEXT,
      FOREIGN KEY (issue_id)   REFERENCES chat_issues(id)   ON DELETE SET NULL,
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_actions_issue ON chat_actions(issue_id, created_at DESC);

    /** Why: append-only audit trail of EVERY parameter change applied via the advisor.
     *  Append-only means NEVER UPDATE/DELETE these rows except by DB maintenance — this is the
     *  long-term forensic record that lets the advisor answer "what changed in the last N weeks?".
     *  See docs/ADVISOR_SAFETY.md §8. */
    CREATE TABLE IF NOT EXISTS param_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      issue_id     INTEGER,
      action_id    TEXT,
      kind         TEXT NOT NULL,
      target       TEXT NOT NULL,
      param        TEXT NOT NULL,
      value_from   REAL,
      value_to     REAL,
      fc_armed     INTEGER,
      fc_firmware  TEXT,
      app_version  TEXT,
      verified     INTEGER NOT NULL DEFAULT 0,
      error        TEXT,
      snapshot_id  INTEGER,
      group_id     TEXT,
      note         TEXT,
      FOREIGN KEY (issue_id) REFERENCES chat_issues(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_param_audit_date  ON param_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_param_audit_param ON param_audit(param, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_param_audit_issue ON param_audit(issue_id, created_at DESC);

    /** Why: per-apply snapshot so every change is individually reversible without relying on
     *  the LLM-provided 'from' value (which must not be trusted as source of truth). */
    CREATE TABLE IF NOT EXISTS param_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      kind         TEXT NOT NULL,
      target       TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      reason       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_param_snapshots_date ON param_snapshots(created_at DESC);

    /** Why: session baseline — captured at first advisor interaction of a session, used to show
     *  the pilot "you have N pending changes from the baseline of this session" and for one-click
     *  revert-all. Sessions are logical (time-windowed) rather than literal login sessions. */
    CREATE TABLE IF NOT EXISTS session_baselines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at    TEXT,
      jetson_snapshot_id INTEGER,
      fc_snapshot_id     INTEGER,
      reason       TEXT,
      FOREIGN KEY (jetson_snapshot_id) REFERENCES param_snapshots(id) ON DELETE SET NULL,
      FOREIGN KEY (fc_snapshot_id)     REFERENCES param_snapshots(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_baselines_date ON session_baselines(created_at DESC);

    /** Why: server-side canonical record of current Jetson-side profile values.
     *  Clients sync FROM this on load; applies go THROUGH this. Without it the "what did I change?"
     *  memory cannot survive a browser localStorage wipe. */
    CREATE TABLE IF NOT EXISTS jetson_profile (
      param        TEXT PRIMARY KEY,
      value        REAL NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Forward-only migration: old DBs may miss per-question resolve flag.
  try {
    const cols = db.prepare(`PRAGMA table_info(chat_messages)`).all();
    if (!cols.some((c) => c && c.name === 'is_resolved')) {
      db.exec(`ALTER TABLE chat_messages ADD COLUMN is_resolved INTEGER NOT NULL DEFAULT 0;`);
    }
  } catch {
    // best-effort migration; schema stays usable even without this column
  }

  // Enforce append-only semantics at the DB layer. Triggers are a belt-and-suspenders guard
  // in addition to the code-level discipline documented in docs/ADVISOR_SAFETY.md §8.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_param_audit_no_update
      BEFORE UPDATE ON param_audit
    BEGIN
      SELECT RAISE(ABORT, 'param_audit is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_param_audit_no_delete
      BEFORE DELETE ON param_audit
    BEGIN
      SELECT RAISE(ABORT, 'param_audit is append-only');
    END;

    /** Why: general-purpose key-value store for persistent server configuration.
     *  Replaces in-memory objects (visionProfileStore, arduTargetParams, etc.) that
     *  were lost on every server restart. Values are JSON-encoded. */
    CREATE TABLE IF NOT EXISTS server_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /** Why: terrain coverage cells are now persisted so a server restart no longer
     *  loses the entire mapped area. One row per unique GPS+alt cell. */
    CREATE TABLE IF NOT EXISTS terrain_cells (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lat        REAL    NOT NULL,
      lon        REAL    NOT NULL,
      alt_m      REAL,
      heading    REAL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_terrain_cells_latlon ON terrain_cells(lat, lon);

    /** Why: Feature Designer — each row is one AI-designed custom ArduPilot feature,
     *  including the generated C++ code and iterative conversation history. */
    CREATE TABLE IF NOT EXISTS custom_features (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      cpp_code          TEXT NOT NULL DEFAULT '',
      conversation_json TEXT NOT NULL DEFAULT '[]',
      status            TEXT NOT NULL DEFAULT 'draft',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_custom_features_status ON custom_features(status, updated_at DESC);

    /** Why: each custom feature exposes named parameters with metadata, mirroring the
     *  official ArduPilot param schema so they integrate into the existing search UI. */
    CREATE TABLE IF NOT EXISTS custom_params (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id    INTEGER NOT NULL,
      param_key     TEXT    NOT NULL UNIQUE,
      display_name  TEXT    NOT NULL,
      description   TEXT    NOT NULL DEFAULT '',
      param_type    TEXT    NOT NULL DEFAULT 'FLOAT',
      default_value REAL    NOT NULL DEFAULT 0,
      current_value REAL    NOT NULL DEFAULT 0,
      units         TEXT,
      min_val       REAL,
      max_val       REAL,
      FOREIGN KEY (feature_id) REFERENCES custom_features(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_custom_params_feature ON custom_params(feature_id);
    CREATE INDEX IF NOT EXISTS idx_custom_params_key    ON custom_params(param_key);
  `);

  // Additive migration: description_he column (added after initial release)
  try {
    db.exec("ALTER TABLE custom_params ADD COLUMN description_he TEXT NOT NULL DEFAULT ''");
  } catch { /* column already exists — safe to ignore */ }

  // Additive migration: Flight Engineer voice session notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS engineer_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      ts          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      content     TEXT    NOT NULL,
      category    TEXT    NOT NULL DEFAULT 'general'
    );
    CREATE INDEX IF NOT EXISTS idx_engineer_notes_session ON engineer_notes(session_id, ts DESC);

    /** Why: persistent Flight Engineer persona memory. What: stable pilot / vehicle facts
     *  that should survive sessions, e.g. "pilot prefers soft landings" or vehicle name. */
    CREATE TABLE IF NOT EXISTS engineer_profile (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      source     TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_engineer_profile_updated ON engineer_profile(updated_at DESC);

    /** Why: historical operational memory for "did this happen before?" questions.
     *  What: compact, timestamped flight events with optional telemetry / params snapshots. */
    CREATE TABLE IF NOT EXISTS engineer_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT,
      event_type     TEXT NOT NULL DEFAULT 'general',
      summary        TEXT NOT NULL,
      tags           TEXT,
      telemetry_json TEXT,
      params_json    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_engineer_events_session ON engineer_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engineer_events_type    ON engineer_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engineer_events_tags    ON engineer_events(tags);

    /** Why: post-flight / post-session debriefs become the next session's prior context.
     *  What: one compact summary per engineer session. */
    CREATE TABLE IF NOT EXISTS engineer_session_debriefs (
      session_id   TEXT PRIMARY KEY,
      summary      TEXT NOT NULL,
      lessons_json TEXT NOT NULL DEFAULT '[]',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_engineer_debriefs_created ON engineer_session_debriefs(created_at DESC);

    /** Why: pilot-uploaded aircraft photos + imported GLB for planned sim-lab mesh pipeline.
     *  What: one row per stored file under data/uploads; processing_job_id reserved for external mesh APIs. */
    CREATE TABLE IF NOT EXISTS aircraft_model_assets (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name     TEXT    NOT NULL,
      stored_path       TEXT    NOT NULL,
      mime              TEXT,
      size_bytes        INTEGER,
      asset_kind        TEXT    NOT NULL CHECK(asset_kind IN ('photo','glb','gltf_zip','other')),
      notes             TEXT,
      processing_job_id TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_aircraft_model_assets_created ON aircraft_model_assets(created_at DESC);
  `);

  return db;
}

/**
 * Read a JSON-encoded value from server_config.
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {*} defaultVal  returned when key is absent
 */
export function getConfig(db, key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM server_config WHERE key = ?').get(key);
  if (!row) return defaultVal;
  try {
    return JSON.parse(row.value);
  } catch {
    return defaultVal;
  }
}

/**
 * Upsert a JSON-encoded value into server_config.
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {*} value  must be JSON-serialisable
 */
export function setConfig(db, key, value) {
  db.prepare(`
    INSERT INTO server_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE
      SET value = excluded.value,
          updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}
