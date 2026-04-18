/**
 * Why: allow Vision Landing Console to connect directly to FC/Jetson over UDP, TCP, or Serial,
 *      just like Mission Planner, without depending on Jetson HTTP-push being active.
 * What: parses MAVLink 1 & 2 frames, builds and sends MAVLink frames (with correct CRC),
 *       supports UDP (SiK radio / WiFi), TCP, and Serial (USB/COM).
 */

import dgram from 'dgram';
import net from 'net';
import { EventEmitter } from 'events';
import { logger } from './logger.mjs';

// ── MAVLink constants ──────────────────────────────────────────────────────────
const MAVLINK1_STX = 0xfe;
const MAVLINK2_STX = 0xfd;

const MSG_HEARTBEAT          = 0;
const MSG_SYS_STATUS         = 1;
const MSG_PARAM_VALUE        = 22;
const MSG_STATUSTEXT         = 253;
const MSG_PARAM_REQUEST_LIST = 21;

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
const EXTRA_CRC = {
  [MSG_HEARTBEAT]:          50,
  [MSG_SYS_STATUS]:        124,
  [MSG_PARAM_REQUEST_LIST]:159,
  [MSG_PARAM_VALUE]:       220,
  [MSG_STATUSTEXT]:         83,
};

/** Why: build a valid MAVLink 1 frame ready to send over any transport. */
function buildMavlink1Frame(msgId, payload, seq = 0) {
  const len = payload.length;
  const header = Buffer.from([MAVLINK1_STX, len, seq & 0xFF, GCS_SYS_ID, GCS_COMP_ID, msgId]);
  const crcSeed = EXTRA_CRC[msgId] ?? 0;
  const crcBuf  = Buffer.concat([Buffer.from([len, seq & 0xFF, GCS_SYS_ID, GCS_COMP_ID, msgId]), payload, Buffer.from([crcSeed])]);
  const crc     = mavCrc(crcBuf);
  return Buffer.concat([header, payload, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
}

// ── Frame parser ──────────────────────────────────────────────────────────────
function parseMavlinkFrames(buf) {
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
function parseHeartbeat(p) {
  if (p.length < 9) return null;
  const TYPES = { 1: 'Fixed Wing', 2: 'Quadrotor', 13: 'Hexarotor', 0: 'Generic' };
  const APS   = { 3: 'ArduPilot', 12: 'PX4' };
  return { customMode: p.readUInt32LE(0), type: p[4], autopilot: p[5], baseMode: p[6], systemStatus: p[7], mavlinkVersion: p[8], vehicleType: TYPES[p[4]] || `type${p[4]}`, autopilotName: APS[p[5]] || `ap${p[5]}` };
}

function parseStatusText(p) {
  if (p.length < 51) return null;
  return { severity: p[0], text: p.slice(1, 51).toString('utf8').replace(/\0/g, '').trim() };
}

function parseParamValue(p) {
  if (p.length < 25) return null;
  const name  = p.slice(4, 20).toString('utf8').replace(/\0/g, '').trim();
  const value = p.readFloatLE(0);
  const type  = p[20];
  const count = p.readUInt16LE(21);
  const index = p.readUInt16LE(23);
  return { name, value, type, count, index };
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
    this.paramCount   = 0;
    this.remoteAddr   = null;
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
        if (!this.connected) { this.connected = true; this.emit('connected', { remote: this.remoteAddr }); }
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
        this.connected = true; this.listening = true;
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
        this.connected = true; this.listening = true;
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
  _send(buf) {
    if (!this._socket) return;
    try {
      if (this.type === 'udp') {
        const [host, port] = (this.remoteAddr || '').split(':');
        if (host && port) this._socket.send(buf, Number(port), host);
      } else {
        this._socket.write(buf);
      }
    } catch (err) { logger.warn({ err, id: this.id }, 'MAVLink send failed'); }
  }

  /** Request all parameters from the FC. */
  requestParams() {
    const target = this.sysId ?? 1;
    const payload = Buffer.from([target, 1]); // target_system, target_component
    const frame   = buildMavlink1Frame(MSG_PARAM_REQUEST_LIST, payload, this._seq++);
    this._send(frame);
    logger.info({ id: this.id }, 'PARAM_REQUEST_LIST sent');
  }

  // ── Receive ────────────────────────────────────────────────────────────────
  _handleData(data) {
    this._buf = Buffer.concat([this._buf, data]);
    if (this._buf.length > 16384) this._buf = this._buf.slice(this._buf.length - 8192);

    const frames = parseMavlinkFrames(this._buf);
    let lastEnd = 0;
    for (const frame of frames) {
      lastEnd = frame.end;
      if (this.sysId === null) this.sysId = frame.sysId;

      if (frame.msgId === MSG_HEARTBEAT) {
        const hb = parseHeartbeat(frame.payload);
        if (hb) {
          this.lastHeartbeatAt = new Date().toISOString();
          this.vehicleType    = hb.vehicleType;
          this.autopilotName  = hb.autopilotName;
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
          this.paramCount = pv.count;
          this.emit('param', pv);
        }
      }
      this.emit('message', frame);
    }
    if (lastEnd > 0) this._buf = this._buf.slice(lastEnd);
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  disconnect() {
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
    return {
      id: this.id, name: this.name, type: this.type,
      connected: this.connected, listening: this.listening,
      remoteAddr: this.remoteAddr, sysId: this.sysId,
      vehicleType: this.vehicleType, autopilotName: this.autopilotName,
      lastHeartbeatAt: this.lastHeartbeatAt,
      paramCount: Object.keys(this.params).length,
      totalParamCount: this.paramCount,
      recentStatusTexts: this.statusTexts.slice(0, 5),
    };
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────
const _active = new Map();

export function getConnectionStatus(id)    { return _active.get(id)?.getStatus() ?? null; }
export function getAllConnectionStatuses()  { return [..._active.values()].map((c) => c.getStatus()); }
export function getConnectionParams(id)    { return _active.get(id)?.params ?? null; }

export async function activateConnection(config) {
  if (_active.has(config.id)) { _active.get(config.id).disconnect(); _active.delete(config.id); }
  const conn = new MavlinkConnection(config);
  conn.on('heartbeat',   (hb) => logger.info({ connId: config.id, sysId: hb.sysId, type: hb.vehicleType }, 'MAVLink heartbeat'));
  conn.on('statustext',  ({ severity, text }) => logger.info({ connId: config.id, severity }, `FC: ${text}`));
  conn.on('param',       (pv) => logger.debug({ connId: config.id, name: pv.name, value: pv.value }, 'FC param'));
  conn.on('error',       (err) => logger.warn({ connId: config.id, err: err.message }, 'MAVLink error'));
  conn.on('connected',   () => {
    // Automatically request parameters 2 s after connecting (give FC time to send heartbeat first)
    setTimeout(() => { if (conn.connected) conn.requestParams(); }, 2000);
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
