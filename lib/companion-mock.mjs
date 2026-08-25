/**
 * Mock Companion API — same method surface as createCompanionApiClient.
 * Payloads match Jetson OpenAPI v1. No Jetson / FC / camera required.
 */

import { EventEmitter } from "events";
import { CompanionApiError } from "./companion-api-client.mjs";
import { COMPANION_API_VERSION, COMPANION_V1_PATHS } from "./companion-v1-paths.mjs";
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

  function emitChange() {
    emitter.emit("companion", { type: "status", scenario, payload: pack() });
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
      return { ok: scenario !== "degraded", api_version: "1" };
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
    async getStatusMavlink() {
      return clone(pack().status.mavlink);
    },
    async getStatusChannels() {
      return clone(pack().status.channels);
    },
    async getStatusVision() {
      return clone(pack().status.vision);
    },
    async getVisionResult() {
      return clone(pack().visionResult);
    },
    async getStatusNavigation() {
      return clone(pack().status.navigation);
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
      return clone({
        ...p.status,
        visionResult: p.visionResult,
        navigationEstimate: p.navigationEstimate,
        diagnostics: p.diagnostics,
        companion_version: p.version,
        config: { ...config, runtime: { ...config.runtime, ...runtime } },
        policy,
        policyPreview: { ...healthyPolicyPreview(), policy },
        api_version: "1",
      });
    },
  };

  client.paths = COMPANION_V1_PATHS;
  return client;
}
