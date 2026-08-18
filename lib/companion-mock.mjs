/**
 * Mock Companion — same method names as CompanionApiClient.
 * Scenarios: healthy | disconnected | degraded
 */

import { CompanionApiError } from "./companion-api-client.mjs";
import { COMPANION_GET_PATHS, COMPANION_WRITE_METHODS } from "./companion-v1-paths.mjs";

const HEALTHY_STATUS = {
  ok: true,
  connected: true,
  version: "mock-1.0.0",
  system: { cpuTempC: 48.5, gpuTempC: 51.2, memUsedPct: 42 },
  fc: { connected: true, armed: false, mode: "STABILIZE", voltageV: 16.4 },
  vision: { fps: 30, latencyMs: 42, padVisible: true },
  navigation: { quality: 0.82, tracking: true },
  landing: { phase: "idle", ready: false },
  video: { streaming: true, url: "http://mock.local/stream" },
};

export function createCompanionMock(opts = {}) {
  let scenario = String(opts.scenario || "healthy").toLowerCase();
  let runtimePatch = {};
  let policy = { name: "default", rules: [] };

  function ensureReachable(path) {
    if (scenario === "disconnected") {
      throw new CompanionApiError("connection", "Companion mock disconnected", { path });
    }
  }

  function wrapGet(path, payload) {
    ensureReachable(path);
    if (scenario === "degraded" && path === "/api/v1/health") {
      return { ok: false, degraded: true };
    }
    return payload;
  }

  const mock = {
    setScenario(s) {
      scenario = String(s || "healthy").toLowerCase();
    },
    getScenario: () => scenario,
    getHealth: async () => wrapGet("/api/v1/health", { ok: true, status: "ok" }),
    getVersion: async () => wrapGet("/api/v1/version", { version: HEALTHY_STATUS.version }),
    getStatus: async () => {
      ensureReachable("/api/v1/status");
      if (scenario === "degraded") {
        return { ...HEALTHY_STATUS, ok: false, degraded: true, vision: { fps: null, latencyMs: 120, padVisible: false } };
      }
      return { ...HEALTHY_STATUS, ...runtimePatch };
    },
    getStatusSystem: async () => wrapGet("/api/v1/status/system", HEALTHY_STATUS.system),
    getStatusFc: async () => wrapGet("/api/v1/status/fc", HEALTHY_STATUS.fc),
    getStatusMavlink: async () => wrapGet("/api/v1/status/mavlink", { connected: true, heartbeatHz: 4 }),
    getStatusChannels: async () => wrapGet("/api/v1/status/channels", { rc: null }),
    getStatusVision: async () => wrapGet("/api/v1/status/vision", HEALTHY_STATUS.vision),
    getStatusNavigation: async () => wrapGet("/api/v1/status/navigation", HEALTHY_STATUS.navigation),
    getStatusLanding: async () => wrapGet("/api/v1/status/landing", HEALTHY_STATUS.landing),
    getStatusVideo: async () => wrapGet("/api/v1/status/video", HEALTHY_STATUS.video),
    getVisionResult: async () => wrapGet("/api/v1/vision/result", { padVisible: true, dx: null, dy: null }),
    getNavigationEstimate: async () => wrapGet("/api/v1/navigation/estimate", { quality: 0.82, tracking: true }),
    getDiagnostics: async () => wrapGet("/api/v1/diagnostics", { ok: true, checks: [] }),
    getConfig: async () => wrapGet("/api/v1/config", { runtime: runtimePatch }),
    getPolicy: async () => wrapGet("/api/v1/policy", policy),
    getPolicyPreview: async () => wrapGet("/api/v1/policy/preview", { ...policy, preview: true }),
    getEvents: async () => wrapGet("/api/v1/events", { events: [] }),
    patchRuntimeConfig: async (body) => {
      ensureReachable("/api/v1/config/runtime");
      runtimePatch = { ...runtimePatch, ...(body || {}) };
      return { ok: true, runtime: runtimePatch };
    },
    putPolicy: async (body) => {
      ensureReachable("/api/v1/policy");
      policy = body && typeof body === "object" ? { ...body } : policy;
      return { ok: true, policy };
    },
    async request(method, apiPath, body) {
      const m = String(method || "GET").toUpperCase();
      if (m === "PATCH" && apiPath === "/api/v1/config/runtime") return mock.patchRuntimeConfig(body);
      if (m === "PUT" && apiPath === "/api/v1/policy") return mock.putPolicy(body);
      const getters = {
        "/api/v1/health": mock.getHealth,
        "/api/v1/version": mock.getVersion,
        "/api/v1/status": mock.getStatus,
        "/api/v1/status/system": mock.getStatusSystem,
        "/api/v1/status/fc": mock.getStatusFc,
        "/api/v1/status/mavlink": mock.getStatusMavlink,
        "/api/v1/status/channels": mock.getStatusChannels,
        "/api/v1/status/vision": mock.getStatusVision,
        "/api/v1/status/navigation": mock.getStatusNavigation,
        "/api/v1/status/landing": mock.getStatusLanding,
        "/api/v1/status/video": mock.getStatusVideo,
        "/api/v1/vision/result": mock.getVisionResult,
        "/api/v1/navigation/estimate": mock.getNavigationEstimate,
        "/api/v1/diagnostics": mock.getDiagnostics,
        "/api/v1/config": mock.getConfig,
        "/api/v1/policy": mock.getPolicy,
        "/api/v1/policy/preview": mock.getPolicyPreview,
        "/api/v1/events": mock.getEvents,
      };
      const fn = getters[apiPath];
      if (!fn) {
        throw new CompanionApiError("http", `Companion HTTP 404`, { path: apiPath, status: 404 });
      }
      return fn();
    },
    listGetPaths: () => [...COMPANION_GET_PATHS],
    listWriteMethods: () => ({ ...COMPANION_WRITE_METHODS }),
  };
  return mock;
}
