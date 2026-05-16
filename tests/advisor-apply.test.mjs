/**
 * Integration tests for lib/advisor-apply.mjs
 * Uses an in-memory SQLite database.
 * Covers: Jetson apply, rollback, audit trail, append-only enforcement.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import { applyAction, rollbackAction, getJetsonProfile, getRecentAudit, isFcArmed } from '../lib/advisor-apply.mjs';

function makeDb() {
  const tmpPath = path.join(os.tmpdir(), `test-adv-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  return { db: openDatabase(tmpPath), tmpPath };
}

function insertAction(db, { id, kind, payload, issueId = null, accepted = 1, state = 'proposed' }) {
  db.prepare(
    `INSERT INTO chat_actions (id, issue_id, kind, payload_json, accepted, state) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, issueId, kind, JSON.stringify(payload), accepted, state);
}

// ── isFcArmed ─────────────────────────────────────────────────────────────

describe('isFcArmed', () => {
  it('returns null when mavConn is null', () => {
    expect(isFcArmed(null)).toBeNull();
  });

  it('returns true when MAV_MODE_FLAG_SAFETY_ARMED set', () => {
    expect(isFcArmed({ lastBaseMode: 0x89 })).toBe(true);  // bit 7 set
  });

  it('returns false when bit 7 not set', () => {
    expect(isFcArmed({ lastBaseMode: 0x01 })).toBe(false);
  });

  it('returns null when lastBaseMode absent', () => {
    expect(isFcArmed({ connected: true })).toBeNull();
  });
});

// ── applyAction — no_action ───────────────────────────────────────────────

describe('applyAction — no_action', () => {
  let db, tmpPath;
  beforeEach(() => { ({ db, tmpPath } = makeDb()); });
  afterAll(() => { try { fs.unlinkSync(tmpPath); } catch {} });

  it('marks a no_action as applied', async () => {
    insertAction(db, { id: 'na-1', kind: 'no_action', payload: { kind: 'no_action', id: 'na-1', title: 'test' } });
    const r = await applyAction(db, 'na-1');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('no_action');
    const row = db.prepare(`SELECT state FROM chat_actions WHERE id = ?`).get('na-1');
    expect(row.state).toBe('applied');
  });

  it('rejects a second apply on the same action', async () => {
    insertAction(db, { id: 'na-2', kind: 'no_action', payload: { kind: 'no_action', id: 'na-2', title: 'test' } });
    await applyAction(db, 'na-2');
    await expect(applyAction(db, 'na-2')).rejects.toMatchObject({ code: 'already_applied' });
  });

  it('returns 404 for unknown action', async () => {
    await expect(applyAction(db, 'does-not-exist')).rejects.toMatchObject({ status: 404 });
  });
});

// ── applyAction — Jetson param_change ────────────────────────────────────

describe('applyAction — Jetson param_change', () => {
  let db, tmpPath;
  beforeEach(() => { ({ db, tmpPath } = makeDb()); });
  afterAll(() => { try { fs.unlinkSync(tmpPath); } catch {} });

  function insertParamAction(id, param, from, to) {
    const payload = {
      kind: 'param_change',
      id,
      title: `Change ${param}`,
      change: { param, from, to },
      target: 'jetson',
      risk: 'low',
      inflightSafe: true,
    };
    insertAction(db, { id, kind: 'param_change', payload });
  }

  it('applies a Jetson param and writes to jetson_profile', async () => {
    insertParamAction('ap-1', 'abort_conf_min', 0.7, 0.75);
    const r = await applyAction(db, 'ap-1');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('jetson');
    expect(r.param).toBe('abort_conf_min');
    expect(r.to).toBeCloseTo(0.75);
    const jp = getJetsonProfile(db);
    expect(jp.profile['abort_conf_min']).toBeCloseTo(0.75);
  });

  it('creates a snapshot before applying', async () => {
    insertParamAction('ap-2', 'vision_conf_min', 0.78, 0.82);
    const r = await applyAction(db, 'ap-2');
    expect(r.snapshotId).toBeGreaterThan(0);
    const snap = db.prepare(`SELECT * FROM param_snapshots WHERE id = ?`).get(r.snapshotId);
    expect(snap).toBeDefined();
    const data = JSON.parse(snap.payload_json);
    expect(data.param).toBe('vision_conf_min');
  });

  it('writes to the append-only audit table', async () => {
    insertParamAction('ap-3', 'abort_conf_hold_s', 2, 3);
    await applyAction(db, 'ap-3');
    const audits = getRecentAudit(db, { days: 1, limit: 10 });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const row = audits.find((r) => r.action_id === 'ap-3');
    expect(row).toBeDefined();
    expect(row.verified).toBe(1);
    expect(row.param).toBe('abort_conf_hold_s');
    expect(row.value_to).toBeCloseTo(3);
  });

  it('rejects a value that violates safe range at apply-time', async () => {
    const payload = {
      kind: 'param_change',
      id: 'ap-bad',
      title: 'bad value',
      change: { param: 'flare_alt_m', from: 8, to: 999 },
      target: 'jetson',
    };
    db.prepare(
      `INSERT INTO chat_actions (id, kind, payload_json, accepted, state) VALUES (?, ?, ?, 1, 'proposed')`,
    ).run('ap-bad', 'param_change', JSON.stringify(payload));
    await expect(applyAction(db, 'ap-bad')).rejects.toMatchObject({ code: 'revalidation_failed' });
  });

  it('rejects already-rejected actions', async () => {
    insertAction(db, {
      id: 'rejected-action',
      kind: 'param_change',
      payload: { kind: 'param_change', id: 'rej', title: 'x', change: { param: 'flare_alt_m', from: 8, to: 10 } },
      accepted: 0,
      state: 'rejected',
    });
    await expect(applyAction(db, 'rejected-action')).rejects.toMatchObject({ code: 'action_rejected' });
  });
});

// ── rollbackAction ────────────────────────────────────────────────────────

describe('rollbackAction — Jetson', () => {
  let db, tmpPath;
  beforeEach(() => { ({ db, tmpPath } = makeDb()); });
  afterAll(() => { try { fs.unlinkSync(tmpPath); } catch {} });

  it('rolls back and restores the previous value', async () => {
    // Seed current Jetson profile with a "before" value
    db.prepare(`INSERT INTO jetson_profile (param, value) VALUES (?, ?)`).run('xtrack_gain', 1.25);

    const payload = {
      kind: 'param_change',
      id: 'rb-1',
      title: 'Change xtrack',
      change: { param: 'xtrack_gain', from: 1.25, to: 1.5 },
      target: 'jetson',
      risk: 'med',
    };
    insertAction(db, { id: 'rb-1', kind: 'param_change', payload });

    // Apply
    await applyAction(db, 'rb-1');
    let jp = getJetsonProfile(db);
    expect(jp.profile['xtrack_gain']).toBeCloseTo(1.5);

    // Rollback
    const r = await rollbackAction(db, 'rb-1');
    expect(r.ok).toBe(true);
    expect(r.restoredTo).toBeCloseTo(1.25);
    jp = getJetsonProfile(db);
    expect(jp.profile['xtrack_gain']).toBeCloseTo(1.25);

    // Audit trail contains a rollback row
    const rows = getRecentAudit(db, { days: 1, limit: 20 });
    const rollbackRow = rows.find((r) => r.kind === 'rollback');
    expect(rollbackRow).toBeDefined();
    expect(rollbackRow.param).toBe('xtrack_gain');
  });

  it('cannot rollback a non-applied action', async () => {
    insertAction(db, {
      id: 'never-applied',
      kind: 'no_action',
      payload: { kind: 'no_action', id: 'na', title: 'test' },
    });
    await expect(rollbackAction(db, 'never-applied')).rejects.toMatchObject({ code: 'not_applied' });
  });
});

// ── Audit trail append-only enforcement ──────────────────────────────────

describe('param_audit append-only', () => {
  let db, tmpPath;
  beforeEach(() => { ({ db, tmpPath } = makeDb()); });
  afterAll(() => { try { fs.unlinkSync(tmpPath); } catch {} });

  it('blocks UPDATE on param_audit', () => {
    db.prepare(
      `INSERT INTO param_audit (kind, target, param, value_from, value_to, verified) VALUES ('param_change','jetson','x',1,2,1)`,
    ).run();
    const row = db.prepare(`SELECT id FROM param_audit LIMIT 1`).get();
    expect(() => {
      db.prepare(`UPDATE param_audit SET verified = 0 WHERE id = ?`).run(row.id);
    }).toThrow(/append-only/);
  });

  it('blocks DELETE on param_audit', () => {
    db.prepare(
      `INSERT INTO param_audit (kind, target, param, value_from, value_to, verified) VALUES ('param_change','jetson','y',1,2,1)`,
    ).run();
    const row = db.prepare(`SELECT id FROM param_audit LIMIT 1`).get();
    expect(() => {
      db.prepare(`DELETE FROM param_audit WHERE id = ?`).run(row.id);
    }).toThrow(/append-only/);
  });
});
