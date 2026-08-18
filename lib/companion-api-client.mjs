/**
 * Node-only Companion REST client.
 * Browser never calls this; only VisionLandingConsole server → Jetson /api/v1.
 * Base URL: JETSON_COMPANION_BASE_URL only (never heartbeat :8081).
 */

import { companionUrl, COMPANION_GET_PATHS, COMPANION_WRITE_METHODS } from "./companion-v1-paths.mjs";

const DEFAULT_TIMEOUT_MS = 8000;

export class CompanionApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "CompanionApiError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function createCompanionApiClient(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = typeof opts.fetch === "function" ? opts.fetch : globalThis.fetch;
  const secret = opts.sharedSecret != null ? String(opts.sharedSecret) : String(process.env.COMPANION_SHARED_SECRET || "").trim();

  function resolveBase() {
    const base = String(opts.baseUrl != null ? opts.baseUrl : process.env.JETSON_COMPANION_BASE_URL || "").trim();
    if (!base) {
      throw new CompanionApiError("config", "JETSON_COMPANION_BASE_URL is not set");
    }
    return base.replace(/\/+$/, "");
  }

  async function request(method, apiPath, body) {
    const base = resolveBase();
    const url = companionUrl(base, apiPath);
    const headers = { Accept: "application/json" };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      if (e && (e.name === "AbortError" || String(e.message || "").toLowerCase().includes("abort"))) {
        throw new CompanionApiError("timeout", `Companion request timed out: ${apiPath}`, { path: apiPath });
      }
      throw new CompanionApiError("connection", `Companion unreachable: ${e.message || e}`, { path: apiPath });
    } finally {
      clearTimeout(t);
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new CompanionApiError("parse", "Companion response is not JSON", { path: apiPath, status: res.status });
      }
    }
    if (!res.ok) {
      throw new CompanionApiError("http", `Companion HTTP ${res.status}`, {
        path: apiPath,
        status: res.status,
        body: json,
      });
    }
    return json;
  }

  const client = {
    getHealth: () => request("GET", "/api/v1/health"),
    getVersion: () => request("GET", "/api/v1/version"),
    getStatus: () => request("GET", "/api/v1/status"),
    getStatusSystem: () => request("GET", "/api/v1/status/system"),
    getStatusFc: () => request("GET", "/api/v1/status/fc"),
    getStatusMavlink: () => request("GET", "/api/v1/status/mavlink"),
    getStatusChannels: () => request("GET", "/api/v1/status/channels"),
    getStatusVision: () => request("GET", "/api/v1/status/vision"),
    getStatusNavigation: () => request("GET", "/api/v1/status/navigation"),
    getStatusLanding: () => request("GET", "/api/v1/status/landing"),
    getStatusVideo: () => request("GET", "/api/v1/status/video"),
    getVisionResult: () => request("GET", "/api/v1/vision/result"),
    getNavigationEstimate: () => request("GET", "/api/v1/navigation/estimate"),
    getDiagnostics: () => request("GET", "/api/v1/diagnostics"),
    getConfig: () => request("GET", "/api/v1/config"),
    getPolicy: () => request("GET", "/api/v1/policy"),
    getPolicyPreview: () => request("GET", "/api/v1/policy/preview"),
    getEvents: () => request("GET", "/api/v1/events"),
    patchRuntimeConfig: (body) => request("PATCH", "/api/v1/config/runtime", body || {}),
    putPolicy: (body) => request("PUT", "/api/v1/policy", body || {}),
    request,
    listGetPaths: () => [...COMPANION_GET_PATHS],
    listWriteMethods: () => ({ ...COMPANION_WRITE_METHODS }),
  };
  return client;
}
