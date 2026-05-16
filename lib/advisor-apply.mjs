/**
 * Advisor Apply — The canonical write path for advisor-proposed actions.
 *
 * ALL writes that originate from the advisor (Jetson profile or FC param)
 * MUST go through applyAction(). This is the layer that:
 *   - re-validates every action against the allowlist + safe range
 *   - takes a snapshot before writing
 *   - writes (to jetson_profile for Tier A; to FC via MAVLink for Tier B)
 *   - verifies the write took effect
 *   - rolls back on any verification failure
 *   - appends an append-only audit row
 *
 * Phase 3: Jetson apply + FC apply (ARMED-gate, disarmed-only).
 * Phase 4+: param_change_group atomic transactions.
 *
 * Safety doc: docs/ADVISOR_SAFETY.md §6, §8.
 */

import { isValueInParamProposalFamily, validateSingleForApply } from './advisor-actions.mjs';
import { logger } from './logger.mjs';

/** Readable error with HTTP status hint. */
export class ApplyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Load an action row by ID and re-validate it defensively.
 * @param {number|undefined} valueTo - optional override: must be one of the graded proposal values
 * @returns {{row: any, action: any}}
 */
function loadAction(db, actionId, valueTo) {
  const row = db.prepare(`SELECT * FROM chat_actions WHERE id = ?`).get(actionId);
  if (!row) throw new ApplyError(404, 'action_not_found', `action ${actionId} not found`);
  if (!row.accepted) throw new ApplyError(400, 'action_rejected', `action ${actionId} was rejected at proposal time: ${row.reject_reason}`);
  if (row.state === 'applied') throw new ApplyError(409, 'already_applied', `action ${actionId} already applied at ${row.applied_at}`);
  if (row.state === 'rolled_back') throw new ApplyError(409, 'already_rolled_back', `action ${actionId} already rolled back`);
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch {
    throw new ApplyError(500, 'corrupt_payload', `action ${actionId} has corrupt payload`);
  }
  if (valueTo != null && valueTo !== '' && (typeof valueTo === 'number' || typeof valueTo === 'string')) {
    const vt = Number(valueTo);
    if (Number.isFinite(vt) && payload?.kind === 'param_change' && payload?.change) {
      const { param, from, to } = payload.change;
      if (!isValueInParamProposalFamily(param, from, to, vt)) {
        throw new ApplyError(400, 'valueTo_not_in_family', 'הערך לא אחת מהרמות שאושרו להחלה');
      }
      payload = { ...payload, change: { ...payload.change, to: vt } };
    } else if (Number.isFinite(vt) && payload?.kind === 'param_change') {
      throw new ApplyError(400, 'invalid_valueTo', 'valueTo פגום');
    }
  }
  const v = validateSingleForApply(payload);
  if (!v.ok) throw new ApplyError(400, 'revalidation_failed', v.reason);
  return { row, action: v.option };
}

/**
 * Write a snapshot row capturing the CURRENT value of a single param before we touch it.
 * Returns the new snapshot ID.
 */
function writeSnapshot(db, kind, target, snapshotObj, reason) {
  const info = db.prepare(
    `INSERT INTO param_snapshots (kind, target, payload_json, reason) VALUES (?, ?, ?, ?)`,
  ).run(kind, target, JSON.stringify(snapshotObj), reason || null);
  return info.lastInsertRowid;
}

/**
 * Append a row to the append-only audit log. Failure here should NOT silently swallow —
 * if audit cannot be written, the apply itself should fail. We want a hard invariant:
 * "no param ever changes without an audit row."
 */
function writeAudit(db, entry) {
  db.prepare(
    `INSERT INTO param_audit
       (issue_id, action_id, kind, target, param, value_from, value_to,
        fc_armed, fc_firmware, app_version, verified, error, snapshot_id, group_id, note)
     VALUES
       (@issue_id, @action_id, @kind, @target, @param, @value_from, @value_to,
        @fc_armed, @fc_firmware, @app_version, @verified, @error, @snapshot_id, @group_id, @note)`,
  ).run(entry);
}

function markApplied(db, actionId, reason = null) {
  db.prepare(
    `UPDATE chat_actions SET state = 'applied', applied_at = datetime('now'), reject_reason = ? WHERE id = ?`,
  ).run(reason, actionId);
}
function markRolledBack(db, actionId) {
  db.prepare(
    `UPDATE chat_actions SET state = 'rolled_back', rolled_back_at = datetime('now') WHERE id = ?`,
  ).run(actionId);
}

// ── Jetson-side apply ──────────────────────────────────────────────────────

/**
 * Read the CURRENT Jetson-side value for a param.
 * Order: jetson_profile → null (caller may fall back to profile defaults client-side).
 */
function readJetsonParam(db, param) {
  const row = db.prepare(`SELECT value FROM jetson_profile WHERE param = ?`).get(param);
  return row ? Number(row.value) : null;
}

/**
 * Write a Jetson-side param via server canonical store. Idempotent upsert.
 */
function writeJetsonParam(db, param, value) {
  db.prepare(
    `INSERT INTO jetson_profile (param, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(param) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(param, value);
}

function applyJetsonParamChange(db, action, row, ctx) {
  const param = action.change.param;
  const to = Number(action.change.to);
  const prev = readJetsonParam(db, param);
  const from = prev != null ? prev : (action.change.from != null ? Number(action.change.from) : null);

  if (from != null && Math.abs(from - to) < 1e-6) {
    throw new ApplyError(400, 'noop', `param ${param} already at ${to}`);
  }

  // One transactional hop: snapshot + write + audit + mark applied.
  const tx = db.transaction(() => {
    const snapshotId = writeSnapshot(db, 'param_change', 'jetson',
      { param, value: from, applied_at: new Date().toISOString() }, `pre-apply ${row.id}`);
    writeJetsonParam(db, param, to);
    writeAudit(db, {
      issue_id: row.issue_id || null,
      action_id: row.id,
      kind: 'param_change',
      target: 'jetson',
      param,
      value_from: from,
      value_to: to,
      fc_armed: null,
      fc_firmware: ctx?.fcFirmware || null,
      app_version: ctx?.appVersion || null,
      verified: 1,
      error: null,
      snapshot_id: snapshotId,
      group_id: null,
      note: action.note || null,
    });
    markApplied(db, row.id);
    return snapshotId;
  });
  const snapshotId = tx();
  logger.info({ actionId: row.id, param, from, to, snapshotId }, 'jetson param applied');
  return {
    ok: true,
    kind: 'param_change',
    target: 'jetson',
    param,
    from,
    to,
    snapshotId,
    verifiedAt: new Date().toISOString(),
  };
}

// ── FC-side apply (Tier B) ─────────────────────────────────────────────────

/**
 * Derive ARMED from the live MAVLink state.
 * MAV_MODE_FLAG_SAFETY_ARMED = 0x80. We read the last heartbeat's baseMode.
 */
export function isFcArmed(mavConn) {
  if (!mavConn) return null;
  // heartbeat parser stores baseMode onto the frame emit but not on the instance;
  // most recent heartbeat's baseMode is attached in lib/mavlink-connection by us.
  // Provide a safe accessor — if unknown, return null (gate will treat as armed).
  const bm = mavConn.lastBaseMode;
  if (typeof bm !== 'number') return null;
  return (bm & 0x80) !== 0;
}

/** Set ADVISOR_FC_INFLIGHT_OVERRIDE=1 and send acknowledgeInflightRisk + inflightOverrideReason (15+ chars) on POST apply to allow Tier-B writes while ARMED (see ADVISOR_SAFETY.md). */
export function isInflightFcOverrideConfigured() {
  const v = process.env.ADVISOR_FC_INFLIGHT_OVERRIDE;
  return v === '1' || String(v).toLowerCase() === 'true';
}

async function applyFcParamChange(db, action, row, ctx) {
  const mavConn = ctx?.mavConn;
  if (!mavConn || !mavConn.connected) {
    throw new ApplyError(409, 'fc_not_connected', 'FC לא מחובר — לא ניתן לבצע כתיבה');
  }
  const armed = isFcArmed(mavConn);
  const pilotInflightOverride =
    !!ctx?.inflightFcOverride &&
    typeof ctx?.inflightOverrideReason === 'string' &&
    ctx.inflightOverrideReason.trim().length >= 15;
  if (armed === true && !action.inflightSafe && !pilotInflightOverride) {
    throw new ApplyError(409, 'armed', 'המטוס במצב ARMED — Tier B לא נכתב בטיסה. Disarm ונסה שוב.');
  }
  if (armed === true && !action.inflightSafe && pilotInflightOverride && !isInflightFcOverrideConfigured()) {
    throw new ApplyError(403, 'override_disabled', 'כתיבה בזמן ARM מושבתת בשרת (הפעל ADVISOR_FC_INFLIGHT_OVERRIDE והזן אישור בבקשה).');
  }
  if (armed === null && !action.inflightSafe) {
    throw new ApplyError(409, 'armed_unknown', 'מצב ARMED לא ידוע (עדיין אין heartbeat) — Tier B לא נכתב במצב לא ידוע.');
  }

  const param = action.change.param;
  const to = Number(action.change.to);
  const liveVal = mavConn.params?.[param];
  const from = typeof liveVal === 'number' ? liveVal : (action.change.from != null ? Number(action.change.from) : null);

  if (from != null && Math.abs(from - to) < 1e-6) {
    throw new ApplyError(400, 'noop', `param ${param} already at ${to}`);
  }

  if (typeof mavConn.setParam !== 'function') {
    throw new ApplyError(500, 'mav_write_unsupported', 'המחבר MAVLink לא חושף setParam — פיצ׳ר בשלב 3.3');
  }

  // Snapshot FIRST, BEFORE writing, so we always have a rollback target.
  const snapshotId = writeSnapshot(db, 'param_change', 'fc',
    { param, value: from, armed, applied_at: new Date().toISOString() }, `pre-apply ${row.id}`);

  let verified = false;
  let error = null;
  try {
    const result = await mavConn.setParam(param, to, { timeoutMs: 3000 });
    if (!result || !result.ok) throw new Error(result?.error || 'no echo from FC');
    if (Math.abs((result.value ?? NaN) - to) > 1e-4) {
      throw new Error(`FC echoed ${result.value} but we sent ${to}`);
    }
    verified = true;
  } catch (err) {
    error = err?.message || String(err);
    // Best-effort rollback: try to send the original value back.
    try {
      if (from != null) await mavConn.setParam(param, from, { timeoutMs: 3000 });
    } catch { /* nested failure — will be visible in audit */ }
  }

  let auditNote = action.note || null;
  if (pilotInflightOverride && armed === true) {
    const stamp = `[PILOT_INFLIGHT_OVERRIDE ${new Date().toISOString()}] ${ctx.inflightOverrideReason.trim()}`;
    auditNote = auditNote ? `${auditNote}\n${stamp}` : stamp;
  }

  writeAudit(db, {
    issue_id: row.issue_id || null,
    action_id: row.id,
    kind: 'param_change',
    target: 'fc',
    param,
    value_from: from,
    value_to: to,
    fc_armed: armed === true ? 1 : armed === false ? 0 : null,
    fc_firmware: ctx?.fcFirmware || null,
    app_version: ctx?.appVersion || null,
    verified: verified ? 1 : 0,
    error,
    snapshot_id: snapshotId,
    group_id: null,
    note: auditNote,
  });

  if (verified) {
    markApplied(db, row.id);
    logger.info({ actionId: row.id, param, from, to }, 'fc param applied');
    return {
      ok: true,
      kind: 'param_change',
      target: 'fc',
      param, from, to,
      snapshotId,
      verifiedAt: new Date().toISOString(),
    };
  }

  logger.warn({ actionId: row.id, param, from, to, error }, 'fc param apply failed; rollback attempted');
  throw new ApplyError(500, 'apply_failed', `FC write/verify failed: ${error}`);
}

// ── Rollback path ──────────────────────────────────────────────────────────

/**
 * Revert a previously-applied action using its snapshot.
 * Creates a NEW audit row of kind 'rollback' (never updates the original).
 */
export async function rollbackAction(db, actionId, ctx) {
  const row = db.prepare(`SELECT * FROM chat_actions WHERE id = ?`).get(actionId);
  if (!row) throw new ApplyError(404, 'action_not_found', `action ${actionId} not found`);
  if (row.state !== 'applied') throw new ApplyError(409, 'not_applied', `action ${actionId} is not in applied state (current: ${row.state})`);
  // Find the most-recent snapshot written for this action.
  const snap = db.prepare(
    `SELECT id, payload_json, target FROM param_snapshots
     WHERE reason = ? ORDER BY id DESC LIMIT 1`,
  ).get(`pre-apply ${actionId}`);
  if (!snap) throw new ApplyError(500, 'no_snapshot', `action ${actionId} has no snapshot to revert from`);

  let snapData;
  try { snapData = JSON.parse(snap.payload_json); } catch {
    throw new ApplyError(500, 'corrupt_snapshot', `snapshot ${snap.id} corrupt`);
  }

  const param = snapData.param;
  const restoreValue = snapData.value;
  if (typeof param !== 'string' || !Number.isFinite(restoreValue)) {
    throw new ApplyError(500, 'invalid_snapshot', `snapshot ${snap.id} missing param/value`);
  }

  if (snap.target === 'jetson') {
    const tx = db.transaction(() => {
      const before = readJetsonParam(db, param);
      writeJetsonParam(db, param, restoreValue);
      writeAudit(db, {
        issue_id: row.issue_id || null,
        action_id: actionId,
        kind: 'rollback',
        target: 'jetson',
        param,
        value_from: before,
        value_to: restoreValue,
        fc_armed: null,
        fc_firmware: ctx?.fcFirmware || null,
        app_version: ctx?.appVersion || null,
        verified: 1,
        error: null,
        snapshot_id: snap.id,
        group_id: null,
        note: 'rollback',
      });
      markRolledBack(db, actionId);
    });
    tx();
    logger.info({ actionId, param, restoreValue }, 'jetson param rolled back');
    return { ok: true, target: 'jetson', param, restoredTo: restoreValue };
  }

  if (snap.target === 'fc') {
    const mavConn = ctx?.mavConn;
    if (!mavConn || typeof mavConn.setParam !== 'function') {
      throw new ApplyError(409, 'fc_not_connected', 'FC לא מחובר — לא ניתן לבצע rollback');
    }
    const armed = isFcArmed(mavConn);
    if (armed === true) {
      throw new ApplyError(409, 'armed', 'המטוס ARMED — לא ניתן לבצע rollback של Tier B');
    }
    const before = typeof mavConn.params?.[param] === 'number' ? mavConn.params[param] : null;
    let verified = false, error = null;
    try {
      const r = await mavConn.setParam(param, restoreValue, { timeoutMs: 3000 });
      if (!r || !r.ok) throw new Error(r?.error || 'no echo');
      if (Math.abs((r.value ?? NaN) - restoreValue) > 1e-4) throw new Error(`echoed ${r.value} vs ${restoreValue}`);
      verified = true;
    } catch (err) {
      error = err?.message || String(err);
    }
    writeAudit(db, {
      issue_id: row.issue_id || null,
      action_id: actionId,
      kind: 'rollback',
      target: 'fc',
      param,
      value_from: before,
      value_to: restoreValue,
      fc_armed: armed === true ? 1 : armed === false ? 0 : null,
      fc_firmware: ctx?.fcFirmware || null,
      app_version: ctx?.appVersion || null,
      verified: verified ? 1 : 0,
      error,
      snapshot_id: snap.id,
      group_id: null,
      note: 'rollback',
    });
    if (!verified) throw new ApplyError(500, 'rollback_failed', `rollback failed: ${error}`);
    markRolledBack(db, actionId);
    return { ok: true, target: 'fc', param, restoredTo: restoreValue };
  }

  throw new ApplyError(500, 'unknown_target', `unknown snapshot target: ${snap.target}`);
}

/**
 * Pre-apply facts for the confirmation modal: live "from" from MAVLink cache, ARM state, whether server allows inflight override.
 */
export function previewAdvisorAction(db, actionId, mavConn, valueTo) {
  const row = db.prepare(`SELECT * FROM chat_actions WHERE id = ?`).get(String(actionId));
  if (!row) return { ok: false, code: 'action_not_found' };
  if (!row.accepted) return { ok: false, code: 'action_rejected' };
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch {
    return { ok: false, code: 'corrupt_payload' };
  }
  if (valueTo != null && valueTo !== '' && (typeof valueTo === 'number' || typeof valueTo === 'string')) {
    const vt = Number(valueTo);
    if (Number.isFinite(vt) && payload?.kind === 'param_change' && payload?.change) {
      const { param, from, to } = payload.change;
      if (!isValueInParamProposalFamily(param, from, to, vt)) {
        return { ok: false, code: 'valueTo_not_in_family' };
      }
      payload = { ...payload, change: { ...payload.change, to: vt } };
    }
  }
  const v = validateSingleForApply(payload);
  if (!v.ok) return { ok: false, code: 'revalidation_failed', reason: v.reason };
  const action = v.option;
  if (action.kind !== 'param_change') {
    return { ok: true, kind: action.kind, previewKind: 'non_param' };
  }
  const param = action.change?.param;
  const to = Number(action.change?.to);
  if (action.target === 'jetson') {
    const prevRow = db.prepare(`SELECT value FROM jetson_profile WHERE param = ?`).get(param);
    const live = prevRow != null ? Number(prevRow.value) : null;
    return {
      ok: true,
      target: 'jetson',
      param,
      proposedTo: to,
      liveFrom: live,
      inflightSafe: !!action.inflightSafe,
    };
  }
  if (action.target === 'fc') {
    const liveVal = mavConn?.params?.[param];
    const armed = isFcArmed(mavConn);
    return {
      ok: true,
      target: 'fc',
      param,
      proposedTo: to,
      liveFrom: typeof liveVal === 'number' ? liveVal : null,
      armed,
      armedKnown: mavConn != null && typeof mavConn.lastBaseMode === 'number',
      inflightOverrideEnabled: isInflightFcOverrideConfigured(),
      autopilotName: mavConn?.autopilotName || null,
      inflightSafe: !!action.inflightSafe,
    };
  }
  return { ok: false, code: 'unknown_target' };
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Apply an advisor action by its server-assigned ID.
 * @param {*} db
 * @param {string} actionId
 * @param {{mavConn?: any, appVersion?: string, fcFirmware?: string, inflightFcOverride?: boolean, inflightOverrideReason?: string}} ctx
 */
export async function applyAction(db, actionId, ctx = {}, { valueTo } = {}) {
  const { row, action } = loadAction(db, actionId, valueTo);

  if (action.kind === 'no_action') {
    markApplied(db, row.id, 'no_action (informational)');
    return { ok: true, kind: 'no_action', id: row.id, appliedAt: new Date().toISOString() };
  }

  if (action.kind === 'param_change') {
    if (action.target === 'jetson') return applyJetsonParamChange(db, action, row, ctx);
    if (action.target === 'fc')     return applyFcParamChange(db, action, row, ctx);
    throw new ApplyError(500, 'unknown_target', `unknown target: ${action.target}`);
  }

  throw new ApplyError(400, 'unsupported_kind', `unsupported kind: ${action.kind}`);
}

/**
 * Read the full current Jetson profile (server-canonical).
 */
export function getJetsonProfile(db) {
  const rows = db.prepare(`SELECT param, value, updated_at FROM jetson_profile`).all();
  const profile = {};
  for (const r of rows) profile[r.param] = r.value;
  return { profile, raw: rows };
}

/**
 * Recent audit entries, bounded by lookback days. Used for the long-term memory
 * the advisor receives in every chat turn (so it knows what the pilot changed
 * in the last N weeks even if the chat session is brand-new).
 */
export function getRecentAudit(db, { days = 60, limit = 200 } = {}) {
  return db.prepare(
    `SELECT id, created_at, kind, target, param, value_from, value_to, verified, error, action_id, issue_id,
            fc_firmware, app_version, note
     FROM param_audit
     WHERE datetime(created_at) >= datetime('now', ?)
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(`-${Number(days) || 60} days`, Number(limit) || 200);
}
