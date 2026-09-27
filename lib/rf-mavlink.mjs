/**
 * RF serial link helpers.
 * Rates use MAV_CMD_SET_MESSAGE_INTERVAL on the real COMMAND_LONG layout.
 * Companion commands are addressed to component 191. No parameter writes.
 */

export const RF_BAUD_DEFAULT = 57600;
export const RF_COMPANION_COMP_ID = 191;
export const RF_CMD_UPLINK = 42001;
export const RF_CMD_GIMBAL = 42002;
export const RF_CMD_TRACK = 42003;
export const RF_VIDEO_REASON_HE = 'במצב RF אין וידאו';

export const RF_STREAM_INTERVAL_US = 1000000;
export const RF_ATTITUDE_INTERVAL_US = 500000;
export const RF_GPS_INTERVAL_US = 1000000;

const MSG_SYS_STATUS = 1;
const MSG_ATTITUDE = 30;
const MSG_GPS_RAW_INT = 24;
const MSG_GLOBAL_POSITION_INT = 33;
const MSG_VFR_HUD = 74;
const MAV_CMD_SET_MESSAGE_INTERVAL = 511;

export function rfMessageIntervals() {
  return Object.freeze([
    { id: MSG_SYS_STATUS, name: 'SYS_STATUS', intervalUs: RF_GPS_INTERVAL_US },
    { id: MSG_ATTITUDE, name: 'ATTITUDE', intervalUs: RF_ATTITUDE_INTERVAL_US },
    { id: MSG_GLOBAL_POSITION_INT, name: 'GLOBAL_POSITION_INT', intervalUs: RF_STREAM_INTERVAL_US },
    { id: MSG_VFR_HUD, name: 'VFR_HUD', intervalUs: RF_STREAM_INTERVAL_US },
    { id: MSG_GPS_RAW_INT, name: 'GPS_RAW_INT', intervalUs: RF_GPS_INTERVAL_US },
  ]);
}

/** COMMAND_LONG wire order: seven floats, command at 28, then targets. */
export function buildCommandLongPayload(sysId, compId, command, params = []) {
  const payload = Buffer.alloc(33);
  for (let i = 0; i < 7; i += 1) {
    const value = Number(params[i]);
    payload.writeFloatLE(Number.isFinite(value) ? value : 0, i * 4);
  }
  payload.writeUInt16LE(command & 0xffff, 28);
  payload[30] = sysId & 0xff;
  payload[31] = compId & 0xff;
  payload[32] = 0;
  return payload;
}

export function buildRfIntervalPayload(sysId, compId, msgId, intervalUs) {
  return buildCommandLongPayload(sysId, compId, MAV_CMD_SET_MESSAGE_INTERVAL, [msgId, intervalUs]);
}

const NAMED = Object.freeze({
  UP_WIFI: 'wifi',
  UP_CELL: 'cell',
  GMB_YAW: 'yaw',
  GMB_PIT: 'pitch',
  GMB_MODE: 'mode',
  CAM0_OK: 'cam0',
  CAM1_OK: 'cam1',
});

export function parseNamedValueFloat(payload) {
  if (!payload || payload.length < 18) return null;
  const name = payload.subarray(4, 14).toString('ascii').replace(/\0+$/g, '');
  const key = NAMED[name];
  if (!key) return null;
  return { name, key, value: payload.readFloatLE(14) };
}

export function applyNamedValue(status, named) {
  const next = { ...(status || {}) };
  if (!named) return next;
  if (named.key === 'mode') next.mode = named.value >= 0.5 ? 1 : 0;
  else if (named.key === 'yaw' || named.key === 'pitch') next[named.key] = named.value;
  else next[named.key] = named.value >= 0.5 ? 1 : 0;
  next.at = Date.now();
  return next;
}
