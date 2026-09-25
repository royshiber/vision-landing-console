/**
 * Mock Companion API — same method surface as createCompanionApiClient.
 * Payloads match Jetson OpenAPI v1. No Jetson / FC / camera required.
 */

import { EventEmitter } from "events";
import { CompanionApiError } from "./companion-api-client.mjs";
import { COMPANION_API_VERSION, COMPANION_V1_PATHS, GIMBAL_CONTROL_DISABLED_HE } from "./companion-v1-paths.mjs";
import { isDeployableReleaseStatus, sanitizeDeployPayload } from "./companion-release-mgmt.mjs";
import {
  snapshotForScenario,
  healthyPolicy,
  healthyCompanionConfig,
  healthyPolicyPreview,
  maintenanceForScenario,
  releaseInventoryForScenario,
  backupsForScenario,
  auditForScenario,
  findMockReleaseById,
  MOCK_RELEASE_CATALOG,
} from "./companion-mock-fixtures.mjs";

export const COMPANION_MOCK_SCENARIOS = Object.freeze(["healthy", "disconnected", "degraded"]);

function gimbalControlOn(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.VLC_GIMBAL_CONTROL_ENABLED || "0").trim().toLowerCase());
}

function mockGimbalCommand(action, body) {
  if (!gimbalControlOn()) {
    throw new CompanionApiError({
      kind: "http",
      status: 403,
      message: GIMBAL_CONTROL_DISABLED_HE,
      body: {
        ok: false,
        reason: "gimbal_control_disabled",
        message: GIMBAL_CONTROL_DISABLED_HE,
        sent: false,
        action,
      },
    });
  }
  return {
    ok: false,
    sent: false,
    confirmed: false,
    present: false,
    reason: "no_reply",
    action,
    echoed: body && typeof body === "object" ? body : {},
    note: "mock has no gimbal; command not invented as applied",
  };
}

function clone(obj) {
  return structuredClone(obj);
}

export function createCompanionMock(opts = {}) {
  let scenario = COMPANION_MOCK_SCENARIOS.includes(opts.scenario) ? opts.scenario : "healthy";
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  let runtime = {};
  let policy = healthyPolicy();
  let config = healthyCompanionConfig();
  let deployState = "IDLE";
  let activeRelease = clone(MOCK_RELEASE_CATALOG[0]);
  let previousRelease = clone(MOCK_RELEASE_CATALOG[1]);
  /** @type {Array<object>} */
  let mockBackups = [];
  /** @type {Array<object>} */
  let mockAudit = [];

  function resetReleaseMockState() {
    deployState = "IDLE";
    activeRelease = clone(MOCK_RELEASE_CATALOG[0]);
    previousRelease = clone(MOCK_RELEASE_CATALOG[1]);
    const base = backupsForScenario(scenario);
    mockBackups = base?.backups ? clone(base.backups) : [];
    const auditBase = auditForScenario(scenario);
    mockAudit = auditBase?.entries ? clone(auditBase.entries) : [];
  }
  resetReleaseMockState();

  function assertReleaseReachable() {
    if (scenario === "disconnected") {
      throw new CompanionApiError({
        kind: "connection",
        message: "Companion API unavailable (mock disconnected)",
      });
    }
  }

  function pushAudit(entry) {
    mockAudit.unshift({
      timestamp: { t_monotonic_ns: Date.now() * 1_000_000, t_utc_ns: null },
      ...entry,
    });
  }

  function pack() {
    const snap = snapshotForScenario(scenario);
    return {
      ...snap,
      version: "0.1.0",
    };
  }

  function healthPayload() {
    const status = pack().status || {};
    const fcValid = status.fc?.heartbeat?.validity === "valid";
    const mavConn = status.mavlink?.connected === true;
    const mavHb = status.mavlink?.heartbeat_ok === true;
    const capabilities = { uplinkStatus: true, uplinkControl: true };
    if (scenario === "disconnected") {
      return { ok: true, api_version: "1", fc_linked: false, fc_heartbeat: false, capabilities };
    }
    if (scenario === "degraded") {
      return { ok: false, api_version: "1", fc_linked: mavConn || fcValid, fc_heartbeat: false, capabilities };
    }
    return {
      ok: true,
      api_version: "1",
      fc_linked: mavConn || fcValid,
      fc_heartbeat: fcValid || mavHb,
      capabilities,
    };
  }

  function emitChange() {
    emitter.emit("companion", { type: "status", scenario, payload: pack() });
  }

  const uplinkPrefs = { wifi: true, cellular: true };

  function uplinkSnapshot() {
    return {
      ok: true,
      read_only: false,
      boot_fallback: null,
      wifi: {
        iface: 'wlP1p1s0',
        up: false,
        enabled: uplinkPrefs.wifi === true,
        ssid: null,
        signal_dbm: null,
        ip: null,
        default_route: false,
      },
      cellular: {
        iface: null,
        up: false,
        enabled: uplinkPrefs.cellular === true,
        ip: null,
        route_metric: null,
        signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
        default_route: false,
      },
      default_iface: null,
    };
  }

  const client = {
    kind: "mock",
    apiVersion: COMPANION_API_VERSION,
    get baseUrl() {
      return "mock://companion";
    },
    get timeoutMs() {
      return 0;
    },
    get scenario() {
      return scenario;
    },
    setScenario(next) {
      if (!COMPANION_MOCK_SCENARIOS.includes(next)) {
        throw new Error(`unknown mock scenario: ${next}`);
      }
      scenario = next;
      resetReleaseMockState();
      emitChange();
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    eventsUrl() {
      return "mock://companion/api/v1/events";
    },
    wsUrl() {
      return "mock://companion/api/v1/ws";
    },
    async getHealth() {
      return healthPayload();
    },
    async getVersion() {
      return { api_version: "1", companion_version: pack().version };
    },
    async getStatus() {
      return clone(pack().status);
    },
    async getStatusSystem() {
      return clone(pack().status.system);
    },
    async getStatusFc() {
      return clone(pack().status.fc || {});
    },
    async getNetworkUplinks() {
      return uplinkSnapshot();
    },
    async setNetworkUplink(link, body) {
      const kind = String(link || '').trim().toLowerCase();
      if (kind !== 'wifi' && kind !== 'cellular') {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: 'bad_link',
          body: { ok: false, reason: 'bad_link', message: 'קישור לא מוכר' },
        });
      }
      if (!body || typeof body.enabled !== 'boolean') {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: 'bad_body',
          body: { ok: false, reason: 'bad_body', message: 'גוף הבקשה לא תקין' },
        });
      }
      if (body.enabled === false) {
        throw new CompanionApiError({
          kind: 'http',
          status: 409,
          message: 'אי אפשר לכבות את הקישור האחרון',
          body: { ok: false, reason: 'last_uplink', message: 'אי אפשר לכבות את הקישור האחרון' },
        });
      }
      uplinkPrefs[kind] = true;
      return uplinkSnapshot();
    },
    async getStatusMavlink() {
      return clone(pack().status.mavlink);
    },
    async getStatusChannels() {
      return clone(pack().status.channels);
    },
    async getStatusVision() {
      return clone(pack().status.vision);
    },
    async getStatusCameras() {
      const vision = pack().status.vision || {};
      const nav = pack().status.optical_nav || {};
      return clone({
        ok: true,
        observe_only: true,
        camera_ok: vision.camera_ok === true,
        running: vision.running === true,
        dry_run: false,
        real: false,
        source: vision.camera_ok === true ? 'mock' : 'absent',
        fps: vision.fps ?? null,
        last_frame_age_ms: null,
        cameras: nav.cameras || {},
        note: 'mock status only; no JPEG frame invented',
      });
    },
    async getStatusGimbal() {
      return {
        ok: true,
        present: false,
        firmware: null,
        hardware_id: null,
        attitude: null,
        zoom: null,
        mode: null,
        recording: null,
        age_ms: null,
        control_enabled: gimbalControlOn(),
        polling: false,
        error: 'no_reply',
        note: 'mock has no gimbal reply; not invented',
      };
    },
    async getCameraFrame(camId) {
      const key = String(camId || '').trim().toLowerCase();
      if (!['cam1', 'cam2', 'cam3'].includes(key)) {
        throw new CompanionApiError({
          kind: 'http',
          status: 404,
          message: 'unknown_camera',
          body: { ok: false, reason: 'unknown_camera' },
        });
      }
      throw new CompanionApiError({
        kind: 'http',
        status: 404,
        message: 'no_frame',
        body: { ok: false, reason: 'no_frame', camera: key },
      });
    },
    postGimbalRate: (body) => mockGimbalCommand('rate', body),
    postGimbalAngle: (body) => mockGimbalCommand('angle', body),
    postGimbalCenter: (body) => mockGimbalCommand('center', body),
    postGimbalZoom: (body) => mockGimbalCommand('zoom', body),
    postGimbalMode: (body) => mockGimbalCommand('mode', body),
    postGimbalPhoto: (body) => mockGimbalCommand('photo', body),
    postGimbalRecord: (body) => mockGimbalCommand('record', body),
    async getVisionResult() {
      return clone(pack().visionResult);
    },
    async getStatusNavigation() {
      return clone(pack().status.navigation);
    },
    async getStatusOpticalNav() {
      return clone(pack().status.optical_nav || {
        present: false,
        running: false,
        camera_ok: false,
        alt_ceiling_m: 300,
        position: null,
        velocity: null,
        age_ms: null,
        confidence: null,
        ekf_injected: false,
        display_only: true,
        note: "observe-only optical-nav stub; position null",
      });
    },
    async getNavigationEstimate() {
      return clone(pack().navigationEstimate);
    },
    async getStatusLanding() {
      return clone(pack().status.landing || {
        timestamp: pack().status.timestamp,
        source: "none",
        validity: "invalid",
        quality: { confidence: 0, label: "none" },
        target: null,
        detections: [],
      });
    },
    async getStatusVideo() {
      return clone(pack().status.video);
    },
    async getDiagnostics() {
      return clone(pack().diagnostics);
    },
    async getMaintenance() {
      return clone(maintenanceForScenario(scenario));
    },
    async getMaintenanceReleases() {
      assertReleaseReachable();
      const inv = releaseInventoryForScenario(scenario, { deployState });
      if (!inv) {
        throw new CompanionApiError({ kind: "connection", message: "Release inventory unavailable" });
      }
      inv.active = {
        release_id: activeRelease.release_id,
        version: activeRelease.version,
        status: "ACTIVE",
      };
      inv.previous = {
        release_id: previousRelease.release_id,
        version: previousRelease.version,
        status: "PREVIOUS",
      };
      return clone(inv);
    },
    async getMaintenanceRelease(id) {
      assertReleaseReachable();
      const rel = findMockReleaseById(String(id || ""));
      if (!rel) {
        throw new CompanionApiError({ kind: "http", status: 404, message: "Release not found", body: { message: "Release not found" } });
      }
      return clone(rel);
    },
    async getMaintenanceBackups() {
      assertReleaseReachable();
      return clone({ timestamp: maintenanceForScenario(scenario).timestamp, backups: mockBackups });
    },
    async getMaintenanceAudit() {
      assertReleaseReachable();
      return clone({ timestamp: maintenanceForScenario(scenario).timestamp, entries: mockAudit });
    },
    async postMaintenanceBackup() {
      assertReleaseReachable();
      if (scenario === "degraded") {
        throw new CompanionApiError({
          kind: "http",
          status: 409,
          message: "Backup conflict (mock degraded)",
          body: { message: "Backup conflict (mock degraded)" },
        });
      }
      const backupId = `bk-mock-${String(mockBackups.length + 1).padStart(3, "0")}`;
      const entry = {
        backup_id: backupId,
        created_at: new Date().toISOString(),
        release_id: MOCK_RELEASE_CATALOG[0].release_id,
        sha256: "mocksha256backup0000000000000000000000000000000000000000000000000000",
      };
      mockBackups.unshift(entry);
      pushAudit({
        operation: "backup",
        release_id: entry.release_id,
        result: "success",
        failure_reason: null,
        active_release_id: MOCK_RELEASE_CATALOG[0].release_id,
      });
      return clone({
        mock: true,
        backup_id: backupId,
        created_at: entry.created_at,
        sha256: entry.sha256,
        message: "MOCK: configuration backup created",
      });
    },
    async postMaintenanceDeploy(body) {
      assertReleaseReachable();
      let payload;
      try {
        payload = sanitizeDeployPayload(body);
      } catch (err) {
        throw new CompanionApiError({
          kind: "http",
          status: 400,
          message: err?.message || "invalid deploy payload",
        });
      }
      const rel = findMockReleaseById(payload.release_id);
      if (!rel) {
        throw new CompanionApiError({
          kind: "http",
          status: 404,
          message: "Release not found",
          body: { message: "Release not found" },
        });
      }
      if (!isDeployableReleaseStatus(rel.status)) {
        throw new CompanionApiError({
          kind: "http",
          status: 400,
          message: `Release status ${rel.status} is not deployable`,
          body: { message: `Release status ${rel.status} is not deployable` },
        });
      }
      if (scenario === "degraded") {
        deployState = "FAILED";
        pushAudit({
          operation: "deploy",
          release_id: rel.release_id,
          result: "failure",
          failure_reason: "Health check failed (mock degraded)",
          active_release_id: MOCK_RELEASE_CATALOG[0].release_id,
        });
        throw new CompanionApiError({
          kind: "http",
          status: 409,
          message: "Deploy conflict — health check failed (mock degraded)",
          body: { message: "Deploy conflict — health check failed (mock degraded)" },
        });
      }
      deployState = "SUCCEEDED";
      const lastActive = activeRelease;
      activeRelease = {
        release_id: rel.release_id,
        version: rel.version,
        status: "ACTIVE",
      };
      previousRelease = {
        release_id: lastActive.release_id,
        version: lastActive.version,
        status: "PREVIOUS",
      };
      pushAudit({
        operation: "deploy",
        release_id: rel.release_id,
        result: "success",
        failure_reason: null,
        active_release_id: rel.release_id,
      });
      return clone({
        mock: true,
        state: "SUCCEEDED",
        deploy_state: "SUCCEEDED",
        release_id: rel.release_id,
        running_process_changed: true,
        running_version: rel.version,
        health_check_ok: true,
        message: "Deployment successful",
        active_release: activeRelease,
        previous_release: previousRelease,
      });
    },
    async postMaintenanceRollback() {
      assertReleaseReachable();
      const inv = releaseInventoryForScenario(scenario, { deployState });
      if (!inv?.previous?.release_id) {
        throw new CompanionApiError({
          kind: "http",
          status: 400,
          message: "No previous release to rollback to",
          body: { message: "No previous release to rollback to" },
        });
      }
      if (scenario === "degraded") {
        throw new CompanionApiError({
          kind: "http",
          status: 501,
          message: "Rollback unsupported in degraded mock",
          body: { message: "Rollback unsupported in degraded mock" },
        });
      }
      deployState = "SUCCEEDED";
      const restored = previousRelease;
      const failed = activeRelease;
      activeRelease = {
        release_id: restored.release_id,
        version: restored.version,
        status: "ACTIVE",
      };
      previousRelease = {
        release_id: failed.release_id,
        version: failed.version,
        status: "PREVIOUS",
      };
      pushAudit({
        operation: "rollback",
        release_id: inv.previous.release_id,
        result: "success",
        failure_reason: null,
        active_release_id: inv.previous.release_id,
      });
      return clone({
        mock: true,
        state: "SUCCEEDED",
        running_process_changed: true,
        running_version: activeRelease.version,
        health_check_ok: true,
        message: "Rollback successful",
        active_release: activeRelease,
        previous_release: previousRelease,
      });
    },
    async getConfig() {
      return clone({ ...config, runtime: { ...config.runtime, ...runtime } });
    },
    async getPolicy() {
      return clone(policy);
    },
    async getPolicyPreview() {
      const ch = policy.channels || {};
      const lines = ['# preview only — does not write /etc'];
      for (const [name, c] of Object.entries(ch)) {
        lines.push(`[${name}]`);
        if (c.deny?.length) lines.push(`  deny: ${c.deny.join(', ')}`);
        if (c.deny_in?.length) lines.push(`  deny_in: ${c.deny_in.join(', ')}`);
        if (c.deny_out?.length) lines.push(`  deny_out: ${c.deny_out.join(', ')}`);
      }
      return { snippet: lines.join('\n'), writes_etc: false, applySupported: false, policy: clone(policy) };
    },
    async patchConfigRuntime(body) {
      const patch = body && typeof body === "object" ? body : {};
      const hasRuntime = patch.runtime && typeof patch.runtime === "object";
      const hasVision = patch.vision && typeof patch.vision === "object";
      if (hasRuntime) {
        runtime = { ...runtime, ...patch.runtime };
      } else if (!hasVision) {
        runtime = { ...runtime, ...patch };
      }
      if (hasVision) {
        config = { ...config, vision: { ...(config.vision || {}), ...patch.vision } };
      }
      return {
        runtime: { ...(config.runtime || {}), ...runtime },
        vision: { ...(config.vision || {}) },
        applied: false,
      };
    },
    async putPolicy(body) {
      if (body && typeof body === "object") policy = { ...body };
      return { ok: true, applied: false, path: "mock://policy" };
    },
    getFullSnapshot() {
      const p = pack();
      const status = p.status || {};
      const health = healthPayload();
      return clone({
        ...status,
        visionResult: p.visionResult,
        navigationEstimate: p.navigationEstimate,
        diagnostics: p.diagnostics,
        companion_version: p.version,
        config: { ...config, runtime: { ...config.runtime, ...runtime } },
        policy,
        policyPreview: { ...healthyPolicyPreview(), policy },
        api_version: "1",
        health,
      });
    },
  };

  client.paths = COMPANION_V1_PATHS;
  return client;
}
