/**
 * Map Jetson Companion API v1 wire objects into console states + SSE compatibility fields.
 * Missing numerics stay null — never coerce to 0.
 */

import {
  flattenCompanionConfig,
  mapFcMessageCategories,
  mapPolicyPreview,
  videoPipelineUiState,
} from './companion-display.mjs';

export const COMPANION_STATES = Object.freeze({
  OK: "OK",
  DISCONNECTED: "DISCONNECTED",
  DEGRADED: "DEGRADED",
  NOT_PRESENT: "NOT_PRESENT",
  DISABLED: "DISABLED",
  WAITING_FOR_HARDWARE: "WAITING_FOR_HARDWARE",
  STALE: "STALE",
});

const STATE_SET = new Set(Object.values(COMPANION_STATES));

export function isCompanionState(value) {
  return STATE_SET.has(String(value || ""));
}

export function normalizeCompanionState(value, fallback = COMPANION_STATES.DISCONNECTED) {
  const s = String(value || "").trim().toUpperCase().replace(/ /g, "_");
  if (STATE_SET.has(s)) return s;
  const aliases = {
    HEALTHY: COMPANION_STATES.OK,
    ONLINE: COMPANION_STATES.OK,
    CONNECTED: COMPANION_STATES.OK,
    VALID: COMPANION_STATES.OK,
    OFFLINE: COMPANION_STATES.DISCONNECTED,
    UNKNOWN: COMPANION_STATES.DISCONNECTED,
    ABSENT: COMPANION_STATES.NOT_PRESENT,
    MISSING: COMPANION_STATES.NOT_PRESENT,
    WAITING: COMPANION_STATES.WAITING_FOR_HARDWARE,
    UNAVAILABLE: COMPANION_STATES.WAITING_FOR_HARDWARE,
  };
  return aliases[s] || fallback;
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function qualityConfidence(q) {
  const o = obj(q);
  if (!o || o.confidence == null || o.confidence === "") return null;
  return finiteOrNull(o.confidence);
}

/** Schema default Quality.unknown() is 0 — that is missing, not a measurement. */
function measuredOrNull(value, live) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  if (!live && n === 0) return null;
  return n;
}

function pipelineLive(name) {
  const s = String(name || "").trim().toLowerCase();
  if (!s || s === "none" || s === "stopped" || s === "unavailable" || s === "off" || s === "idle") {
    return false;
  }
  return true;
}

function healthToState(health, fallback) {
  if (health === "valid") return COMPANION_STATES.OK;
  if (health === "degraded") return COMPANION_STATES.DEGRADED;
  if (health === "unavailable") return COMPANION_STATES.WAITING_FOR_HARDWARE;
  return fallback;
}

function validityToState(validity, fallback) {
  if (validity === "valid") return COMPANION_STATES.OK;
  if (validity === "stale") return COMPANION_STATES.STALE;
  if (validity === "invalid") return fallback;
  return fallback;
}

function ramPct(system) {
  const used = finiteOrNull(system.ram_used_mb);
  const total = finiteOrNull(system.ram_total_mb);
  if (used == null || total == null || total === 0) return null;
  return (used / total) * 100;
}

/**
 * @param {object} raw  GET /api/v1/status plus optional sibling payloads
 * @param {{ now?: number }} [opts]
 */
export function mapCompanionStatus(raw, opts = {}) {
  const now = opts.now ?? Date.now();
  const src = obj(raw) || {};
  const system = obj(src.system) || {};
  const fc = obj(src.fc) || {};
  const mavlink = obj(src.mavlink) || {};
  const channels = obj(src.channels) || {};
  const vision = obj(src.vision) || {};
  const navigation = obj(src.navigation) || {};
  const landing = obj(src.landing) || {};
  const video = obj(src.video) || {};
  const visionResult = obj(src.visionResult) || obj(src.extras?.visionResult) || {};
  const navEstimate = obj(src.navigationEstimate) || obj(src.extras?.navigationEstimate) || {};
  const diagnostics = obj(src.diagnostics) || obj(src.extras?.diagnostics) || null;
  const target = visionResult.landing_target ?? landing.target ?? null;

  const snapshotPresent = src.timestamp != null;
  const transitionalStatus = src.status || src.overall || null;
  const fcValidity = obj(fc.heartbeat)?.validity || null;
  const visionHealth = vision.health || visionResult.health || null;
  const navValidity = navEstimate.validity || navigation.validity || null;
  const landingValidity = landing.validity || null;

  const states = {
    overall: COMPANION_STATES.DISCONNECTED,
    system: snapshotPresent ? COMPANION_STATES.OK : COMPANION_STATES.DISCONNECTED,
    fc: validityToState(fcValidity, COMPANION_STATES.DISCONNECTED),
    mavlink:
      mavlink.connected === true
        ? mavlink.heartbeat_ok === false
          ? COMPANION_STATES.STALE
          : COMPANION_STATES.OK
        : COMPANION_STATES.DISCONNECTED,
    channels: snapshotPresent ? COMPANION_STATES.OK : COMPANION_STATES.DISCONNECTED,
    vision: healthToState(visionHealth, snapshotPresent ? COMPANION_STATES.WAITING_FOR_HARDWARE : COMPANION_STATES.DISCONNECTED),
    navigation: healthToState(navigation.health, validityToState(navValidity, COMPANION_STATES.WAITING_FOR_HARDWARE)),
    landing: landingValidity
      ? validityToState(landingValidity, COMPANION_STATES.DISABLED)
      : snapshotPresent
        ? COMPANION_STATES.DISABLED
        : COMPANION_STATES.DISCONNECTED,
    video: pipelineLive(video.raw_pipeline)
      ? video.annotated_fps == null && visionHealth === "degraded"
        ? COMPANION_STATES.DEGRADED
        : COMPANION_STATES.OK
      : snapshotPresent
        ? COMPANION_STATES.NOT_PRESENT
        : COMPANION_STATES.DISCONNECTED,
  };

  if (!snapshotPresent && transitionalStatus) {
    states.overall = normalizeCompanionState(transitionalStatus);
    states.system = normalizeCompanionState(system.status || transitionalStatus, states.overall);
    if (fc.status) states.fc = normalizeCompanionState(fc.status, states.fc);
    if (mavlink.status) states.mavlink = normalizeCompanionState(mavlink.status, states.mavlink);
    if (vision.status) states.vision = normalizeCompanionState(vision.status, states.vision);
  } else if (navValidity === "stale" || landingValidity === "stale") {
    states.overall = COMPANION_STATES.STALE;
  } else if (visionHealth === "degraded" || navigation.health === "degraded") {
    states.overall = COMPANION_STATES.DEGRADED;
  } else if (snapshotPresent && mavlink.connected === false) {
    states.overall = COMPANION_STATES.WAITING_FOR_HARDWARE;
  } else if (snapshotPresent) {
    states.overall = COMPANION_STATES.OK;
  }

  if (states.overall === COMPANION_STATES.DEGRADED || states.mavlink === COMPANION_STATES.STALE) {
    states.channels = COMPANION_STATES.DEGRADED;
  }

  const visionLive = visionHealth === "valid" || visionHealth === "degraded";
  const navLive = navigation.health === "valid" || navigation.health === "degraded" || navValidity === "valid";
  const landingLive = landingValidity === "valid";
  const confFromStatus = measuredOrNull(qualityConfidence(vision.quality), visionLive);
  const confFromResult = visionResult.validity === "valid" ? qualityConfidence(visionResult.quality) : null;
  const confidence = confFromStatus ?? confFromResult;
  const frameIdRaw = finiteOrNull(visionResult.frame_id);
  const frameId =
    frameIdRaw == null || frameIdRaw < 0 ? null : measuredOrNull(frameIdRaw, vision.running === true);
  const pos = Array.isArray(navEstimate.position_m) ? navEstimate.position_m : null;

  const mapped = {
    api: "v1",
    overall: states.overall,
    connected: snapshotPresent,
    version: src.companion_version || src.version || null,
    states,
    timestamp: src.timestamp ?? null,
    system: {
      status: states.system,
      cpu_percent: finiteOrNull(system.cpu_percent),
      ram_used_mb: finiteOrNull(system.ram_used_mb),
      ram_total_mb: finiteOrNull(system.ram_total_mb),
      gpu_percent: finiteOrNull(system.gpu_percent),
      temperature_c: finiteOrNull(system.temperature_c),
      disk_used_percent: finiteOrNull(system.disk_used_percent),
      cpuLoadPct: finiteOrNull(system.cpu_percent),
      tempC: finiteOrNull(system.temperature_c),
      memPct: ramPct(system),
    },
    fc: {
      status: states.fc,
      connected: fcValidity === "valid" ? true : fcValidity === "invalid" ? false : null,
      heartbeat: fcValidity === "valid" ? true : fcValidity === "invalid" ? false : null,
      heartbeat_validity: fcValidity,
      armed: boolOrNull(fc.armed),
      custom_mode: finiteOrNull(fc.custom_mode),
      system_id: obj(fc.heartbeat)?.system_id ?? null,
      component_id: obj(fc.heartbeat)?.component_id ?? null,
      firmware: fc.firmware ?? obj(fc.heartbeat)?.fields?.autopilot ?? null,
      message_categories: mapFcMessageCategories(fc),
    },
    mavlink: {
      status: states.mavlink,
      router_running: boolOrNull(mavlink.router_running),
      connected: boolOrNull(mavlink.connected),
      heartbeat_ok: boolOrNull(mavlink.heartbeat_ok),
      messages_sent: finiteOrNull(mavlink.messages_sent),
      messages_received: finiteOrNull(mavlink.messages_received),
      messages_dropped: finiteOrNull(mavlink.messages_dropped),
      rx_drop_rate: finiteOrNull(mavlink.rx_drop_rate),
      last_heartbeat: mavlink.last_heartbeat ?? null,
      stale: states.mavlink === COMPANION_STATES.STALE,
      ageMs: null,
    },
    channels: {
      status: states.channels,
      rc: channels.rc ?? null,
      rfd: channels.rfd900x ?? channels.rfd ?? null,
      rfd900x: channels.rfd900x ?? null,
      gcs4g: channels.gcs_tailscale ?? channels.gcs4g ?? null,
      gcs_tailscale: channels.gcs_tailscale ?? null,
      vision_loopback: channels.vision_loopback ?? null,
    },
    vision: {
      status: states.vision,
      running: boolOrNull(vision.running),
      health: visionHealth,
      fps: measuredOrNull(vision.fps, vision.running === true),
      latency_ms: measuredOrNull(visionResult.latency_ms ?? vision.latency_ms, visionLive),
      camera_ok: boolOrNull(vision.camera_ok),
      source_id: vision.source_id || visionResult.source || null,
      confidence,
      angle_x_rad: target ? finiteOrNull(target.angle_x_rad) : null,
      angle_y_rad: target ? finiteOrNull(target.angle_y_rad) : null,
      range_m: target ? finiteOrNull(target.distance_m) : null,
      target_id: target?.marker_id ?? target?.target_num ?? null,
      validity: visionResult.validity || null,
      frame_id: frameId,
      timestamp: visionResult.timestamp ?? vision.last_valid ?? null,
      angleXDeg: null,
      angleYDeg: null,
      rangeM: target ? finiteOrNull(target.distance_m) : null,
      lateralOffsetM: null,
      headingErrorDeg: null,
      valid: visionResult.validity === "valid" ? true : visionResult.validity ? false : null,
      markerId: target?.marker_id ?? null,
      ts: null,
      ageMs: null,
      last_valid: vision.last_valid ?? null,
      quality_label: obj(vision.quality)?.label || obj(visionResult.quality)?.label || null,
      detections: Array.isArray(visionResult.detections)
        ? visionResult.detections
        : Array.isArray(landing.detections)
          ? landing.detections
          : [],
    },
    navigation: {
      status: states.navigation,
      source: navEstimate.source || navigation.active_source || null,
      active_source: navigation.active_source || navEstimate.source || null,
      health: navigation.health || null,
      label: "Companion / Vision Navigation Estimate",
      ekf_injected: false,
      last_update: navigation.last_update || navEstimate.timestamp || null,
      validity: navValidity,
      confidence:
        measuredOrNull(qualityConfidence(navEstimate.quality), navLive) ??
        measuredOrNull(qualityConfidence(navigation.quality), navLive),
      posX: pos ? finiteOrNull(pos[0]) : null,
      posY: pos ? finiteOrNull(pos[1]) : null,
      posZ: pos ? finiteOrNull(pos[2]) : null,
      velocity_m_s: Array.isArray(navEstimate.velocity_m_s) ? navEstimate.velocity_m_s : null,
      attitude_rpy_rad: Array.isArray(navEstimate.attitude_rpy_rad) ? navEstimate.attitude_rpy_rad : null,
      position_frame: navEstimate.position_frame || null,
      attitude_frame: navEstimate.attitude_frame || null,
      covariance: Array.isArray(navEstimate.covariance) ? navEstimate.covariance : null,
      position_m: pos,
      yawDeg: null,
      ts: null,
      ageMs: null,
    },
    landing: {
      status: states.landing,
      validity: landingValidity,
      confidence: measuredOrNull(qualityConfidence(landing.quality), landingLive),
      source: landing.source || null,
      target: target && landingValidity === "stale" ? null : target,
      detected: !!(target && landingValidity === "valid"),
      display_only: true,
      angle_x_rad: target ? finiteOrNull(target.angle_x_rad) : null,
      angle_y_rad: target ? finiteOrNull(target.angle_y_rad) : null,
      range_m: target ? finiteOrNull(target.distance_m) : null,
      marker_id: target?.marker_id ?? null,
      frame: target?.frame ?? null,
      timestamp: landing.timestamp ?? null,
    },
    video: {
      status: states.video,
      raw_pipeline: video.raw_pipeline || null,
      annotated_pipeline: video.annotated_pipeline || null,
      raw_ui: videoPipelineUiState(video.raw_pipeline, { degraded: visionHealth === "degraded" }),
      annotated_ui: videoPipelineUiState(video.annotated_pipeline, { degraded: visionHealth === "degraded" }),
      raw_fps: measuredOrNull(video.raw_fps, pipelineLive(video.raw_pipeline)),
      annotated_fps: measuredOrNull(video.annotated_fps, pipelineLive(video.annotated_pipeline)),
      bitrate_kbps: measuredOrNull(video.bitrate_kbps, pipelineLive(video.raw_pipeline)),
      rawAvailable: video.raw_pipeline == null || video.raw_pipeline === "" ? null : pipelineLive(video.raw_pipeline),
      annotatedAvailable:
        video.annotated_pipeline == null || video.annotated_pipeline === ""
          ? null
          : pipelineLive(video.annotated_pipeline),
      fps: measuredOrNull(video.raw_fps, pipelineLive(video.raw_pipeline)),
      latencyMs: measuredOrNull(vision.latency_ms, visionLive),
      resolution: video.resolution || null,
    },
    diagnostics,
    config: flattenCompanionConfig(src.config),
    policy: mapPolicyPreview(src.policy),
    policyPreview: src.policyPreview || null,
    api_version: src.api_version || "v1",
  };

  mapped.compatibility = {
    transitional: true,
    jetson: {
      online: snapshotPresent || states.system === COMPANION_STATES.OK || states.system === COMPANION_STATES.DEGRADED,
      ageMs: null,
      cpuLoadPct: mapped.system.cpuLoadPct,
      tempC: mapped.system.tempC,
      memPct: mapped.system.memPct,
      linkQualityPct: null,
      agentVersion: mapped.version,
      companionStatus: states.system,
      companionApi: true,
    },
    vision: {
      lateralOffsetM: null,
      headingErrorDeg: null,
      confidence,
      frameTimestamp: null,
      frameCount: mapped.vision.frame_id,
      ageMs: null,
      companionStatus: states.vision,
      companionActive: snapshotPresent,
      fps: mapped.vision.fps,
      latencyMs: mapped.vision.latency_ms,
      cameraOk: mapped.vision.camera_ok,
    },
    slam: {
      posX: mapped.navigation.posX,
      posY: mapped.navigation.posY,
      posZ: mapped.navigation.posZ,
      yawDeg: null,
      mapQuality: mapped.navigation.confidence,
      loopClosures: null,
      frameTimestamp: null,
      ageMs: null,
      companionStatus: states.navigation,
      companionActive: snapshotPresent,
    },
    visionNav: {
      mode: null,
    },
  };

  void now;
  return mapped;
}

export function emptyCompanionMapped(reason = COMPANION_STATES.DISCONNECTED) {
  const m = mapCompanionStatus(null);
  m.overall = normalizeCompanionState(reason, COMPANION_STATES.DISCONNECTED);
  m.states.overall = m.overall;
  return m;
}
