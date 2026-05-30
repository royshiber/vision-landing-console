import {
  applyAction,
  rollbackAction,
  previewAdvisorAction,
  isFcArmed,
  isInflightFcOverrideConfigured,
} from './advisor-apply.mjs';
import { logger } from './logger.mjs';
import { getCorrelationId } from './request-context.mjs';

function writeSharedAudit(db, entry) {
  db.prepare(
    `INSERT INTO param_audit
       (issue_id, action_id, kind, target, param, value_from, value_to,
        fc_armed, fc_firmware, app_version, verified, error, snapshot_id, group_id, note)
     VALUES
       (@issue_id, @action_id, @kind, @target, @param, @value_from, @value_to,
        @fc_armed, @fc_firmware, @app_version, @verified, @error, @snapshot_id, @group_id, @note)`,
  ).run(entry);
}

export function previewSharedAction(db, actionId, mavConn, valueTo) {
  return previewAdvisorAction(db, actionId, mavConn, valueTo);
}

export async function applySharedAction(db, actionId, ctx, opts = {}) {
  return applyAction(db, actionId, ctx, opts);
}

export async function rollbackSharedAction(db, actionId, ctx) {
  return rollbackAction(db, actionId, ctx);
}

/**
 * Apply a single engineer-approved FC param with the same safety posture used by advisor.
 */
export async function applyEngineerApprovedParam(
  db,
  {
    sessionId,
    key,
    value,
    mavConn,
    appVersion = null,
    fcFirmware = null,
    inflightFcOverride = false,
    inflightOverrideReason = '',
  },
) {
  const param = String(key || '').trim().toUpperCase();
  const to = Number(value);
  if (!param) throw new Error('missing param key');
  if (!Number.isFinite(to)) throw new Error('invalid param value');

  if (!mavConn?.connected || typeof mavConn.setParam !== 'function') {
    writeSharedAudit(db, {
      issue_id: null,
      action_id: null,
      kind: 'param_change',
      target: 'fc',
      param,
      value_from: null,
      value_to: to,
      fc_armed: null,
      fc_firmware: fcFirmware,
      app_version: appVersion,
      verified: 0,
      error: 'FC not connected',
      snapshot_id: null,
      group_id: sessionId || null,
      note: '[flight-engineer] offline apply attempt',
    });
    return { ok: true, applied: { key: param, value: to }, method: 'offline', note: 'FC לא מחובר — הפרמטר לא נשלח למטוס' };
  }

  const armed = isFcArmed(mavConn);
  const pilotInflightOverride =
    !!inflightFcOverride &&
    typeof inflightOverrideReason === 'string' &&
    inflightOverrideReason.trim().length >= 15;
  if (armed === true && !pilotInflightOverride) {
    throw Object.assign(new Error('המטוס במצב ARMED — נדרש DISARM או אישור override'), { status: 409, code: 'armed' });
  }
  if (armed === true && pilotInflightOverride && !isInflightFcOverrideConfigured()) {
    throw Object.assign(new Error('override מושבת בשרת (ADVISOR_FC_INFLIGHT_OVERRIDE)'), { status: 403, code: 'override_disabled' });
  }
  if (armed === null) {
    throw Object.assign(new Error('מצב ARMED לא ידוע — אין heartbeat עדכני'), { status: 409, code: 'armed_unknown' });
  }

  const from = typeof mavConn.params?.[param] === 'number' ? Number(mavConn.params[param]) : null;
  await mavConn.setParam(param, to, { timeoutMs: 3000 });

  let note = '[flight-engineer] approved by pilot confirmation word';
  if (pilotInflightOverride) {
    note += `\n[PILOT_INFLIGHT_OVERRIDE ${new Date().toISOString()}] ${inflightOverrideReason.trim()}`;
  }
  writeSharedAudit(db, {
    issue_id: null,
    action_id: null,
    kind: 'param_change',
    target: 'fc',
    param,
    value_from: from,
    value_to: to,
    fc_armed: armed ? 1 : 0,
    fc_firmware: fcFirmware,
    app_version: appVersion,
    verified: 1,
    error: null,
    snapshot_id: null,
    group_id: sessionId || null,
    note,
  });
  logger.info({ corrId: getCorrelationId(), sessionId, param, from, to, armed }, '[flight-actions-service] engineer param applied');
  return { ok: true, applied: { key: param, value: to }, method: 'mavlink' };
}
