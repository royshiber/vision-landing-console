import {
  applyAction,
  rollbackAction,
  previewAdvisorAction,
  isFcArmed,
  isInflightFcOverrideConfigured,
} from './advisor-apply.mjs';
import { ARDUPILOT_PLANE_MODES } from './arduplane-flight-modes.mjs';
import { ASK_PLANE_MODE_RTL } from './mavlink-connection.mjs';
import { isAskSessionFlightOpKind } from './assist/ask-safety.mjs';
import { ASSIST_HE } from './assist/assist-hebrew.mjs';
import {
  MAV_CMD_DO_LAND_START,
  MAV_RESULT_ACCEPTED,
  missionHasDoLandStart,
  missionHasNavLand,
} from './do-land-start.mjs';
import { modeNameForFamily, modeTableForFamily, vehicleModeFamily } from './vehicle-mode-family.mjs';
import { logger } from './logger.mjs';
import { getCorrelationId } from './request-context.mjs';

const MODE_BY_NAME = Object.freeze({
  plane: Object.fromEntries(
    Object.entries(ARDUPILOT_PLANE_MODES).map(([id, name]) => [String(name).toUpperCase(), Number(id)]),
  ),
  copter: Object.fromEntries(
    Object.entries(modeTableForFamily('copter')).map(([id, name]) => [String(name).toUpperCase(), Number(id)]),
  ),
});

export function resolveAskFlightOpCustomMode(kind, slots = {}) {
  const k = String(kind || '').toUpperCase();
  if (k === 'ARM' || k === 'DISARM' || k === 'LAND') return null;
  const family = slots.family === 'copter' ? 'copter' : 'plane';
  if (k === 'RTL') return family === 'copter' ? MODE_BY_NAME.copter.RTL : ASK_PLANE_MODE_RTL;
  if (k === 'MODE_CHANGE') {
    const name = String(slots.mode || '').trim().toUpperCase();
    if (!name || name === 'LAND') return null;
    const table = modeTableForFamily(family);
    const byName = MODE_BY_NAME[family];
    if (name in byName) return byName[name];
    const asNum = Number(name);
    if (Number.isInteger(asNum) && table[asNum]) return asNum;
  }
  return null;
}

/**
 * Ask voice session flight op.
 * RTL and named modes use SET_MODE. Fixed-wing LAND uses DO_LAND_START only.
 * ARM / DISARM are rejected here even if a caller bypasses the intent layer.
 */
export async function applyAskFlightOp(
  db,
  {
    kind,
    mode = null,
    sessionId = null,
    mavConn = null,
    appVersion = null,
    fcFirmware = null,
    missionTimeoutMs = 8000,
    ackTimeoutMs = 3000,
  } = {},
) {
  const k = String(kind || '').toUpperCase();
  if (k === 'ARM' || k === 'DISARM' || !isAskSessionFlightOpKind(k)) {
    return {
      ok: false,
      blocked: true,
      sent: false,
      error: 'blocked_arm',
      note: 'חימוש ונטרול חסומים. לא נשלח.',
    };
  }
  const family = vehicleModeFamily(mavConn);
  const requestedName = String(mode || '').trim().toUpperCase();
  if (k === 'LAND' || requestedName === 'LAND') {
    return applyAskDoLandStart(db, {
      sessionId,
      mavConn,
      appVersion,
      fcFirmware,
      missionTimeoutMs,
      ackTimeoutMs,
    });
  }
  const customMode = resolveAskFlightOpCustomMode(k, { mode, family });
  if (customMode != null && modeNameForFamily(family, customMode) === 'LAND') {
    return applyAskDoLandStart(db, {
      sessionId,
      mavConn,
      appVersion,
      fcFirmware,
      missionTimeoutMs,
      ackTimeoutMs,
    });
  }
  if (customMode == null) {
    return {
      ok: false,
      sent: false,
      error: 'unknown_mode',
      note: 'לא צוין מצב טיסה מוכר. לא נשלח.',
    };
  }
  if (!mavConn?.connected || typeof mavConn.setArduPlaneMode !== 'function') {
    if (db) {
      writeSharedAudit(db, {
        issue_id: null,
        action_id: null,
        kind: 'flight_op',
        target: 'fc',
        param: k,
        value_from: null,
        value_to: customMode,
        fc_armed: null,
        fc_firmware: fcFirmware,
        app_version: appVersion,
        verified: 0,
        error: 'FC not connected',
        snapshot_id: null,
        group_id: sessionId || null,
        note: '[airvix-ask] offline flight op',
      });
    }
    return {
      ok: true,
      sent: false,
      method: 'offline',
      kind: k,
      customMode,
      note: 'הבקר אינו מחובר — הפקודה לא נשלחה למטוס',
    };
  }
  const sent = mavConn.setArduPlaneMode(customMode, { reason: k });
  if (db) {
    writeSharedAudit(db, {
      issue_id: null,
      action_id: null,
      kind: 'flight_op',
      target: 'fc',
      param: k,
      value_from: null,
      value_to: customMode,
      fc_armed: isFcArmed(mavConn) === true ? 1 : 0,
      fc_firmware: fcFirmware,
      app_version: appVersion,
      verified: 1,
      error: null,
      snapshot_id: null,
      group_id: sessionId || null,
      note: '[airvix-ask] SET_MODE after voice session GO',
    });
  }
  logger.info({ corrId: getCorrelationId(), sessionId, kind: k, customMode }, '[flight-actions-service] Ask flight op SET_MODE');
  return {
    ok: true,
    sent: true,
    method: 'mavlink',
    kind: k,
    customMode,
    apply_result: sent || null,
    note: 'נשלח לבקר כהחלפת מצב',
  };
}

function landRefusal(note, error) {
  return {
    ok: false,
    sent: false,
    method: 'mavlink',
    kind: 'LAND',
    customMode: null,
    command: null,
    error,
    note,
  };
}

/**
 * Fixed-wing land: read the FC mission, send DO_LAND_START only when that marker exists.
 * Never SET_MODE. Never custom_mode 14.
 */
async function applyAskDoLandStart(
  db,
  {
    sessionId = null,
    mavConn = null,
    appVersion = null,
    fcFirmware = null,
    missionTimeoutMs = 8000,
    ackTimeoutMs = 3000,
  } = {},
) {
  const family = vehicleModeFamily(mavConn);
  if (family === 'copter') {
    return landRefusal(ASSIST_HE.landNotFixedWing, 'not_fixed_wing');
  }
  if (!mavConn?.connected || typeof mavConn.refreshMissionToCache !== 'function' || typeof mavConn.sendDoLandStart !== 'function') {
    if (db) {
      writeSharedAudit(db, {
        issue_id: null,
        action_id: null,
        kind: 'flight_op',
        target: 'fc',
        param: 'LAND',
        value_from: null,
        value_to: null,
        fc_armed: null,
        fc_firmware: fcFirmware,
        app_version: appVersion,
        verified: 0,
        error: 'FC not connected',
        snapshot_id: null,
        group_id: sessionId || null,
        note: '[airvix-ask] offline land',
      });
    }
    return {
      ok: true,
      sent: false,
      method: 'offline',
      kind: 'LAND',
      customMode: null,
      command: null,
      note: ASSIST_HE.flightOpOffline,
    };
  }

  let items = [];
  try {
    await mavConn.refreshMissionToCache({ timeoutMs: missionTimeoutMs });
    items = Array.isArray(mavConn.missionItems) ? mavConn.missionItems : [];
  } catch (err) {
    if (db) {
      writeSharedAudit(db, {
        issue_id: null,
        action_id: null,
        kind: 'flight_op',
        target: 'fc',
        param: 'LAND',
        value_from: null,
        value_to: null,
        fc_armed: isFcArmed(mavConn) === true ? 1 : 0,
        fc_firmware: fcFirmware,
        app_version: appVersion,
        verified: 0,
        error: 'mission unreadable',
        snapshot_id: null,
        group_id: sessionId || null,
        note: '[airvix-ask] land refused, mission unreadable',
      });
    }
    logger.info({ corrId: getCorrelationId(), sessionId, err: err?.message }, '[flight-actions-service] land mission unreadable');
    return landRefusal(ASSIST_HE.landMissionUnreadable, 'mission_unreadable');
  }

  if (!missionHasDoLandStart(items)) {
    const note = items.length === 0
      ? ASSIST_HE.landMissionEmpty
      : (missionHasNavLand(items) ? ASSIST_HE.landNavLandWithoutMarker : ASSIST_HE.landNoDoLandStart);
    if (db) {
      writeSharedAudit(db, {
        issue_id: null,
        action_id: null,
        kind: 'flight_op',
        target: 'fc',
        param: 'LAND',
        value_from: null,
        value_to: null,
        fc_armed: isFcArmed(mavConn) === true ? 1 : 0,
        fc_firmware: fcFirmware,
        app_version: appVersion,
        verified: 0,
        error: 'no DO_LAND_START',
        snapshot_id: null,
        group_id: sessionId || null,
        note: '[airvix-ask] land refused, no DO_LAND_START',
      });
    }
    return landRefusal(note, 'no_do_land_start');
  }

  const lat = Number(mavConn.lastGlobalPos?.lat);
  const lon = Number(mavConn.lastGlobalPos?.lon);
  let ack = null;
  try {
    ack = await mavConn.sendDoLandStart({
      lat: Number.isFinite(lat) ? lat : 0,
      lon: Number.isFinite(lon) ? lon : 0,
      timeoutMs: ackTimeoutMs,
    });
  } catch (err) {
    logger.info({ corrId: getCorrelationId(), sessionId, err: err?.message }, '[flight-actions-service] DO_LAND_START send failed');
    return landRefusal(ASSIST_HE.flightOpFailed, 'flight_op_failed');
  }

  const accepted = ack != null && Number(ack.result) === MAV_RESULT_ACCEPTED;
  const timedOut = ack == null;
  const note = accepted
    ? ASSIST_HE.landAckAccepted
    : (timedOut ? ASSIST_HE.landAckTimeout : ASSIST_HE.landAckRejected);
  if (db) {
    writeSharedAudit(db, {
      issue_id: null,
      action_id: null,
      kind: 'flight_op',
      target: 'fc',
      param: 'LAND',
      value_from: null,
      value_to: MAV_CMD_DO_LAND_START,
      fc_armed: isFcArmed(mavConn) === true ? 1 : 0,
      fc_firmware: fcFirmware,
      app_version: appVersion,
      verified: accepted ? 1 : 0,
      error: accepted ? null : (timedOut ? 'ack timeout' : 'ack rejected'),
      snapshot_id: null,
      group_id: sessionId || null,
      note: accepted
        ? '[airvix-ask] DO_LAND_START accepted'
        : '[airvix-ask] DO_LAND_START not accepted',
    });
  }
  logger.info({ corrId: getCorrelationId(), sessionId, accepted, timedOut }, '[flight-actions-service] DO_LAND_START');
  return {
    ok: accepted,
    sent: true,
    method: 'mavlink',
    kind: 'LAND',
    customMode: null,
    command: MAV_CMD_DO_LAND_START,
    error: accepted ? null : (timedOut ? 'ack_timeout' : 'ack_rejected'),
    note,
  };
}

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
