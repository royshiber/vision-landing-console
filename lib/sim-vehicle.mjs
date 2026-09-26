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

const SIM_PARAM_NAME = /^SIM_[A-Z0-9_]+$/;
const AUTOPILOT_VERSION_MIN_BYTES = 60;

export function isSimulatorPreset(preset) {
  return preset === SIMULATOR_PRESET_ID || preset === SIMULATOR_PRESET_NAME;
}

export function simulatorRadioTarget() {
  return Object.freeze({
    type: 'tcp',
    host: SIMULATOR_TCP_HOST,
    port: SIMULATOR_TCP_PORT,
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
  const target = simulatorRadioTarget();
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
