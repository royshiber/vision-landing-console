/**
 * Companion REST API v1 path constants used by the Node proxy.
 * Paths must stay aligned with vendor/jetson-companion-api/openapi/companion-api-v1.yaml
 * (snapshot of the Jetson architecture/openapi source of truth).
 */

export const COMPANION_API_PREFIX = "/api/v1";
export const COMPANION_PROXY_PREFIX = "/api/jetson/v1";

export const COMPANION_GET_PATHS = Object.freeze([
  "/api/v1/health",
  "/api/v1/version",
  "/api/v1/status",
  "/api/v1/status/system",
  "/api/v1/status/fc",
  "/api/v1/status/mavlink",
  "/api/v1/status/channels",
  "/api/v1/status/vision",
  "/api/v1/status/navigation",
  "/api/v1/status/landing",
  "/api/v1/status/video",
  "/api/v1/vision/result",
  "/api/v1/navigation/estimate",
  "/api/v1/diagnostics",
  "/api/v1/config",
  "/api/v1/policy",
  "/api/v1/policy/preview",
  "/api/v1/events",
  "/api/v1/ws",
]);

export const COMPANION_WRITE_METHODS = Object.freeze({
  PATCH: ["/api/v1/config/runtime"],
  PUT: ["/api/v1/policy"],
});

/** Phase A: these aircraft command *segments* are not proxied (not substring matches — `landing` stays allowed). */
export const COMPANION_FORBIDDEN_PATH_SUBSTRINGS = Object.freeze([
  "arm",
  "disarm",
  "set_mode",
  "set-mode",
  "land",
  "command_long",
  "command-long",
  "commandlong",
]);

export function isForbiddenCompanionPath(relPath) {
  const p = String(relPath || "").toLowerCase().replace(/\\/g, "/");
  const segments = p.split("/").filter(Boolean);
  const forbidden = new Set(COMPANION_FORBIDDEN_PATH_SUBSTRINGS);
  return segments.some((seg) => forbidden.has(seg));
}

export function companionUrl(baseUrl, apiPath) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `${base}${path}`;
}
