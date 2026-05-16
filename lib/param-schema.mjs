const COMPANION_PORT_MIN = 1;
const COMPANION_PORT_MAX = 8;
const COMPANION_DEFAULT_PORT = 2;
const COMPANION_DEFAULT_SR = 2;

const SERIAL_PROTOCOL_OPTIONS = [0, 1, 2];
const SERIAL_BAUD_CODE_OPTIONS = [9, 19, 38, 57, 115, 230, 460, 921];
const SR_RATE_RANGE = { min: 0, max: 50 };

export const JETSON_NUMERIC_SCHEMA = {
  flare_alt_m: { min: 1, max: 30 },
  laser_detect_alt_m: { min: 1, max: 40 },
  flare_pitch_up_deg: { min: 1, max: 20 },
  motor_hold_s: { min: 0, max: 8 },
  vision_enable_alt_m: { min: 5, max: 120 },
  vision_conf_min: { min: 0.4, max: 0.99 },
  abort_conf_min: { min: 0.3, max: 0.95 },
  abort_conf_hold_s: { min: 0.5, max: 8 },
  abort_recover_conf: { min: 0.35, max: 0.99 },
  xtrack_gain: { min: 0.1, max: 3.5 },
  yaw_align_gain: { min: 0.1, max: 2.5 },
  approach_speed_ms: { min: 8, max: 35 },
  sink_rate_ms: { min: 0.3, max: 4 },
  max_roll_deg: { min: 5, max: 35 },
  abort_max_xtrack_m: { min: 0.5, max: 12 },
  abort_max_heading_deg: { min: 5, max: 80 },
  to_rotate_speed_ms: { min: 6, max: 30 },
  to_pitch_deg: { min: 4, max: 20 },
  to_max_crosswind_ms: { min: 1, max: 20 },
  to_min_gps_sats: { min: 10, max: 40 },
  to_motor_spool_s: { min: 0.5, max: 8 },
  to_abort_speed_loss_ms: { min: 0.5, max: 8 },
};

/**
 * Canonical numeric bounds for FC params the advisor may propose via `param_change` (DISARMED-only).
 * Wider UI / patch bounds stay in FC_STATIC_SCHEMA; advisor writes use this table so min/max cannot drift
 * between lib/advisor-actions.mjs and param-schema.
 */
export const FC_ADVISOR_WRITE_BOUNDS = {
  LAND_SPEED: { min: 50, max: 300 },
  LAND_PITCH_DEG: { min: 0, max: 8 },
  LAND_FLARE_ALT: { min: 1, max: 8 },
  LAND_FLARE_SEC: { min: 1, max: 5 },
};

export const FC_STATIC_SCHEMA = {
  EK3_ENABLE: { kind: 'bool' },
  AHRS_EKF_TYPE: { kind: 'enum', options: [2, 3] },
  EK3_GPS_TYPE: { kind: 'enum', options: [0, 1, 2, 3] },
  EK3_ALT_SOURCE: { kind: 'enum', options: [0, 1, 2, 3] },
  PLND_ENABLED: { kind: 'bool' },
  PLND_TYPE: { kind: 'enum', options: [0, 1, 2, 3, 4, 5] },
  PLND_BUS: { kind: 'number', min: 0, max: 10 },
  PLND_LAG: { kind: 'number', min: 0, max: 1 },
  PLND_XY_DIST_MAX: { kind: 'number', min: 0, max: 50 },
  PLND_STRICT: { kind: 'enum', options: [0, 1] },
  LOG_DISARMED: { kind: 'bool' },
  LOG_REPLAY: { kind: 'bool' },
  LOG_BITMASK: { kind: 'bitmask', min: 0, max: 2147483647 },
  LAND_SPEED: { kind: 'number', min: 10, max: 300 },
  LAND_SPEED_HIGH: { kind: 'number', min: 0, max: 500 },
  LAND_ALT_LOW: { kind: 'number', min: 0, max: 5000 },
  LAND_ABORT_PWM: { kind: 'number', min: 800, max: 2200 },
  /** Centidegrees — ArduPlane max pitch (e.g. 3000 = 30°). */
  LIM_PITCH_CD: { kind: 'number', min: 500, max: 4500 },
  /** Centidegrees — max roll limit. */
  LIM_ROLL_CD: { kind: 'number', min: 500, max: 6500 },
  /** ArduPlane max commanded roll rate (deg/s). */
  RLL2SRV_RMAX: { kind: 'number', min: 0, max: 180 },
  FS_THR_ENABLE: { kind: 'enum', options: [0, 1, 2] },
  FS_THR_VALUE: { kind: 'number', min: 800, max: 1200 },
  ARMING_CHECK: { kind: 'bitmask', min: 0, max: 2147483647 },
};

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function coerceBoolean01(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return 1;
  if (value === false || value === 'false' || value === 0 || value === '0') return 0;
  return null;
}

export function getCompanionPortOptions() {
  const out = [];
  for (let p = COMPANION_PORT_MIN; p <= COMPANION_PORT_MAX; p += 1) out.push(p);
  return out;
}

export function normalizeCompanionLink(raw) {
  const ports = getCompanionPortOptions();
  const wantedPort = toFiniteNumber(raw?.companion_serial_port);
  const wantedSr = toFiniteNumber(raw?.companion_sr_bucket);
  const companion_serial_port = ports.includes(wantedPort) ? wantedPort : COMPANION_DEFAULT_PORT;
  const companion_sr_bucket = ports.includes(wantedSr) ? wantedSr : companion_serial_port;
  return { companion_serial_port, companion_sr_bucket };
}

function buildCommDefaults({ companion_serial_port, companion_sr_bucket }) {
  const out = {};
  for (const p of getCompanionPortOptions()) {
    out[`SERIAL${p}_PROTOCOL`] = p === companion_serial_port ? 2 : 0;
    out[`SERIAL${p}_BAUD`] = p === companion_serial_port ? 921 : 57;
    out[`SR${p}_EXT_STAT`] = p === companion_sr_bucket ? 5 : 0;
    out[`SR${p}_POSITION`] = p === companion_sr_bucket ? 10 : 0;
    out[`SR${p}_RC_CHAN`] = p === companion_sr_bucket ? 5 : 0;
    out[`SR${p}_EXTRA1`] = p === companion_sr_bucket ? 10 : 0;
    out[`SR${p}_EXTRA2`] = p === companion_sr_bucket ? 10 : 0;
  }
  return out;
}

export function buildArduTargetDefaults(rawCompanionLink = {}) {
  const companion = normalizeCompanionLink(rawCompanionLink);
  return {
    ...buildCommDefaults(companion),
    EK3_ENABLE: 1,
    AHRS_EKF_TYPE: 3,
    EK3_GPS_TYPE: 0,
    EK3_ALT_SOURCE: 1,
    PLND_ENABLED: 1,
    PLND_TYPE: 1,
    PLND_BUS: 0,
    PLND_LAG: 0.02,
    PLND_XY_DIST_MAX: 5,
    PLND_STRICT: 0,
    LOG_DISARMED: 1,
    LOG_REPLAY: 1,
    LOG_BITMASK: 65535,
    LAND_SPEED: 50,
    LAND_SPEED_HIGH: 0,
    LAND_ALT_LOW: 1000,
    LAND_ABORT_PWM: 900,
    LIM_PITCH_CD: 3000,
    LIM_ROLL_CD: 4500,
    RLL2SRV_RMAX: 90,
    FS_THR_ENABLE: 1,
    FS_THR_VALUE: 975,
    ARMING_CHECK: 1,
  };
}

/** All FC + SERIAL/SR keys the parameter center can edit (for smart-search whitelist). */
export function listArduParamCenterKeys() {
  return Object.keys(buildArduTargetDefaults()).sort();
}

/** FC/SR defaults plus virtual companion UI keys (smart-search may suggest these; they are not MAV param names). */
export function listParamCenterSmartSearchKeys() {
  const base = listArduParamCenterKeys();
  return [...new Set([...base, 'companion_serial_port', 'companion_sr_bucket'])].sort();
}

export function getParamCenterSchemaPayload() {
  return {
    companion: {
      options: getCompanionPortOptions(),
      default: { companion_serial_port: COMPANION_DEFAULT_PORT, companion_sr_bucket: COMPANION_DEFAULT_SR },
      serialProtocolOptions: SERIAL_PROTOCOL_OPTIONS,
      serialBaudCodeOptions: SERIAL_BAUD_CODE_OPTIONS,
      srRateRange: { ...SR_RATE_RANGE },
    },
    jetsonNumericSchema: JETSON_NUMERIC_SCHEMA,
    fcStaticSchema: FC_STATIC_SCHEMA,
    fcAdvisorWriteBounds: FC_ADVISOR_WRITE_BOUNDS,
  };
}

export function coerceProfilePatch(rawProfile = {}) {
  const accepted = {};
  const rejected = {};
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    return { accepted, rejected: { profile: 'invalid_object' } };
  }

  for (const [key, rawValue] of Object.entries(rawProfile)) {
    if (key in JETSON_NUMERIC_SCHEMA) {
      const spec = JETSON_NUMERIC_SCHEMA[key];
      const n = toFiniteNumber(rawValue);
      if (n == null) {
        rejected[key] = 'not_numeric';
        continue;
      }
      accepted[key] = clamp(n, spec.min, spec.max);
      continue;
    }
    if (key === 'companion_serial_port' || key === 'companion_sr_bucket') {
      const normalized = normalizeCompanionLink({
        companion_serial_port: key === 'companion_serial_port' ? rawValue : rawProfile.companion_serial_port,
        companion_sr_bucket: key === 'companion_sr_bucket' ? rawValue : rawProfile.companion_sr_bucket,
      });
      accepted.companion_serial_port = normalized.companion_serial_port;
      accepted.companion_sr_bucket = normalized.companion_sr_bucket;
      continue;
    }
    rejected[key] = 'unknown_key';
  }
  return { accepted, rejected };
}

export function coerceArduTargetPatch(rawTarget = {}, defaults = buildArduTargetDefaults()) {
  const accepted = {};
  const rejected = {};
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    return { accepted, rejected: { arduTarget: 'invalid_object' } };
  }

  for (const [key, rawValue] of Object.entries(rawTarget)) {
    if (!(key in defaults)) {
      rejected[key] = 'unknown_key';
      continue;
    }

    const serialProtocolMatch = key.match(/^SERIAL(\d+)_PROTOCOL$/);
    if (serialProtocolMatch) {
      const n = toFiniteNumber(rawValue);
      if (n == null || !SERIAL_PROTOCOL_OPTIONS.includes(n)) {
        rejected[key] = 'invalid_enum';
        continue;
      }
      accepted[key] = n;
      continue;
    }

    const serialBaudMatch = key.match(/^SERIAL(\d+)_BAUD$/);
    if (serialBaudMatch) {
      const n = toFiniteNumber(rawValue);
      if (n == null || !SERIAL_BAUD_CODE_OPTIONS.includes(n)) {
        rejected[key] = 'invalid_enum';
        continue;
      }
      accepted[key] = n;
      continue;
    }

    const srRateMatch = key.match(/^SR(\d+)_(EXT_STAT|POSITION|RC_CHAN|EXTRA1|EXTRA2)$/);
    if (srRateMatch) {
      const n = toFiniteNumber(rawValue);
      if (n == null) {
        rejected[key] = 'not_numeric';
        continue;
      }
      accepted[key] = clamp(n, SR_RATE_RANGE.min, SR_RATE_RANGE.max);
      continue;
    }

    const spec = FC_STATIC_SCHEMA[key];
    if (!spec) {
      rejected[key] = 'unknown_spec';
      continue;
    }

    if (spec.kind === 'bool') {
      const b = coerceBoolean01(rawValue);
      if (b == null) {
        rejected[key] = 'not_bool_01';
        continue;
      }
      accepted[key] = b;
      continue;
    }

    if (spec.kind === 'enum') {
      const n = toFiniteNumber(rawValue);
      if (n == null || !spec.options.includes(n)) {
        rejected[key] = 'invalid_enum';
        continue;
      }
      accepted[key] = n;
      continue;
    }

    const n = toFiniteNumber(rawValue);
    if (n == null) {
      rejected[key] = 'not_numeric';
      continue;
    }
    accepted[key] = clamp(n, spec.min, spec.max);
  }
  return { accepted, rejected };
}
