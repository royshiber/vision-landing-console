/**
 * Mock Companion API — same method surface as createCompanionApiClient.
 * Payloads match Jetson OpenAPI v1. No Jetson / FC / camera required.
 */

import { EventEmitter } from "events";
import { COMPANION_API_VERSION, COMPANION_V1_PATHS } from "./companion-v1-paths.mjs";
import {
  snapshotForScenario,
  healthyPolicy,
  healthyCompanionConfig,
  healthyPolicyPreview,
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
      const next = patch.runtime && typeof patch.runtime === "object" ? patch.runtime : patch;
      runtime = { ...runtime, ...next };
      return { runtime: { ...runtime }, applied: false };
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
