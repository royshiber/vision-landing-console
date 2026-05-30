/**
 * Why: allow Vision Landing Console to connect directly to FC/Jetson over UDP, TCP, or Serial,
 *      just like Mission Planner, without depending on Jetson HTTP-push being active.
 * What: parses MAVLink 1 & 2 frames, builds and sends MAVLink frames (with correct CRC),
 *       supports UDP (SiK radio / WiFi), TCP, and Serial (USB/COM).
 */

import dgram from 'dgram';
import net from 'net';
import { EventEmitter } from 'events';
import { MSG_ID_MAGIC_NUMBER } from 'mavlink-mappings';
import { logger } from './logger.mjs';
import { getCorrelationId } from './request-context.mjs';

// ── MAVLink constants ──────────────────────────────────────────────────────────
const MAVLINK1_STX = 0xfe;
const MAVLINK2_STX = 0xfd;

const MSG_HEARTBEAT          = 0;
const MSG_SYS_STATUS         = 1;
const MSG_PARAM_VALUE        = 22;
const MSG_STATUSTEXT         = 253;
const MSG_PARAM_REQUEST_LIST = 21;
const MSG_PARAM_REQUEST_READ = 20;
const MSG_PARAM_SET          = 23;

/** MAV_PARAM_TYPE values — use FC-echoed type when available. */
const MAV_PARAM_TYPE_INT8     = 2;
const MAV_PARAM_TYPE_INT16    = 3;
const MAV_PARAM_TYPE_INT32    = 6;
const MAV_PARAM_TYPE_REAL32   = 9;

const GCS_SYS_ID  = 255;
const GCS_COMP_ID = 190;

/** Why: CRC-16/MCRF4XX used by both MAVLink 1 and 2. */
function mavCrc(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    let tmp = (b ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ (tmp << 4)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return crc;
}

/**
 * Extra CRC seed bytes per message ID (from MAVLink common.xml).
 * Add more as needed when implementing additional messages.
 */
/** MAVLink common COMMAND_INT (#73) — DO_REPOSITION etc. */
const MSG_COMMAND_INT = 73;
/** Same numeric ID as COMMAND_INT; MAVLink uses payload length to distinguish inbound frames. */
const MSG_MISSION_ITEM_INT = 73;
const MSG_MANUAL_CONTROL = 69;
const MAV_CMD_DO_REPOSITION = 192;

/** Overrides / legacy seeds — fallback is {@link MSG_ID_MAGIC_NUMBER} from mavlink-mappings. */
const EXTRA_CRC = {
  [MSG_HEARTBEAT]:          50,
  [MSG_SYS_STATUS]:        124,
  [MSG_PARAM_REQUEST_LIST]:159,
  [MSG_PARAM_REQUEST_READ]: 159,
  [MSG_PARAM_VALUE]:       220,
  [MSG_PARAM_SET]:         168,
  [MSG_STATUSTEXT]:         83,
  43: 132, // MISSION_REQUEST_LIST
  40: 230, // MISSION_REQUEST
  47: 153, // MISSION_ACK
};

function crcExtraLookup(mid24) {
  const mid = mid24 & 0xffffff;
  const low = mid & 0xff;
  if (EXTRA_CRC[mid] !== undefined && EXTRA_CRC[mid] !== null) return EXTRA_CRC[mid];
  if (EXTRA_CRC[low] !== undefined && EXTRA_CRC[low] !== null) return EXTRA_CRC[low];
  return MSG_ID_MAGIC_NUMBER[String(mid)] ?? MSG_ID_MAGIC_NUMBER[String(low)] ?? 0;
}

/** MAVLink common — receive-only for map overlay (CRC only needed for outbound mission protocol). */
const MSG_RC_CHANNELS = 65; // RC_CHANNELS — chan1_raw…chan18_raw PWM values
const MSG_ATTITUDE = 30; // roll, pitch, yaw (radians) + rates
const MSG_GPS_RAW_INT = 24;
const MSG_GLOBAL_POSITION_INT = 33;
const MSG_VFR_HUD = 74; // airspeed, groundspeed, alt, climb, heading, throttle
const MSG_HOME_POSITION = 242;
const MSG_MISSION_COUNT = 44;
const MSG_MISSION_REQUEST_LIST = 43;
const MSG_MISSION_REQUEST = 40;
const MSG_MISSION_ITEM = 39;
const MSG_MISSION_ACK = 47;

/** Why: build a valid MAVLink 1 frame ready to send over any transport. */
export function buildMavlink1Frame(msgId, payload, seq = 0) {
  const len = payload.length;
  const header = Buffer.from([MAVLINK1_STX, len, seq & 0xFF, GCS_SYS_ID, GCS_COMP_ID, msgId]);
  const crcSeed = crcExtraLookup(msgId);
  const crcBuf  = Buffer.concat([Buffer.from([len, seq & 0xFF, GCS_SYS_ID, GCS_COMP_ID, msgId]), payload, Buffer.from([crcSeed])]);
  const crc     = mavCrc(crcBuf);
  return Buffer.concat([header, payload, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
}

/** MAVLink 2 — mission protocol when the link already carries v2 frames. */
function buildMavlink2Frame(msgId24, payload, seq = 0) {
  const len = payload.length;
  const incompat = 0;
  const compat = 0;
  const mid = msgId24 & 0xFFFFFF;
  const header = Buffer.from([
    MAVLINK2_STX, len, incompat, compat, seq & 0xFF, GCS_SYS_ID, GCS_COMP_ID,
    mid & 0xFF, (mid >> 8) & 0xFF, (mid >> 16) & 0xFF,
  ]);
  const crcSeed = crcExtraLookup(mid);
  const crcBuf = Buffer.concat([
    Buffer.from([len, incompat, compat, seq & 0xFF, GCS_SYS_ID, GCS_COMP_ID, mid & 0xFF, (mid >> 8) & 0xFF, (mid >> 16) & 0xFF]),
    payload,
    Buffer.from([crcSeed]),
  ]);
  const crc = mavCrc(crcBuf);
  return Buffer.concat([header, payload, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
}

// ── Frame parser ──────────────────────────────────────────────────────────────
export function parseMavlinkFrames(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === MAVLINK2_STX && i + 10 <= buf.length) {
      const len   = buf[i + 1];
      const total = 12 + len;
      if (i + total > buf.length) break;
      frames.push({ version: 2, msgId: buf[i + 7] | (buf[i + 8] << 8) | (buf[i + 9] << 16), sysId: buf[i + 5], compId: buf[i + 6], payload: buf.slice(i + 10, i + 10 + len), end: i + total });
      i += total;
    } else if (buf[i] === MAVLINK1_STX && i + 6 <= buf.length) {
      const len   = buf[i + 1];
      const total = 8 + len;
      if (i + total > buf.length) break;
      frames.push({ version: 1, msgId: buf[i + 5], sysId: buf[i + 3], compId: buf[i + 4], payload: buf.slice(i + 6, i + 6 + len), end: i + total });
      i += total;
    } else {
      i++;
    }
  }
  return frames;
}

// ── Message parsers ───────────────────────────────────────────────────────────
export function parseHeartbeat(p) {
  if (p.length < 9) return null;
  const TYPES = { 1: 'Fixed Wing', 2: 'Quadrotor', 13: 'Hexarotor', 0: 'Generic' };
  const APS   = { 3: 'ArduPilot', 12: 'PX4' };
  return { customMode: p.readUInt32LE(0), type: p[4], autopilot: p[5], baseMode: p[6], systemStatus: p[7], mavlinkVersion: p[8], vehicleType: TYPES[p[4]] || `type${p[4]}`, autopilotName: APS[p[5]] || `ap${p[5]}` };
}

/**
 * STATUSTEXT (#253): severity(u8) + text(char[50]). MAVLink 2 often truncates trailing
 * NULs — require only severity + payload tail; do not demand full 51 bytes.
 */
export function parseStatusText(p) {
  if (p.length < 2) return null;
  const severity = p.readUInt8(0);
  const text = p.slice(1, Math.min(p.length, 51)).toString('utf8').replace(/\0/g, '').trim();
  if (!text) return null;
  return { severity, text };
}

/**
 * PARAM_VALUE (#22): param_value(float), param_count(uint16), param_index(uint16),
 * param_id(char[16]), param_type(uint8). MAVLink 2 may truncate trailing zero bytes.
 */
function parseParamValue(p) {
  if (p.length < 9) return null;
  const value = p.readFloatLE(0);
  const count = p.readUInt16LE(4);
  const index = p.readUInt16LE(6);
  const type = p[p.length - 1];
  const name = p.slice(8, p.length - 1).toString('utf8').replace(/\0/g, '').trim();
  if (!name) return null;
  return { name, value, type, count, index };
}

/**
 * GPS_RAW_INT (#24): time_usec(uint64 @0), fix_type(u8 @8), [pad 9–11], lat(int32 @12),
 * lon(int32 @16), … satellites_visible(u8 @32). Truncated MAVLink2 may omit suffix fields.
 */
export function parseGpsRawInt(p) {
  if (p.length < 20) return null;
  const fixType = p[8];
  const latE7 = p.readInt32LE(12);
  const lonE7 = p.readInt32LE(16);
  const lat = latE7 / 1e7;
  const lon = lonE7 / 1e7;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  const satellites = p.length >= 33 ? p.readUInt8(32) : null;
  let satsNorm = satellites;
  if (satsNorm !== null && satsNorm !== undefined && (satsNorm === 255 || Number.isNaN(satsNorm))) satsNorm = null;
  return { lat, lon, fixType, satellites: satsNorm, t: Date.now() };
}

export function parseGlobalPositionInt(p) {
  if (p.length < 12) return null;
  const timeBootMsRaw = p.readUInt32LE(0);
  const timeBootMs = Number.isFinite(timeBootMsRaw) ? timeBootMsRaw : null;
  const lat = p.readInt32LE(4) / 1e7;
  const lon = p.readInt32LE(8) / 1e7;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  /** @type {number|null} */
  let altMslM = null;
  /** @type {number|null} */
  let relativeAltM = null;
  /** @type {number|null} */
  let groundspeedMs = null;
  if (p.length >= 24) {
    const altMm = p.readInt32LE(12);
    const relMm = p.readInt32LE(16);
    const vx = p.readInt16LE(20);
    const vy = p.readInt16LE(22);
    altMslM = Number.isFinite(altMm / 1000) ? altMm / 1000 : null;
    relativeAltM = Number.isFinite(relMm / 1000) ? relMm / 1000 : null;
    const gsq = vx * vx + vy * vy;
    if (Number.isFinite(gsq)) groundspeedMs = Math.sqrt(gsq) / 100;
  }
  let hdgDeg = null;
  if (p.length >= 28) {
    const hdgCdeg = p.readUInt16LE(26);
    const d = hdgCdeg / 100;
    if (Number.isFinite(d) && hdgCdeg !== 0xffff) hdgDeg = d;
  }
  return {
    lat,
    lon,
    altMslM,
    relativeAltM,
    groundspeedMs,
    hdgDeg,
    timeBootMs,
    t: Date.now(),
  };
}

/**
 * ATTITUDE (msg 30): time_boot_ms(uint32), roll(float), pitch(float), yaw(float), rollspeed(float), pitchspeed(float), yawspeed(float)
 * All angles in radians; converted to degrees here for display.
 */
export function parseAttitude(p) {
  /** time_boot_ms(4) + roll,pitch,yaw(float×3)=16B; angular rates need 28B (may be absent in truncated MAVLink2). */
  if (p.length < 16) return null;
  const timeBootMsRaw = p.readUInt32LE(0);
  const timeBootMs = Number.isFinite(timeBootMsRaw) ? timeBootMsRaw : null;
  const roll = p.readFloatLE(4);
  const pitch = p.readFloatLE(8);
  const yaw = p.readFloatLE(12);
  if (!Number.isFinite(roll) || !Number.isFinite(pitch) || !Number.isFinite(yaw)) return null;
  const rad2deg = (r) => Math.round((r * 180 / Math.PI) * 10) / 10;
  return {
    rollDeg:  rad2deg(roll),
    pitchDeg: rad2deg(pitch),
    yawDeg:   rad2deg(yaw),
    timeBootMs,
  };
}

/**
 * SYS_STATUS (msg 1): voltage_battery uint16 @14 (mV), current_battery int16 @16 (cA),
 * battery_remaining int8 @18 (%).
 */
export function parseSysStatus(p) {
  if (p.length < 19) return null;
  const voltageRaw = p.readUInt16LE(14);
  const currentRaw = p.readInt16LE(16);
  const remaining = p.readInt8(18);
  let voltage_V = voltageRaw === 0xFFFF ? null : Math.round(voltageRaw / 10) / 100;
  let current_A = currentRaw === -1 ? null : Math.round(currentRaw) / 100;
  let remaining_pct = remaining === -1 ? null : remaining;
  if (voltage_V != null && !Number.isFinite(voltage_V)) voltage_V = null;
  if (current_A != null && !Number.isFinite(current_A)) current_A = null;
  if (remaining_pct != null && !Number.isFinite(remaining_pct)) remaining_pct = null;
  return { voltage_V, current_A, remaining_pct };
}

/**
 * VFR_HUD (74): MAVLink reorder — all float fields (4 B) precede narrower fields:
 *   airspeed, groundspeed, alt, climb, then heading (int16), throttle (uint16).
 * This matches mavlink.io field-reordering rules, NOT the textual XML field list order.
 */
export function parseVfrHud(p) {
  if (p.length < 20) return null;
  const air = p.readFloatLE(0);
  const gs = p.readFloatLE(4);
  const alt = p.readFloatLE(8);
  const climb = p.readFloatLE(12);
  const heading = p.readInt16LE(16);
  const throttle = p.readUInt16LE(18);
  const okAir = Number.isFinite(air);
  const okGs = Number.isFinite(gs);
  const okAlt = Number.isFinite(alt);
  const okClimb = Number.isFinite(climb);
  if (!okAir && !okGs && !okAlt && !okClimb) return null;
  let headingOut = null;
  if (Number.isFinite(heading) && heading >= 0 && heading <= 360) headingOut = heading;
  let throttleOut = null;
  if (Number.isFinite(throttle) && throttle >= 0 && throttle <= 100) throttleOut = throttle;
  return {
    airspeed: okAir ? Math.round(air * 10) / 10 : null,
    groundspeed: okGs ? Math.round(gs * 10) / 10 : null,
    alt: okAlt ? Math.round(alt * 10) / 10 : null,
    climb: okClimb ? Math.round(climb * 10) / 10 : null,
    heading: headingOut,
    throttle: throttleOut,
  };
}

/**
 * RC_CHANNELS (msg 65) wire order: time_boot_ms @0; chan1_raw…chan18_raw @4; chancount @40; rssi @41.
 */
function parseRcChannels(p) {
  if (p.length < 42) return null;
  const result = { chancount: p[40], rssi: p[41] };
  for (let i = 1; i <= 18; i += 1) {
    result[`chan${i}_raw`] = p.readUInt16LE(4 + (i - 1) * 2);
  }
  return result;
}

function parseHomePosition(p) {
  if (p.length < 12) return null;
  const lat = p.readInt32LE(0) / 1e7;
  const lon = p.readInt32LE(4) / 1e7;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon, t: Date.now() };
}

/** @param {{ msgId: number, payload: Buffer }} frame */
function parseMissionWaypoint(frame) {
  const p = frame.payload;
  if (frame.msgId === MSG_MISSION_ITEM_INT && p.length >= 38) {
    const seq = p.readUInt16LE(0);
    const command = p.readUInt16LE(5);
    const lat = p.readInt32LE(25) / 1e7;
    const lon = p.readInt32LE(29) / 1e7;
    return { seq, command, lat, lon };
  }
  if (frame.msgId === MSG_MISSION_ITEM && p.length >= 34) {
    const seq = p.readUInt16LE(0);
    const command = p.readUInt16LE(5);
    const lat = p.readFloatLE(25);
    const lon = p.readFloatLE(29);
    return { seq, command, lat, lon };
  }
  return null;
}

function clampManualStick(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1000, Math.min(1000, n));
}

// ── Connection class ──────────────────────────────────────────────────────────
export class MavlinkConnection extends EventEmitter {
  constructor({ id, name, type, host, port, serialPort, baudRate }) {
    super();
    this.id         = id;
    this.name       = name || `Connection ${id}`;
    this.type       = type;                         // 'udp' | 'tcp' | 'serial' | 'telemetry'
    this.host       = host || '0.0.0.0';
    this.port       = Number(port) || 14550;
    this.serialPort = serialPort;
    this.baudRate   = Number(baudRate) || 57600;
    this._socket    = null;                         // dgram.Socket | net.Socket | SerialPort
    this._buf       = Buffer.alloc(0);
    this._seq       = 0;
    this.connected  = false;
    this.listening  = false;
    this.sysId      = null;
    this.vehicleType   = null;
    this.autopilotName = null;
    this.lastHeartbeatAt = null;
    this.statusTexts  = [];
    this.params       = {};                         // { PARAM_NAME: value }
    this.paramTypes    = {};                        // { PARAM_NAME: mav type byte }
    this.paramCount   = 0;
    this.remoteAddr   = null;
    this.connectedAt  = null;
    this.firstHeartbeatAt = null;
    this.heartbeatCount = 0;
    this.bytesRx        = 0;
    this.bytesTx        = 0;
    this.framesRx       = 0;
    this.framesTx       = 0;
    this.droppedBytes   = 0;
    this.lastError      = null;
    this.lastBaseMode   = null;  // most-recent heartbeat base_mode (used for ARMED detection)
    this.lastCustomMode = null;  // most-recent heartbeat custom_mode (flight mode number)
    this.lastVfrHud     = null;  // most-recent VFR_HUD (airspeed, groundspeed, alt, climb, heading, throttle)
    this.lastAttitude   = null;  // most-recent ATTITUDE (rollDeg, pitchDeg, yawDeg)
    this.lastBattery    = null;  // most-recent SYS_STATUS battery (voltage_V, current_A, remaining_pct)
    this._pendingParamSets = new Map(); // param -> { resolve, reject, timer }
    this._heartbeatTimer = null; // GCS heartbeat interval
    /** @type {1 | 2} prefer MAVLink2 outbound after we have seen a v2 frame on the wire */
    this._preferredTxVersion = 1;
    /** FC component id from last non-GCS HEARTBEAT (mission protocol target). */
    this.fcTargetCompId = 1;

    this.lastGpsRaw = null;
    this.lastGlobalPos = null;
    this.lastHome = null;
    this.lastRcChannels = null;
    /** @type {{ seq: number, lat: number | null, lon: number | null, command?: number }[]} */
    this.missionWaypoints = [];
    /** @type {{ promise: Promise<any>, resolve: Function, reject: Function, timeout: ReturnType<typeof setTimeout>, expected: number | null, items: Map<number, any> } | null} */
    this._missionFetch = null;
  }

  // ── Connect ────────────────────────────────────────────────────────────────
  connect() {
    if (this.type === 'udp')                             return this._connectUdp();
    if (this.type === 'tcp')                             return this._connectTcp();
    if (this.type === 'serial' || this.type === 'telemetry') return this._connectSerial();
    return Promise.reject(new Error(`סוג חיבור לא מוכר: ${this.type}`));
  }

  _connectUdp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this._socket = sock;
      sock.on('error', (err) => { logger.error({ err, id: this.id }, 'UDP error'); this.connected = false; this.emit('error', err); reject(err); });
      sock.on('message', (msg, rinfo) => {
        if (!this.remoteAddr) this.remoteAddr = `${rinfo.address}:${rinfo.port}`;
        this._handleData(msg);
        if (!this.connected) { this.connected = true; this.connectedAt = new Date().toISOString(); this.emit('connected', { remote: this.remoteAddr }); }
      });
      sock.bind(this.port, () => {
        this.listening = true;
        logger.info({ id: this.id, port: this.port }, 'MAVLink UDP listening');
        this.emit('listening');
        resolve();
      });
    });
  }

  _connectTcp() {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      this._socket = sock;
      sock.connect(this.port, this.host, () => {
        this.connected = true; this.listening = true; this.connectedAt = new Date().toISOString();
        this.remoteAddr = `${this.host}:${this.port}`;
        logger.info({ id: this.id, host: this.host, port: this.port }, 'MAVLink TCP connected');
        this.emit('connected', { remote: this.remoteAddr });
        resolve();
      });
      sock.on('data', (d) => this._handleData(d));
      sock.on('error', (err) => { logger.error({ err, id: this.id }, 'TCP error'); this.connected = false; this.emit('error', err); reject(err); });
      sock.on('close', () => { this.connected = false; this.emit('disconnected'); });
    });
  }

  async _connectSerial() {
    let SerialPortClass;
    try {
      const mod = await import('serialport');
      SerialPortClass = mod.SerialPort;
    } catch {
      throw new Error('serialport לא מותקן — הרץ: npm install serialport');
    }
    return new Promise((resolve, reject) => {
      const sp = new SerialPortClass({ path: this.serialPort, baudRate: this.baudRate, autoOpen: false });
      this._socket = sp;
      sp.open((err) => {
        if (err) { logger.error({ err, id: this.id }, 'Serial open error'); reject(err); return; }
        this.connected = true; this.listening = true; this.connectedAt = new Date().toISOString();
        this.remoteAddr = `${this.serialPort}@${this.baudRate}`;
        logger.info({ id: this.id, port: this.serialPort, baud: this.baudRate }, 'MAVLink Serial opened');
        this.emit('connected', { remote: this.remoteAddr });
        resolve();
      });
      sp.on('data', (d) => this._handleData(d));
      sp.on('error', (err) => { logger.error({ err, id: this.id }, 'Serial error'); this.connected = false; this.emit('error', err); });
      sp.on('close', () => { this.connected = false; this.emit('disconnected'); });
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  _paramTypeFor(paramName) {
    const key = String(paramName || '');
    const hit = Object.keys(this.paramTypes || {}).find((k) => k.toUpperCase() === key.toUpperCase());
    const t = hit != null ? this.paramTypes[hit] : undefined;
    if (typeof t === 'number' && t >= 1 && t <= 11) return t;
    if (/^SERIAL\d|SR\d_/i.test(key)) return MAV_PARAM_TYPE_INT8;
    return MAV_PARAM_TYPE_REAL32;
  }

  _findPendingParamSet(paramName) {
    const up = String(paramName || '').toUpperCase();
    if (this._pendingParamSets.has(up)) return { ...this._pendingParamSets.get(up), key: up };
    for (const [key, pending] of this._pendingParamSets) {
      if (up.startsWith(key) || key.startsWith(up)) return { ...pending, key };
    }
    return null;
  }

  _clearPendingParamSet(key) {
    const up = String(key || '').toUpperCase();
    this._pendingParamSets.delete(up);
    for (const k of [...this._pendingParamSets.keys()]) {
      if (k.startsWith(up) || up.startsWith(k)) this._pendingParamSets.delete(k);
    }
  }

  _buildParamSetFrame(paramName, sendValue, paramType) {
    const target = this.sysId ?? 1;
    const tc = this.fcTargetCompId ?? 1;
    const nameBuf = Buffer.alloc(16, 0);
    nameBuf.write(paramName.slice(0, 16), 0, 'utf8');
    const valBuf = Buffer.alloc(4);
    valBuf.writeFloatLE(sendValue, 0);
    const payload = Buffer.concat([
      nameBuf,
      valBuf,
      Buffer.from([paramType & 0xff, target & 0xff, tc & 0xff]),
    ]);
    return this._preferredTxVersion === 2
      ? buildMavlink2Frame(MSG_PARAM_SET, payload, this._seq++)
      : buildMavlink1Frame(MSG_PARAM_SET, payload, this._seq++);
  }

  async _verifyParamByRead(paramName, expectedValue, timeoutMs = 3000) {
    this.requestParamRead(paramName);
    const v = await this.waitForParam(paramName, timeoutMs);
    if (v != null && Math.abs(v - expectedValue) < 1e-3) {
      return { ok: true, param: paramName, value: v, verifiedBy: 'read' };
    }
    return null;
  }

  _send(buf) {
    if (!this._socket) return;
    try {
      if (this.type === 'udp') {
        const [host, port] = (this.remoteAddr || '').split(':');
        if (host && port) this._socket.send(buf, Number(port), host);
      } else {
        this._socket.write(buf);
      }
      this.bytesTx += buf.length;
      this.framesTx += 1;
    } catch (err) { this.lastError = err?.message || String(err); logger.warn({ err, id: this.id }, 'MAVLink send failed'); }
  }

  /**
   * Set a single FC parameter via PARAM_SET (MAVLink 1).
   * Resolves with { ok, param, value } once PARAM_VALUE echo is received.
   * Rejects if no echo within timeoutMs.
   *
   * @param {string} paramName
   * @param {number} value
   * @param {{ timeoutMs?: number }} opts
   */
  setParam(paramName, value, { timeoutMs = 5000, retries = 1 } = {}) {
    if (!this._heartbeatTimer) this.startHeartbeat(1000);

    const sendOnce = () =>
      new Promise((resolve, reject) => {
        if (!this.connected) {
          reject(new Error('FC not connected'));
          return;
        }
        const sendValue =
          Math.abs(Number(value) - Math.round(Number(value))) < 1e-4
            ? Math.round(Number(value))
            : Number(value);
        const paramType = this._paramTypeFor(paramName);
        const key = paramName.toUpperCase();

        /** @type {{ resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>, resendTimer: ReturnType<typeof setInterval> | null, expectedValue: number, name: string, key: string }} */
        const pending = {
          resolve,
          reject,
          timer: null,
          resendTimer: null,
          expectedValue: sendValue,
          name: paramName,
          key,
        };

        pending.timer = setTimeout(() => {
          if (pending.resendTimer) clearInterval(pending.resendTimer);
          this._clearPendingParamSet(key);
          reject(new Error(`PARAM_SET timeout for ${paramName}`));
        }, timeoutMs);

        this._pendingParamSets.set(key, pending);

        const finish = (r) => {
          if (pending.resendTimer) clearInterval(pending.resendTimer);
          clearTimeout(pending.timer);
          this._clearPendingParamSet(key);
          resolve(r);
        };

        const corrId = getCorrelationId();
        const sendFrame = () => {
          logger.info(
            {
              corrId,
              paramName,
              value: sendValue,
              paramType,
              sysId: this.sysId,
              compId: this.fcTargetCompId,
            },
            `Sending PARAM_SET for ${paramName}`,
          );
          this._send(this._buildParamSetFrame(paramName, sendValue, paramType));
        };

        sendFrame();
        pending.resendTimer = setInterval(sendFrame, 900);
        pending.resolve = finish;
      });

    return (async () => {
      const cached = Object.keys(this.params || {}).find(
        (k) => k.toUpperCase() === paramName.toUpperCase(),
      );
      if (!cached) {
        this.requestParamRead(paramName);
        await this.waitForParam(paramName, Math.min(2500, timeoutMs));
      }
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await sendOnce();
        } catch (err) {
          lastErr = err;
          const sendValue =
            Math.abs(Number(value) - Math.round(Number(value))) < 1e-4
              ? Math.round(Number(value))
              : Number(value);
          const verified = await this._verifyParamByRead(paramName, sendValue, 2500);
          if (verified) return verified;
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, 400));
            this.requestParamRead(paramName);
          }
        }
      }
      throw lastErr;
    })();
  }

  /**
   * Command the aircraft to fly to a specific lat/lon via DO_REPOSITION (COMMAND_INT).
   * Uses MAV_FRAME_GLOBAL_RELATIVE_ALT (frame=3) so altitude is relative to home.
   * ArduPlane switches to GUIDED mode automatically and loiters on arrival.
   *
   * @param {number} lat - Target latitude (decimal degrees)
   * @param {number} lon - Target longitude (decimal degrees)
   * @param {number} altM - Target altitude in metres above home (AGL)
   */
  flyTo(lat, lon, altM) {
    if (!this.connected) throw new Error('FC not connected');
    const target = this.sysId ?? 1;
    const tc     = this.fcTargetCompId ?? 1;

    // COMMAND_INT payload (35 bytes):
    // param1(float) param2(float) param3(float) param4(float)
    // x(int32) y(int32) z(float) command(uint16)
    // target_system(u8) target_component(u8) frame(u8) current(u8) autocontinue(u8)
    const buf = Buffer.alloc(35);
    buf.writeFloatLE(-1,   0);  // param1: speed -1 = no change
    buf.writeFloatLE(0,    4);  // param2: flags
    buf.writeFloatLE(0,    8);  // param3: loiter_radius 0 = use WP_LOITER_RAD
    buf.writeFloatLE(0,   12);  // param4: yaw 0 = follow path heading
    buf.writeInt32LE(Math.round(lat * 1e7), 16); // x = lat*1e7
    buf.writeInt32LE(Math.round(lon * 1e7), 20); // y = lon*1e7
    buf.writeFloatLE(altM, 24); // z = altitude (AGL)
    buf.writeUInt16LE(MAV_CMD_DO_REPOSITION, 28); // command
    buf[30] = target; // target_system
    buf[31] = tc;     // target_component
    buf[32] = 3;      // frame: MAV_FRAME_GLOBAL_RELATIVE_ALT
    buf[33] = 0;      // current (not a mission item)
    buf[34] = 0;      // autocontinue

    const frame = this._preferredTxVersion === 2
      ? buildMavlink2Frame(MSG_COMMAND_INT, buf, this._seq++)
      : buildMavlink1Frame(MSG_COMMAND_INT, buf, this._seq++);
    this._send(frame);
    logger.info({ lat, lon, altM }, 'fly-to COMMAND_INT sent');
  }

  /**
   * Send MANUAL_CONTROL for joystick / gamepad (-1000…1000 per axis).
   * Uses MAVLink 2 layout when the link has seen MAVLink 2 frames.
   */
  sendManualControl({ x = 0, y = 0, z = 0, r = 0, buttons = 0 } = {}) {
    if (!this.connected) throw new Error('FC not connected');
    const target = this.sysId ?? 1;
    const cx = clampManualStick(x);
    const cy = clampManualStick(y);
    const cz = clampManualStick(z);
    const cr = clampManualStick(r);

    if (this._preferredTxVersion === 2) {
      const payload = Buffer.alloc(30);
      payload.writeInt16LE(cx, 0);
      payload.writeInt16LE(cy, 2);
      payload.writeInt16LE(cz, 4);
      payload.writeInt16LE(cr, 6);
      payload.writeUInt16LE(buttons & 0xffff, 8);
      payload.writeUInt8(target & 0xff, 10);
      const frame = buildMavlink2Frame(MSG_MANUAL_CONTROL, payload, this._seq++);
      this._send(frame);
    } else {
      const payload = Buffer.alloc(11);
      payload.writeUInt8(target & 0xff, 0);
      payload.writeInt16LE(cx, 1);
      payload.writeInt16LE(cy, 3);
      payload.writeInt16LE(cz, 5);
      payload.writeInt16LE(cr, 7);
      payload.writeUInt16LE(buttons & 0xffff, 9);
      const frame = buildMavlink1Frame(MSG_MANUAL_CONTROL, payload, this._seq++);
      this._send(frame);
    }
  }

  /** Request all parameters from the FC. */
  requestParams() {
    const target = this.sysId ?? 1;
    const tc = this.fcTargetCompId ?? 1;
    const payload = Buffer.from([target & 0xff, tc & 0xff]); // target_system, target_component
    const frame = this._preferredTxVersion === 2
      ? buildMavlink2Frame(MSG_PARAM_REQUEST_LIST, payload, this._seq++)
      : buildMavlink1Frame(MSG_PARAM_REQUEST_LIST, payload, this._seq++);
    this._send(frame);
    logger.info({ id: this.id, mavlinkVersion: this._preferredTxVersion }, 'PARAM_REQUEST_LIST sent');
  }

  /** Request one parameter by name (PARAM_REQUEST_READ). */
  requestParamRead(paramName) {
    if (!this.connected) return;
    const target = this.sysId ?? 1;
    const tc = this.fcTargetCompId ?? 1;
    const nameBuf = Buffer.alloc(16, 0);
    nameBuf.write(String(paramName || '').slice(0, 16), 0, 'utf8');
    const payload = Buffer.alloc(20);
    payload.writeInt16LE(-1, 0);
    payload[2] = target & 0xff;
    payload[3] = tc & 0xff;
    nameBuf.copy(payload, 4);
    const frame = this._preferredTxVersion === 2
      ? buildMavlink2Frame(MSG_PARAM_REQUEST_READ, payload, this._seq++)
      : buildMavlink1Frame(MSG_PARAM_REQUEST_READ, payload, this._seq++);
    this._send(frame);
  }

  waitForParam(paramName, timeoutMs = 2500) {
    const key = String(paramName || '').toUpperCase();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = () => {
        const hit = Object.keys(this.params || {}).find((k) => k.toUpperCase() === key);
        if (hit && typeof this.params[hit] === 'number') return resolve(this.params[hit]);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  _sendMissionRequestList() {
    const ts = this.sysId ?? 1;
    const tc = this.fcTargetCompId ?? 1;
    const seq = this._seq++;
    if (this._preferredTxVersion === 2) {
      const payload = Buffer.from([ts, tc, 0]); // MAV_MISSION_TYPE_MISSION
      this._send(buildMavlink2Frame(MSG_MISSION_REQUEST_LIST, payload, seq));
    } else {
      const payload = Buffer.from([ts, tc]);
      this._send(buildMavlink1Frame(MSG_MISSION_REQUEST_LIST, payload, seq));
    }
  }

  _sendMissionRequest(seq) {
    const ts = this.sysId ?? 1;
    const tc = this.fcTargetCompId ?? 1;
    const s = this._seq++;
    if (this._preferredTxVersion === 2) {
      const payload = Buffer.alloc(5);
      payload.writeUInt16LE(seq & 0xFFFF, 0);
      payload[2] = ts;
      payload[3] = tc;
      payload[4] = 0;
      this._send(buildMavlink2Frame(MSG_MISSION_REQUEST, payload, s));
    } else {
      const payload = Buffer.alloc(4);
      payload.writeUInt16LE(seq & 0xFFFF, 0);
      payload[2] = ts;
      payload[3] = tc;
      this._send(buildMavlink1Frame(MSG_MISSION_REQUEST, payload, s));
    }
  }

  _failMissionFetch(reason) {
    const f = this._missionFetch;
    if (!f) return;
    clearTimeout(f.timeout);
    this._missionFetch = null;
    f.reject(new Error(reason || 'mission fetch failed'));
  }

  _completeMissionFetch() {
    const f = this._missionFetch;
    if (!f) return;
    clearTimeout(f.timeout);
    const arr = [...f.items.values()].sort((a, b) => a.seq - b.seq);
    this.missionWaypoints = arr.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon));
    this._missionFetch = null;
    const ts = this.sysId ?? 1;
    const tc = this.fcTargetCompId ?? 1;
    const ackPayload = Buffer.from([ts, tc, 0]); // target_system, target_component, MAV_MISSION_ACCEPTED
    const seq = this._seq++;
    if (this._preferredTxVersion === 2) {
      this._send(buildMavlink2Frame(MSG_MISSION_ACK, ackPayload, seq));
    } else {
      this._send(buildMavlink1Frame(MSG_MISSION_ACK, ackPayload, seq));
    }
    f.resolve({ ok: true, waypointCount: this.missionWaypoints.length });
  }

  /**
   * Download mission from FC into `missionWaypoints` (global lat/lon only).
   * @param {{ timeoutMs?: number }} opts
   */
  refreshMissionToCache(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 20000;
    if (!this.connected) return Promise.reject(new Error('FC not connected'));
    if (this._missionFetch) return this._missionFetch.promise;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timeout = setTimeout(() => this._failMissionFetch('mission download timeout'), timeoutMs);
    this._missionFetch = {
      promise,
      resolve,
      reject,
      timeout,
      expected: null,
      items: new Map(),
    };
    this._sendMissionRequestList();
    return promise;
  }

  /** Compact snapshot for SSE / terrain map (positions + mission polyline). */
  getMapTelemetrySnapshot() {
    const gps = this.lastGpsRaw;
    const gpi = this.lastGlobalPos;
    const home = this.lastHome;
    let gpsLat = null;
    let gpsLon = null;
    let gpsSource = null;
    if (gpi) {
      gpsLat = gpi.lat;
      gpsLon = gpi.lon;
      gpsSource = 'GLOBAL_POS';
    } else if (gps && typeof gps.fixType === 'number' && gps.fixType >= 2) {
      gpsLat = gps.lat;
      gpsLon = gps.lon;
      gpsSource = 'GPS_RAW';
    } else if (gps) {
      gpsLat = gps.lat;
      gpsLon = gps.lon;
      gpsSource = 'GPS_RAW';
    }
    const mission = this.missionWaypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    return {
      gpsLat,
      gpsLon,
      gpsSource,
      globalLat: gpi?.lat ?? null,
      globalLon: gpi?.lon ?? null,
      globalHdgDeg: gpi?.hdgDeg ?? null,
      homeLat: home?.lat ?? null,
      homeLon: home?.lon ?? null,
      mission,
      missionCount: mission.length,
      t: Date.now(),
    };
  }

  // ── Receive ────────────────────────────────────────────────────────────────
  _handleData(data) {
    this.bytesRx += data.length;
    if (!this.connectedAt && this.connected) this.connectedAt = new Date().toISOString();
    this._buf = Buffer.concat([this._buf, data]);
    if (this._buf.length > 16384) {
      const drop = this._buf.length - 8192;
      this.droppedBytes += drop;
      this._buf = this._buf.slice(drop);
    }

    const frames = parseMavlinkFrames(this._buf);
    let lastEnd = 0;
    for (const frame of frames) {
      lastEnd = frame.end;
      this.framesRx += 1;
      if (frame.version === 2) this._preferredTxVersion = 2;

      if (frame.msgId === MSG_HEARTBEAT) {
        const hb = parseHeartbeat(frame.payload);
        if (hb) {
          if (frame.sysId !== GCS_SYS_ID) {
            this.sysId = frame.sysId;
            this.fcTargetCompId = frame.compId;
          }
          this.lastHeartbeatAt = new Date().toISOString();
          this.heartbeatCount += 1;
          if (!this.firstHeartbeatAt) this.firstHeartbeatAt = this.lastHeartbeatAt;
          this.vehicleType    = hb.vehicleType;
          this.autopilotName  = hb.autopilotName;
          this.lastBaseMode   = hb.baseMode;
          this.lastCustomMode = hb.customMode;
          this.emit('heartbeat', { sysId: frame.sysId, ...hb });
        }
      } else if (frame.msgId === MSG_STATUSTEXT) {
        const st = parseStatusText(frame.payload);
        if (st) {
          this.statusTexts = [{ ...st, receivedAt: new Date().toISOString() }, ...this.statusTexts].slice(0, 50);
          this.emit('statustext', st);
        }
      } else if (frame.msgId === MSG_PARAM_VALUE) {
        const pv = parseParamValue(frame.payload);
        if (pv) {
          this.params[pv.name] = pv.value;
          this.paramTypes[pv.name] = pv.type;
          this.paramCount = pv.count;
          this.emit('param', pv);
          const pending = this._findPendingParamSet(pv.name);
          if (pending) {
            if (pending.resendTimer) clearInterval(pending.resendTimer);
            clearTimeout(pending.timer);
            this._clearPendingParamSet(pending.key || pv.name.toUpperCase());
            pending.resolve({ ok: true, param: pv.name, value: pv.value });
          }
        }
      } else if (frame.msgId === MSG_ATTITUDE) {
        const a = parseAttitude(frame.payload);
        if (a) this.lastAttitude = { ...a, receivedWallMs: Date.now() };
      } else if (frame.msgId === MSG_SYS_STATUS) {
        const b = parseSysStatus(frame.payload);
        if (b) this.lastBattery = b;
      } else if (frame.msgId === MSG_VFR_HUD) {
        const v = parseVfrHud(frame.payload);
        if (v) this.lastVfrHud = { ...v, receivedWallMs: Date.now() };
      } else if (frame.msgId === MSG_GPS_RAW_INT) {
        const g = parseGpsRawInt(frame.payload);
        if (g) this.lastGpsRaw = g;
      } else if (frame.msgId === MSG_GLOBAL_POSITION_INT) {
        const g = parseGlobalPositionInt(frame.payload);
        if (g) this.lastGlobalPos = { ...g, receivedWallMs: Date.now() };
      } else if (frame.msgId === MSG_HOME_POSITION) {
        const h = parseHomePosition(frame.payload);
        if (h) this.lastHome = h;
      } else if (frame.msgId === MSG_RC_CHANNELS) {
        const rc = parseRcChannels(frame.payload);
        if (rc) {
          this.lastRcChannels = rc;
          this.emit('rc-channels', rc);
        }
      } else if (frame.msgId === MSG_MISSION_COUNT) {
        const p = frame.payload;
        if (p.length >= 2 && this._missionFetch) {
          const count = p.readUInt16LE(0);
          this._missionFetch.expected = count;
          this._missionFetch.items.clear();
          if (count === 0) this._completeMissionFetch();
          else for (let s = 0; s < count; s += 1) this._sendMissionRequest(s);
        }
      } else if (frame.msgId === MSG_MISSION_ITEM_INT || frame.msgId === MSG_MISSION_ITEM) {
        const p = frame.payload;
        const mf = this._missionFetch;
        if (mf && mf.expected != null && p.length >= 2) {
          let wp = parseMissionWaypoint(frame);
          if (!wp) wp = { seq: p.readUInt16LE(0), command: 0, lat: null, lon: null };
          mf.items.set(wp.seq, wp);
          if (mf.items.size >= mf.expected) this._completeMissionFetch();
        }
      }
      this.emit('message', frame);
    }
    if (lastEnd > 0) this._buf = this._buf.slice(lastEnd);
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  /**
   * Start sending a GCS heartbeat to the FC at the given interval.
   * ArduPilot triggers GCS failsafe if it receives no GCS heartbeat for >5 s (FS_GCS_ENABL).
   * MAV_TYPE_GCS=6, MAV_AUTOPILOT_INVALID=8, base_mode=0, custom_mode=0, system_status=4 (MAV_STATE_ACTIVE)
   */
  startHeartbeat(intervalMs = 1000) {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      try {
        // HEARTBEAT payload: custom_mode(4B LE) + type(1) + autopilot(1) + base_mode(1) + system_status(1) + mavlink_version(1)
        const payload = Buffer.alloc(9);
        payload.writeUInt32LE(0, 0);   // custom_mode = 0
        payload[4] = 6;                 // type = MAV_TYPE_GCS
        payload[5] = 8;                 // autopilot = MAV_AUTOPILOT_INVALID
        payload[6] = 0;                 // base_mode = 0 (not armed, no flags)
        payload[7] = 4;                 // system_status = MAV_STATE_ACTIVE
        payload[8] = 3;                 // mavlink_version = 3
        this._send(buildMavlink1Frame(MSG_HEARTBEAT, payload, this._seq++));
      } catch (err) {
        logger.warn({ err: err.message, id: this.id }, 'GCS heartbeat send error');
      }
    }, intervalMs);
    logger.info({ id: this.id, intervalMs }, 'GCS heartbeat started');
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
      logger.info({ id: this.id }, 'GCS heartbeat stopped');
    }
  }

  disconnect() {
    this.stopHeartbeat();
    try {
      if (this._socket) {
        if (this.type === 'udp')                              this._socket.close();
        else if (this.type === 'tcp')                         this._socket.destroy();
        else if (this.type === 'serial' || this.type === 'telemetry') this._socket.close?.();
      }
    } catch { /* ignore */ }
    this._socket = null;
    this.connected = false;
    this.listening = false;
    this.emit('disconnected');
    logger.info({ id: this.id }, 'MAVLink connection closed');
  }

  getStatus() {
    const now = Date.now();
    const lastHbMs = this.lastHeartbeatAt ? (now - Date.parse(this.lastHeartbeatAt)) : null;
    const uptimeMs = this.connectedAt ? (now - Date.parse(this.connectedAt)) : null;
    const hbRate = this.firstHeartbeatAt && this.heartbeatCount > 1
      ? this.heartbeatCount / Math.max(1, (now - Date.parse(this.firstHeartbeatAt)) / 1000)
      : null;
    return {
      id: this.id, name: this.name, type: this.type,
      host: this.host, port: this.port,
      serialPort: this.serialPort, baudRate: this.baudRate,
      connected: this.connected, listening: this.listening,
      remoteAddr: this.remoteAddr, sysId: this.sysId,
      vehicleType: this.vehicleType, autopilotName: this.autopilotName,
      connectedAt: this.connectedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatAgeMs: lastHbMs,
      uptimeMs,
      heartbeatCount: this.heartbeatCount,
      heartbeatRateHz: hbRate != null ? Number(hbRate.toFixed(2)) : null,
      bytesRx: this.bytesRx,
      bytesTx: this.bytesTx,
      framesRx: this.framesRx,
      framesTx: this.framesTx,
      droppedBytes: this.droppedBytes,
      lastError: this.lastError,
      paramCount: Object.keys(this.params).length,
      totalParamCount: this.paramCount,
      recentStatusTexts: this.statusTexts.slice(0, 10),
    };
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────
const _active = new Map();

export function getConnectionStatus(id)    { return _active.get(id)?.getStatus() ?? null; }
export function getAllConnectionStatuses()  { return [..._active.values()].map((c) => c.getStatus()); }
export function getConnectionParams(id)    { return _active.get(id)?.params ?? null; }
/** @returns {MavlinkConnection | null} */
export function getMavlinkConnection(id) {
  const k = Number(id);
  return _active.get(k) ?? _active.get(id) ?? null;
}
/** Returns the first active MavlinkConnection instance, or null. Used by advisor-apply for ARMED checks. */
export function getActiveConnection()      { return _active.size > 0 ? [..._active.values()][0] : null; }

export async function activateConnection(config) {
  if (_active.has(config.id)) { _active.get(config.id).disconnect(); _active.delete(config.id); }
  const conn = new MavlinkConnection(config);
  conn.on('heartbeat',   (hb) => logger.info({ connId: config.id, sysId: hb.sysId, type: hb.vehicleType }, 'MAVLink heartbeat'));
  conn.on('statustext',  ({ severity, text }) => logger.info({ connId: config.id, severity }, `FC: ${text}`));
  conn.on('param',       (pv) => logger.debug({ connId: config.id, name: pv.name, value: pv.value }, 'FC param'));
  conn.on('error',       (err) => logger.warn({ connId: config.id, err: err.message }, 'MAVLink error'));
  conn.on('connected',   () => {
    // Start GCS heartbeat immediately so ArduPilot doesn't trigger GCS failsafe.
    conn.startHeartbeat(1000);
    // Pull params after first FC heartbeat so sysId / fcTargetCompId are known (not default-only).
    let paramPullScheduled = false;
    const scheduleParamPull = (delayMs) => {
      if (paramPullScheduled || !conn.connected) return;
      paramPullScheduled = true;
      setTimeout(() => {
        if (conn.connected && Object.keys(conn.params).length === 0) conn.requestParams();
      }, delayMs);
    };
    conn.on('heartbeat', ({ sysId }) => {
      if (sysId != null && sysId !== GCS_SYS_ID) scheduleParamPull(400);
    });
    setTimeout(() => { if (conn.connected && Object.keys(conn.params).length === 0) conn.requestParams(); }, 2500);
    setTimeout(() => { if (conn.connected && Object.keys(conn.params).length === 0) conn.requestParams(); }, 8000);
  });
  await conn.connect();
  _active.set(config.id, conn);
  return conn;
}

export function deactivateConnection(id) {
  if (_active.has(id)) { _active.get(id).disconnect(); _active.delete(id); return true; }
  return false;
}

/** List available serial ports on this machine. */
export async function listSerialPorts() {
  try {
    const { SerialPort } = await import('serialport');
    return await SerialPort.list();
  } catch {
    return [];
  }
}
