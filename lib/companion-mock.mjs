/**
 * Mock Companion — same method names as CompanionApiClient.
 * Payloads come from the vendored OpenAPI examples (contract field names).
 * Scenarios: healthy | disconnected | degraded | stale
 */

import { CompanionApiError } from "./companion-api-error.mjs";
import { COMPANION_GET_PATHS, COMPANION_WRITE_METHODS } from "./companion-v1-paths.mjs";
import { getContractExample } from "./companion-contract.mjs";

function healthyStatus() {
  return getContractExample("/api/v1/status", "healthy");
}

export function createCompanionMock(opts = {}) {
  let scenario = String(opts.scenario || "healthy").toLowerCase();
  let runtimePatch = {};
  let policy = getContractExample("/api/v1/policy") || { name: "default", rules: [] };

  function ensureReachable(path) {
    if (scenario === "disconnected") {
      throw new CompanionApiError("connection", "Companion mock disconnected", { path });
    }
  }

  function wrapGet(path, payload) {
    ensureReachable(path);
    if (scenario === "degraded" && path === "/api/v1/health") {
      return { ok: false, status: "degraded" };
    }
    return payload;
  }

  const mock = {
    setScenario(s) {
      scenario = String(s || "healthy").toLowerCase();
    },
    getScenario: () => scenario,
    getHealth: async () => wrapGet("/api/v1/health", getContractExample("/api/v1/health")),
    getVersion: async () => wrapGet("/api/v1/version", getContractExample("/api/v1/version")),
    getStatus: async () => {
      ensureReachable("/api/v1/status");
      if (scenario === "degraded") {
        const d = healthyStatus();
        d.ok = false;
        d.state = "DEGRADED";
        d.vision = { fps: null, latency_ms: 120, pad_visible: false };
        return d;
      }
      if (scenario === "stale") {
        return getContractExample("/api/v1/status", "stale");
      }
      return { ...healthyStatus(), ...runtimePatch };
    },
    getStatusSystem: async () => wrapGet("/api/v1/status/system", getContractExample("/api/v1/status/system")),
    getStatusFc: async () => wrapGet("/api/v1/status/fc", getContractExample("/api/v1/status/fc")),
    getStatusMavlink: async () => wrapGet("/api/v1/status/mavlink", getContractExample("/api/v1/status/mavlink")),
    getStatusChannels: async () => wrapGet("/api/v1/status/channels", getContractExample("/api/v1/status/channels")),
    getStatusVision: async () => wrapGet("/api/v1/status/vision", getContractExample("/api/v1/status/vision")),
    getStatusNavigation: async () => wrapGet("/api/v1/status/navigation", getContractExample("/api/v1/status/navigation")),
    getStatusLanding: async () => wrapGet("/api/v1/status/landing", getContractExample("/api/v1/status/landing")),
    getStatusVideo: async () => wrapGet("/api/v1/status/video", getContractExample("/api/v1/status/video")),
    getVisionResult: async () => wrapGet("/api/v1/vision/result", getContractExample("/api/v1/vision/result")),
    getNavigationEstimate: async () => wrapGet("/api/v1/navigation/estimate", getContractExample("/api/v1/navigation/estimate")),
    getDiagnostics: async () => wrapGet("/api/v1/diagnostics", getContractExample("/api/v1/diagnostics")),
    getConfig: async () => wrapGet("/api/v1/config", { runtime: { ...runtimePatch } }),
    getPolicy: async () => wrapGet("/api/v1/policy", policy),
    getPolicyPreview: async () => wrapGet("/api/v1/policy/preview", { ...policy, preview: true }),
    getEvents: async () => wrapGet("/api/v1/events", getContractExample("/api/v1/events")),
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
        "/api/v1/status/landing": mock.getStatusLanding,
        "/api/v1/status/navigation": mock.getStatusNavigation,
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
