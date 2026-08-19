/** Valid Companion API v1 payloads matching the Jetson OpenAPI. */

export const TS = Object.freeze({ t_monotonic_ns: 1_700_000_000_000, t_utc_ns: null });

function channel(id, notes, extra = {}) {
  return {
    id,
    implementation: extra.implementation || "status_only",
    jetson_in_path: extra.jetson_in_path === true,
    listening: extra.listening ?? null,
    bind: extra.bind ?? null,
    notes,
  };
}

function channels(extra = {}) {
  const listen = extra.listening ?? null;
  return {
    rc: channel("rc", "CHANNEL 1 — RC. Direct: RC → FC. Jetson not involved.", {
      implementation: "fc-receiver",
      jetson_in_path: false,
      listening: null,
      bind: null,
    }),
    rfd900x: channel("rfd900x", "CHANNEL 2 — RFD900X. GCS ↔ RFD900X ↔ FC. Jetson is not a radio endpoint.", {
      implementation: "ardupilot-fc",
      jetson_in_path: false,
      listening: false,
      bind: null,
    }),
    gcs_tailscale: channel("gcs_tailscale", "CHANNEL 3 — 4G / Tailscale. GCS ↔ Tailscale ↔ Jetson ↔ FC.", {
      implementation: "mavlink-router",
      jetson_in_path: true,
      listening: listen,
      bind: extra.gcsBind || null,
    }),
    vision_loopback: channel("vision_loopback", "VISION LOOPBACK 127.0.0.1:14540", {
      implementation: "mavlink-router",
      jetson_in_path: true,
      listening: listen,
      bind: "127.0.0.1:14540",
    }),
  };
}

export function healthyCompanionStatus() {
  return {
    timestamp: { ...TS },
    system: {
      cpu_percent: 41.2,
      ram_used_mb: 4200,
      ram_total_mb: 8000,
      gpu_percent: 22,
      temperature_c: 48.5,
      disk_used_percent: 31,
    },
    mavlink: {
      router_running: true,
      connected: true,
      heartbeat_ok: true,
      messages_sent: 120,
      messages_received: 340,
      messages_dropped: null,
      rx_drop_rate: null,
      last_heartbeat: { ...TS },
    },
    vision: {
      running: true,
      health: "valid",
      fps: 30,
      latency_ms: 42,
      last_valid: { ...TS },
      quality: { confidence: 0.82, label: "ok" },
      camera_ok: true,
      source_id: "cam2",
    },
    navigation: {
      active_source: "vio",
      health: "valid",
      validity: "valid",
      quality: { confidence: 0.75, label: "ok" },
      last_update: { ...TS },
    },
    video: {
      raw_pipeline: "csi",
      annotated_pipeline: "overlay",
      raw_fps: 30,
      annotated_fps: 15,
      bitrate_kbps: 2500,
      raw_kind: "raw",
      annotated_kind: "annotated",
    },
    fc: {
      heartbeat: { validity: "valid", timestamp: { ...TS }, system_id: 1, component_id: 1, fields: {} },
      sys_status: { validity: "valid", timestamp: { ...TS }, system_id: 1, component_id: 1, fields: {} },
      attitude: { validity: "valid", timestamp: { ...TS }, system_id: 1, component_id: 1, fields: {} },
      global_position_int: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      armed: false,
      custom_mode: 2,
    },
    channels: channels({ listening: true, gcsBind: "tailscale:14550" }),
    landing: {
      timestamp: { ...TS },
      source: "aruco",
      validity: "valid",
      quality: { confidence: 0.8, label: "ok" },
      target: {
        angle_x_rad: 0.02,
        angle_y_rad: -0.01,
        distance_m: 12.4,
        frame: "camera_optical",
        target_num: 0,
        landing_type: 2,
        position_m: null,
        position_valid: false,
        marker_id: 17,
      },
      detections: [{
        label: "aruco",
        detection_id: 17,
        confidence: 0.8,
        bbox_px: [120, 80, 220, 180],
        corners_px: [[120, 80], [220, 80], [220, 180], [120, 180]],
        metadata: {},
      }],
    },
  };
}

export function disconnectedCompanionStatus() {
  return {
    timestamp: { ...TS },
    system: {
      cpu_percent: 12,
      ram_used_mb: 2100,
      ram_total_mb: 8000,
      gpu_percent: null,
      temperature_c: 39,
      disk_used_percent: 31,
    },
    mavlink: {
      router_running: false,
      connected: false,
      heartbeat_ok: false,
      messages_dropped: null,
      rx_drop_rate: null,
      last_heartbeat: null,
    },
    vision: {
      running: false,
      health: "unavailable",
      fps: null,
      latency_ms: null,
      last_valid: null,
      quality: { confidence: 0, label: "unknown" },
      camera_ok: false,
      source_id: "none",
    },
    navigation: {
      active_source: "none",
      health: "unavailable",
      validity: "invalid",
      quality: { confidence: 0, label: "unknown" },
      last_update: null,
    },
    video: {
      raw_pipeline: "none",
      annotated_pipeline: "none",
      raw_fps: null,
      annotated_fps: null,
      bitrate_kbps: null,
      raw_kind: "raw",
      annotated_kind: "annotated",
    },
    fc: {
      heartbeat: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      sys_status: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      attitude: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      global_position_int: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      armed: null,
      custom_mode: null,
    },
    channels: channels({ listening: false }),
    landing: {
      timestamp: { ...TS },
      source: "none",
      validity: "invalid",
      quality: { confidence: 0, label: "unknown" },
      target: null,
      detections: [],
    },
  };
}

/** Matches Jetson snapshot.py when the HTTP API is up but FC / UART / camera are not. */
export function apiUpFcDownCompanionStatus() {
  return {
    timestamp: { ...TS },
    system: {
      cpu_percent: null,
      ram_used_mb: 2100,
      ram_total_mb: 8000,
      gpu_percent: null,
      temperature_c: 39,
      disk_used_percent: 31,
    },
    mavlink: {
      router_running: false,
      connected: false,
      heartbeat_ok: false,
      messages_sent: 0,
      messages_received: 0,
      messages_dropped: null,
      rx_drop_rate: null,
      last_heartbeat: null,
    },
    vision: {
      running: false,
      health: "unavailable",
      fps: null,
      latency_ms: null,
      last_valid: null,
      quality: { confidence: 0, label: "unknown" },
      camera_ok: false,
      source_id: "",
    },
    navigation: {
      active_source: "",
      health: "unavailable",
      validity: "invalid",
      quality: { confidence: 0, label: "unknown" },
      last_update: null,
    },
    video: {
      raw_pipeline: "stopped",
      annotated_pipeline: "stopped",
      raw_fps: null,
      annotated_fps: null,
      bitrate_kbps: null,
      raw_kind: "raw",
      annotated_kind: "annotated",
    },
    fc: {
      heartbeat: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      sys_status: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      attitude: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      global_position_int: { validity: "invalid", timestamp: null, system_id: null, component_id: null, fields: {} },
      armed: null,
      custom_mode: null,
    },
    channels: channels({ listening: false }),
    landing: {
      timestamp: { ...TS },
      source: "none",
      validity: "invalid",
      quality: { confidence: 0, label: "unknown" },
      target: null,
      detections: [],
    },
    extras: { fc_connected: false, camera_connected: false },
  };
}

export function degradedCompanionStatus() {
  const s = healthyCompanionStatus();
  s.vision = {
    running: true,
    health: "degraded",
    fps: null,
    latency_ms: 120,
    last_valid: null,
    quality: { confidence: 0.2, label: "weak" },
    camera_ok: false,
    source_id: "cam2",
  };
  s.navigation = {
    active_source: "vio",
    health: "degraded",
    validity: "invalid",
    quality: { confidence: 0.1, label: "weak" },
    last_update: { ...TS },
  };
  s.mavlink.heartbeat_ok = false;
  s.landing = {
    timestamp: { ...TS },
    source: "aruco",
    validity: "invalid",
    quality: { confidence: 0.1, label: "weak" },
    target: null,
    detections: [],
  };
  s.video.annotated_fps = null;
  s.video.bitrate_kbps = null;
  return s;
}

export function staleCompanionStatus() {
  const s = healthyCompanionStatus();
  s.vision.health = "unavailable";
  s.vision.fps = null;
  s.vision.latency_ms = null;
  s.navigation.validity = "stale";
  s.navigation.health = "unavailable";
  s.landing.validity = "stale";
  s.landing.target = null;
  return s;
}

export function healthyVisionResult() {
  const landing = healthyCompanionStatus().landing;
  return {
    timestamp: { ...TS },
    source: "cam2",
    validity: "valid",
    quality: { confidence: 0.82, label: "ok" },
    health: "valid",
    frame_id: 42,
    detections: landing.detections,
    landing_target: landing.target,
    latency_ms: 42,
    diagnostics: { data: {} },
  };
}

export function waitingVisionResult() {
  return {
    timestamp: { ...TS },
    source: "none",
    validity: "invalid",
    quality: { confidence: 0, label: "none" },
    health: "unavailable",
    frame_id: 0,
    detections: [],
    landing_target: null,
    latency_ms: null,
    diagnostics: { data: {} },
  };
}

export function degradedVisionResult() {
  return {
    timestamp: { ...TS },
    source: "cam2",
    validity: "invalid",
    quality: { confidence: 0.2, label: "weak" },
    health: "degraded",
    frame_id: 7,
    detections: [],
    landing_target: null,
    latency_ms: 120,
    diagnostics: { data: {} },
  };
}

export function healthyNavEstimate() {
  return {
    timestamp: { ...TS },
    source: "vio",
    validity: "valid",
    quality: { confidence: 0.75, label: "ok" },
    position_m: [1.2, -0.4, 8.1],
    velocity_m_s: [0.1, 0, -0.2],
    attitude_rpy_rad: [0.01, 0.02, 1.57],
    position_frame: "ned_local",
    attitude_frame: "body_frd",
    covariance: null,
    metadata: {},
  };
}

export function waitingNavEstimate() {
  return {
    timestamp: { ...TS },
    source: "none",
    validity: "invalid",
    quality: { confidence: 0, label: "none" },
    position_m: null,
    velocity_m_s: null,
    attitude_rpy_rad: null,
    position_frame: "ned_local",
    attitude_frame: "body_frd",
    covariance: null,
    metadata: {},
  };
}

export function degradedNavEstimate() {
  return {
    timestamp: { ...TS },
    source: "vio",
    validity: "invalid",
    quality: { confidence: 0.1, label: "weak" },
    position_m: null,
    velocity_m_s: null,
    attitude_rpy_rad: null,
    position_frame: "ned_local",
    attitude_frame: "body_frd",
    covariance: null,
    metadata: {},
  };
}

export function healthyDiagnostics() {
  return {
    timestamp: { ...TS },
    diagnostics: { data: { note: "mock" } },
    subsystems: {
      system: "valid",
      vision: "valid",
      navigation: "valid",
      landing: "valid",
      mavlink: "valid",
      video: "valid",
      api: "valid",
      fc: "valid",
      network: "valid",
      policy: "valid",
      config: "valid",
    },
  };
}

export function degradedDiagnostics() {
  return {
    timestamp: { ...TS },
    diagnostics: { data: { note: "degraded" } },
    subsystems: {
      system: "degraded",
      vision: "degraded",
      navigation: "degraded",
      landing: "degraded",
      mavlink: "degraded",
      video: "degraded",
      api: "valid",
      fc: "degraded",
      network: "degraded",
      policy: "valid",
      config: "valid",
    },
  };
}

export function healthyPolicy() {
  return {
    version: 1,
    channels: {
      gcs_4g: {
        implementation: "udp",
        endpoint: "0.0.0.0:14550",
        mode: "normal",
        deny: ["VISION", "LANDING_TARGET", "HIGH_RATE"],
        deny_in: [],
        deny_out: [],
        allow: ["HEARTBEAT", "STATUS", "GPS", "ATTITUDE", "BATTERY", "PARAMETERS", "MISSIONS", "COMMANDS", "RC"],
        notes: "CHANNEL 3 GCS 4G — preview only. apply is not supported.",
      },
      rfd900x: {
        implementation: "udp",
        endpoint: "0.0.0.0:14551",
        mode: "normal",
        deny: ["VISION", "LANDING_TARGET", "HIGH_RATE", "MISSIONS"],
        deny_in: [],
        deny_out: [],
        allow: [],
        notes: "RFD900X — preview only.",
      },
    },
  };
}

export function healthyCompanionConfig() {
  return {
    static: { board: "jetson", role: "companion" },
    runtime: {
      log_level: "INFO",
      vision_stale_timeout_s: 1.5,
      min_detection_confidence: 0.4,
    },
    flight_critical: { precision_land: "not_exposed" },
    read_only: { api_version: "1", companion_version: "0.1.0" },
    camera_extrinsics: {
      rotation_rpy_rad: [0, 0, 0],
      translation_m: [0.05, 0, 0.12],
      body_frame: "body_frd",
    },
    aruco: {
      dictionary_name: "DICT_4X4_50",
      marker_ids: [17],
      marker_length_m: 0.2,
      target_num: 0,
      landing_type: 2,
      frame: "camera_optical",
    },
    vision: { default_source: "csi" },
  };
}

export function healthyPolicyPreview() {
  return {
    snippet: "# preview only — does not write /etc",
    writes_etc: false,
    applySupported: false,
    policy: healthyPolicy(),
  };
}

/** Jetson GET /api/v1/maintenance wire payload (exact schema). */
export function maintenanceForScenario(scenario) {
  const status = scenario === "degraded"
    ? degradedCompanionStatus()
    : scenario === "disconnected"
      ? disconnectedCompanionStatus()
      : healthyCompanionStatus();
  const sys = status.system || {};

  if (scenario === "disconnected") {
    return {
      timestamp: { ...TS },
      software: {
        companion_version: null,
        git_commit: null,
        git_branch: null,
        git_clean: null,
        changed_files_count: null,
      },
      system: {
        cpu_percent: null,
        ram_used_mb: null,
        ram_total_mb: null,
        gpu_percent: null,
        temperature_c: null,
        disk_used_percent: null,
      },
      companion: {
        api_version: "1",
        api_running: false,
      },
      diagnostics: { recent: [] },
    };
  }

  if (scenario === "degraded") {
    return {
      timestamp: { ...TS },
      software: {
        companion_version: "0.9.4-mock",
        git_commit: "degraded01",
        git_branch: "main",
        git_clean: null,
        changed_files_count: null,
      },
      system: {
        cpu_percent: null,
        ram_used_mb: sys.ram_used_mb ?? null,
        ram_total_mb: sys.ram_total_mb ?? null,
        gpu_percent: null,
        temperature_c: sys.temperature_c ?? null,
        disk_used_percent: sys.disk_used_percent ?? null,
      },
      companion: {
        api_version: "1",
        api_running: true,
      },
      diagnostics: {
        recent: [
          {
            timestamp: { ...TS },
            health: "valid",
            subsystem: "api",
            message: "Companion started",
          },
          {
            timestamp: { t_monotonic_ns: TS.t_monotonic_ns + 1_000_000, t_utc_ns: null },
            health: "degraded",
            subsystem: "vision",
            message: "Camera frame rate low",
          },
        ],
      },
    };
  }

  return {
    timestamp: { ...TS },
    software: {
      companion_version: "0.9.4-mock",
      git_commit: "a1b2c3d4e5f6",
      git_branch: "main",
      git_clean: true,
      changed_files_count: 0,
    },
    system: {
      cpu_percent: sys.cpu_percent ?? null,
      ram_used_mb: sys.ram_used_mb ?? null,
      ram_total_mb: sys.ram_total_mb ?? null,
      gpu_percent: sys.gpu_percent ?? null,
      temperature_c: sys.temperature_c ?? null,
      disk_used_percent: sys.disk_used_percent ?? null,
    },
    companion: {
      api_version: "1",
      api_running: true,
    },
    diagnostics: {
      recent: [
        {
          timestamp: { ...TS },
          health: "valid",
          subsystem: "api",
          message: "Companion started",
        },
        {
          timestamp: { t_monotonic_ns: TS.t_monotonic_ns + 500_000, t_utc_ns: null },
          health: "valid",
          subsystem: "mavlink",
          message: "MAVLink heartbeat OK",
        },
      ],
    },
  };
}

export function snapshotForScenario(scenario) {
  const config = healthyCompanionConfig();
  const policy = healthyPolicy();
  const policyPreview = healthyPolicyPreview();
  if (scenario === "degraded") {
    return {
      status: degradedCompanionStatus(),
      visionResult: degradedVisionResult(),
      navigationEstimate: degradedNavEstimate(),
      diagnostics: degradedDiagnostics(),
      config,
      policy,
      policyPreview,
    };
  }
  if (scenario === "disconnected") {
    return {
      status: disconnectedCompanionStatus(),
      visionResult: waitingVisionResult(),
      navigationEstimate: waitingNavEstimate(),
      diagnostics: {
        timestamp: { ...TS },
        diagnostics: { data: { fc: "disconnected", camera: "unavailable", video: "stopped" } },
        subsystems: {
          system: "valid",
          vision: "unavailable",
          navigation: "unavailable",
          landing: "unavailable",
          mavlink: "unavailable",
          video: "unavailable",
          api: "valid",
          fc: "unavailable",
          network: "unavailable",
          policy: "valid",
          config: "valid",
        },
      },
      config,
      policy,
      policyPreview,
    };
  }
  return {
    status: healthyCompanionStatus(),
    visionResult: healthyVisionResult(),
    navigationEstimate: healthyNavEstimate(),
    diagnostics: healthyDiagnostics(),
    config,
    policy,
    policyPreview,
  };
}
