import { remoteUpdateCheckPaused } from './qa-mode.mjs';

/**
 * Simulator vs real aircraft.
 * A link is a simulator only from an explicit preset, an autopilot version
 * string that says SITL, or a SIM_* parameter the vehicle already reported.
 * A normal ArduPilot heartbeat is not enough. Nothing here writes parameters
 * or sends a flight command.
 */

export const SIMULATOR_PRESET_ID = 'simulator';
export const SIMULATOR_PRESET_NAME = 'סימולטור';
export const SIMULATOR_TCP_HOST = '127.0.0.1';
export const SIMULATOR_TCP_PORT = 5760;
export const SIMULATOR_GCS_UDP_PORT = 14550;

export const SIMULATOR_UNAVAILABLE_HE = 'הסימולטור המקומי לא זמין. הפעילו אותו במחשב ואז נסו שוב.';
export const SIMULATOR_PORT_BLOCKED_HE = 'יציאת הסימולטור חסומה.';

const SIM_PARAM_NAME = /^SIM_[A-Z0-9_]+$/;
const AUTOPILOT_VERSION_MIN_BYTES = 60;
const SITL_PORT_MIN = 5760;
const SITL_PORT_MAX = 5859;
const SIMULATOR_RELAY_PORT = 5770;
const FREE_PORTS_ENV = 'VLC_SIM_FREE_PORTS';

export function isSimulatorPreset(preset) {
  return preset === SIMULATOR_PRESET_ID || preset === SIMULATOR_PRESET_NAME;
}

function listenPort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function qaFlagOn(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

/** Body and env overrides exist only for tests, QA, and the opt-in SITL run. */
export function simulatorOverrideEnabled(env = process.env) {
  return remoteUpdateCheckPaused(env) || qaFlagOn(env.RUN_SITL_E2E);
}

function readFreePorts(env) {
  return String(env[FREE_PORTS_ENV] || '')
    .split(',')
    .map((part) => listenPort(part.trim()))
    .filter((n) => n != null);
}

/** Remember a port from tests/test-server.mjs freePort so a child console can dial it. */
export function registerSimulatorTestPort(port, env = process.env) {
  const n = listenPort(port);
  if (n == null) return null;
  const have = new Set(readFreePorts(env));
  have.add(n);
  env[FREE_PORTS_ENV] = [...have].join(',');
  return n;
}

/**
 * Test mode accepts the SITL range except the relay port, plus ports the test helper issued.
 * The console's own PORT is never a simulator port.
 */
export function simulatorPortAllowed(port, env = process.env) {
  const n = listenPort(port);
  if (n == null) return false;
  if (n === SIMULATOR_RELAY_PORT) return false;
  const own = listenPort(env.PORT);
  if (own != null && n === own) return false;
  if (n >= SITL_PORT_MIN && n <= SITL_PORT_MAX) return true;
  return readFreePorts(env).includes(n);
}

/**
 * Product default stays 5760. Production ignores simulatorPort and SIMULATOR_TCP_PORT.
 * A test override is honored only while the qa-mode pause or RUN_SITL_E2E is set,
 * and only for an allowlisted SITL port.
 * @returns {{ ok: true, port: number } | { ok: false, port: number, message: string }}
 */
export function resolveSimulatorTcpPort(override, env = process.env) {
  if (!simulatorOverrideEnabled(env)) {
    return { ok: true, port: SIMULATOR_TCP_PORT };
  }
  const chosen = listenPort(override) ?? listenPort(env.SIMULATOR_TCP_PORT);
  if (chosen == null) return { ok: true, port: SIMULATOR_TCP_PORT };
  if (!simulatorPortAllowed(chosen, env)) {
    return { ok: false, port: chosen, message: SIMULATOR_PORT_BLOCKED_HE };
  }
  return { ok: true, port: chosen };
}

/** Product default stays 5760. A test passes simulatorPort or SIMULATOR_TCP_PORT. */
export function simulatorTcpPort(override) {
  const resolved = resolveSimulatorTcpPort(override);
  if (!resolved.ok) {
    const err = new Error(resolved.message);
    err.code = 'SIMULATOR_PORT_BLOCKED';
    throw err;
  }
  return resolved.port;
}

/** The Hebrew סימולטור pill waits for a vehicle heartbeat on a live link. */
export function simulatorLabelFromDetection(detection, { linkUp = false, heartbeatCount = 0 } = {}) {
  const on = linkUp === true && detection?.simulator === true && Number(heartbeatCount) > 0;
  return {
    simulator: on,
    simulatorReason: on ? detection.reason : null,
  };
}

export function simulatorRadioTarget(override) {
  return Object.freeze({
    type: 'tcp',
    host: SIMULATOR_TCP_HOST,
    port: simulatorTcpPort(override),
  });
}

/**
 * Explicit preset forces the local SITL endpoint.
 * A stored name alone marks the session for the badge and does not rewrite the endpoint.
 */
export function applySimulatorPreset(input = {}) {
  const explicit = input.simulatorPreset === true || isSimulatorPreset(input.preset);
  if (!explicit) {
    return {
      ...input,
      simulatorPreset: input.name === SIMULATOR_PRESET_NAME,
    };
  }
  const udp = input.type === 'udp' || input.transport === 'udp';
  if (!udp) {
    const resolved = resolveSimulatorTcpPort(input.simulatorPort);
    if (!resolved.ok) {
      return {
        ...input,
        simulatorPreset: true,
        simulatorPortRefused: true,
        message: resolved.message,
      };
    }
  }
  const target = udp
    ? { type: 'udp', host: '0.0.0.0', port: SIMULATOR_GCS_UDP_PORT }
    : simulatorRadioTarget(input.simulatorPort);
  return {
    ...input,
    type: target.type,
    host: target.host,
    port: target.port,
    serialPort: null,
    via: undefined,
    name: SIMULATOR_PRESET_NAME,
    simulatorPreset: true,
    preset: SIMULATOR_PRESET_ID,
  };
}

export function versionTextLooksLikeSitl(text) {
  if (typeof text !== 'string') return false;
  const s = text.replace(/\0/g, '').trim();
  if (!s) return false;
  if (/\bnot\s+sitl\b/i.test(s)) return false;
  return /\bSITL\b/i.test(s);
}

export function autopilotVersionLooksLikeSitl(version) {
  if (!version || typeof version !== 'object') return false;
  const fields = [
    version.flightCustomVersion,
    version.middlewareCustomVersion,
    version.osCustomVersion,
    version.flight_custom_version,
    version.middleware_custom_version,
    version.os_custom_version,
  ];
  return fields.some((field) => versionTextLooksLikeSitl(field));
}

export function paramsLookLikeSitl(params) {
  if (!params || typeof params !== 'object') return false;
  return Object.keys(params).some((key) => SIM_PARAM_NAME.test(String(key).trim().toUpperCase()));
}

/**
 * @returns {{ simulator: boolean, reason: 'preset'|'autopilot-version'|'sim-params'|null }}
 */
export function detectSimulatorVehicle(input = {}) {
  if (input.simulatorPreset === true || isSimulatorPreset(input.preset) || input.name === SIMULATOR_PRESET_NAME) {
    return { simulator: true, reason: 'preset' };
  }
  if (autopilotVersionLooksLikeSitl(input.autopilotVersion)) {
    return { simulator: true, reason: 'autopilot-version' };
  }
  if (paramsLookLikeSitl(input.params)) {
    return { simulator: true, reason: 'sim-params' };
  }
  return { simulator: false, reason: null };
}

function customVersion(buf, offset) {
  return buf.slice(offset, offset + 8).toString('latin1').replace(/\0/g, '').trim();
}

/**
 * AUTOPILOT_VERSION (#148) MAVLink 2 wire order:
 * capabilities u64, uid u64, four u32 versions, vendor u16, product u16,
 * then three 8-byte custom version strings.
 */
export function parseAutopilotVersion(payload) {
  if (!payload || payload.length < AUTOPILOT_VERSION_MIN_BYTES) return null;
  return {
    flightSwVersion: payload.readUInt32LE(16),
    middlewareSwVersion: payload.readUInt32LE(20),
    osSwVersion: payload.readUInt32LE(24),
    boardVersion: payload.readUInt32LE(28),
    flightCustomVersion: customVersion(payload, 36),
    middlewareCustomVersion: customVersion(payload, 44),
    osCustomVersion: customVersion(payload, 52),
  };
}

export function simulatorConnectFailureMessage(err, simulatorPreset) {
  if (!simulatorPreset) return null;
  const code = err?.code || '';
  const msg = String(err?.message || err || '');
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' || /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|connect/i.test(msg)) {
    return SIMULATOR_UNAVAILABLE_HE;
  }
  return SIMULATOR_UNAVAILABLE_HE;
}
