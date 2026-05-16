/**
 * Session Baseline — logical session tracking for "what changed since I started?".
 *
 * A "session" is a logical time window defined by the first advisor interaction
 * (or explicit `openSession` call) until the pilot closes / new session starts.
 * Sessions are server-side, not browser tab-tied — they survive page reloads.
 *
 * API:
 *   openSession(db, {jetsonProfile, fcParams}) -> sessionId
 *   getActiveSession(db) -> row | null
 *   closeSession(db, sessionId)
 *   getPendingChanges(db, sessionId, {jetsonProfile, fcParams}) -> {changes, snapshotId}
 *   revertAllChanges(db, sessionId, {jetsonProfile, mavConn}) -> {reverted[], errors[]}
 */

import { isFcArmed } from './advisor-apply.mjs';
import { logger } from './logger.mjs';

/** A session is "active" when closed_at IS NULL. Only one at a time. */
export function getActiveSession(db) {
  return db.prepare(
    `SELECT sb.*, pj.payload_json AS jetson_snapshot, pf.payload_json AS fc_snapshot
     FROM session_baselines sb
     LEFT JOIN param_snapshots pj ON pj.id = sb.jetson_snapshot_id
     LEFT JOIN param_snapshots pf ON pf.id = sb.fc_snapshot_id
     WHERE sb.closed_at IS NULL
     ORDER BY sb.id DESC LIMIT 1`,
  ).get();
}

/**
 * Open a new session, capturing current known param values as the baseline.
 * If an active session already exists, returns it (idempotent).
 */
export function openSession(db, { jetsonProfile = null, fcParams = null, reason = 'auto' } = {}) {
  const existing = getActiveSession(db);
  if (existing) return { sessionId: existing.id, created: false };

  // Snapshot Jetson profile as of now.
  const jetsonSnap = JSON.stringify(jetsonProfile || {});
  const fcSnap = JSON.stringify(fcParams || {});

  const info = db.prepare(
    `INSERT INTO param_snapshots (kind, target, payload_json, reason) VALUES ('session_baseline', 'jetson', ?, ?)`,
  ).run(jetsonSnap, `session-open ${reason}`);
  const jetsonSnapId = info.lastInsertRowid;

  let fcSnapId = null;
  if (fcParams && Object.keys(fcParams).length > 0) {
    const fi = db.prepare(
      `INSERT INTO param_snapshots (kind, target, payload_json, reason) VALUES ('session_baseline', 'fc', ?, ?)`,
    ).run(fcSnap, `session-open ${reason}`);
    fcSnapId = fi.lastInsertRowid;
  }

  const si = db.prepare(
    `INSERT INTO session_baselines (jetson_snapshot_id, fc_snapshot_id, reason) VALUES (?, ?, ?)`,
  ).run(jetsonSnapId, fcSnapId, reason);

  logger.info({ sessionId: si.lastInsertRowid, reason }, 'session opened');
  return { sessionId: si.lastInsertRowid, created: true };
}

/** Mark session as closed. */
export function closeSession(db, sessionId) {
  db.prepare(`UPDATE session_baselines SET closed_at = datetime('now') WHERE id = ?`).run(sessionId);
  logger.info({ sessionId }, 'session closed');
}

/**
 * Calculate diff between the session-opening baseline and current param values.
 * Returns a list of { param, target, baseline, current, delta } for every param
 * that has changed.
 *
 * This is the data the pre-arm banner and audit viewer display.
 */
export function getPendingChanges(db, sessionId, { jetsonProfile = null } = {}) {
  const session = db.prepare(
    `SELECT sb.*, pj.payload_json AS jetson_snapshot
     FROM session_baselines sb
     LEFT JOIN param_snapshots pj ON pj.id = sb.jetson_snapshot_id
     WHERE sb.id = ?`,
  ).get(sessionId);
  if (!session) return { changes: [], sessionId };

  let baseline = {};
  try { baseline = JSON.parse(session.jetson_snapshot || '{}'); } catch { baseline = {}; }

  const current = jetsonProfile || {};
  const changes = [];
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const param of allKeys) {
    const base = baseline[param];
    const curr = current[param];
    if (base == null && curr == null) continue;
    const delta = curr != null && base != null ? Number(curr) - Number(base) : null;
    if (delta == null || Math.abs(delta) > 1e-6) {
      changes.push({
        param,
        target: 'jetson',
        baseline: base != null ? Number(base) : null,
        current: curr != null ? Number(curr) : null,
        delta,
      });
    }
  }
  return { changes, sessionId };
}

/**
 * Find all applied advisor actions in the current session, extract their
 * snapshot IDs, and revert each one.
 * Returns { reverted, errors }.
 */
export async function revertAllChanges(db, sessionId, { mavConn = null, appVersion = null } = {}) {
  const session = db.prepare(
    `SELECT * FROM session_baselines WHERE id = ?`,
  ).get(sessionId);
  if (!session) return { reverted: [], errors: [{ error: 'session not found' }] };

  const applied = db.prepare(
    `SELECT ca.id AS action_id, ca.payload_json, ps.id AS snap_id, ps.payload_json AS snap_json, ps.target
     FROM chat_actions ca
     JOIN param_snapshots ps ON ps.reason = ('pre-apply ' || ca.id)
     WHERE ca.state = 'applied'
       AND ca.created_at >= (SELECT created_at FROM session_baselines WHERE id = ?)
     ORDER BY ca.created_at DESC`,
  ).all(sessionId);

  const reverted = [];
  const errors = [];

  for (const row of applied) {
    try {
      let snap;
      try { snap = JSON.parse(row.snap_json || '{}'); } catch { snap = {}; }
      const param = snap.param;
      const restoreValue = snap.value;
      if (!param || restoreValue == null) { errors.push({ actionId: row.action_id, error: 'invalid snapshot' }); continue; }

      if (row.target === 'jetson') {
        db.prepare(
          `INSERT INTO jetson_profile (param, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(param) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(param, restoreValue);
        db.prepare(
          `UPDATE chat_actions SET state = 'rolled_back', rolled_back_at = datetime('now') WHERE id = ?`,
        ).run(row.action_id);
        reverted.push({ actionId: row.action_id, param, target: 'jetson', restoredTo: restoreValue });
      } else if (row.target === 'fc') {
        if (!mavConn || typeof mavConn.setParam !== 'function') {
          errors.push({ actionId: row.action_id, error: 'FC not connected for rollback' });
          continue;
        }
        const armed = isFcArmed(mavConn);
        if (armed === true) {
          errors.push({ actionId: row.action_id, error: 'cannot rollback FC param while ARMED' });
          continue;
        }
        const r = await mavConn.setParam(param, restoreValue, { timeoutMs: 3000 });
        if (!r || !r.ok) { errors.push({ actionId: row.action_id, error: r?.error || 'no echo' }); continue; }
        db.prepare(
          `UPDATE chat_actions SET state = 'rolled_back', rolled_back_at = datetime('now') WHERE id = ?`,
        ).run(row.action_id);
        reverted.push({ actionId: row.action_id, param, target: 'fc', restoredTo: restoreValue });
      }
    } catch (err) {
      errors.push({ actionId: row.action_id, error: err?.message || String(err) });
    }
  }

  logger.info({ sessionId, reverted: reverted.length, errors: errors.length }, 'revert-all complete');
  return { reverted, errors };
}

/**
 * Returns the unapplied pending-changes diff usable by the pre-arm banner.
 * Returns { pendingCount, session } — client shows banner if pendingCount > 0.
 */
export function getPendingChangesSummary(db, { jetsonProfile = null } = {}) {
  const session = getActiveSession(db);
  if (!session) return { pendingCount: 0, session: null };
  const { changes } = getPendingChanges(db, session.id, { jetsonProfile });
  return { pendingCount: changes.length, session, changes };
}
