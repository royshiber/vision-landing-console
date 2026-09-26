/**
 * MAV_CMD_COMPONENT_ARM_DISARM (400) on the existing COMMAND_LONG frame.
 * param1 is 1 to arm and 0 to disarm. param2 is always 0.
 * 21196 is force-disarm and is never written.
 */

export const MAV_CMD_COMPONENT_ARM_DISARM = 400;
export const ARM_DISARM_FORCE_MAGIC = 21196;
export const LANDED_STATE_IN_AIR = 2;
export const LANDED_STATE_TAKEOFF = 3;
export const LANDED_STATE_FRESH_MS = 5000;

export function assertNotForceDisarm(param2) {
  if (Number(param2) === ARM_DISARM_FORCE_MAGIC) {
    throw Object.assign(new Error('force disarm blocked'), { code: 'force_disarm_blocked' });
  }
}

/** COMMAND_LONG payload. param2 is always the normal value. */
export function buildArmDisarmPayload(sysId, compId, arm) {
  assertNotForceDisarm(0);
  const payload = Buffer.alloc(33);
  payload.writeFloatLE(arm === true ? 1 : 0, 0);
  payload.writeFloatLE(0, 4);
  payload.writeFloatLE(0, 8);
  payload.writeFloatLE(0, 12);
  payload.writeFloatLE(0, 16);
  payload.writeFloatLE(0, 20);
  payload.writeFloatLE(0, 24);
  payload.writeUInt16LE(MAV_CMD_COMPONENT_ARM_DISARM, 28);
  payload[30] = Number(sysId) & 0xff;
  payload[31] = Number(compId) & 0xff;
  payload[32] = 0;
  if (payload.readFloatLE(4) === ARM_DISARM_FORCE_MAGIC) {
    throw Object.assign(new Error('force disarm blocked'), { code: 'force_disarm_blocked' });
  }
  return payload;
}

export function isVehicleFlying(conn, now = Date.now()) {
  const state = Number(conn?.lastLandedState);
  const at = Number(conn?.lastLandedStateAt);
  if (state !== LANDED_STATE_IN_AIR && state !== LANDED_STATE_TAKEOFF) return false;
  if (!Number.isFinite(at)) return false;
  return now - at <= LANDED_STATE_FRESH_MS;
}

/** Newest FC line that explains a refused arm. Null when the FC did not say. */
export function prearmFailureText(texts) {
  const list = Array.isArray(texts) ? texts : [];
  for (const row of list) {
    const text = String(row?.text ?? row ?? '').trim();
    if (!text) continue;
    if (/prearm|pre-arm|arm:/i.test(text)) return text;
  }
  return null;
}
