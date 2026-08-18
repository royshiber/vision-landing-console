/**
 * Browser → Node proxy for Companion API v1.
 * Prefix: /api/jetson/v1/*  →  Jetson /api/v1/*
 * Forbidden aircraft commands return 404 companion_forbidden.
 */

import {
  COMPANION_PROXY_PREFIX,
  COMPANION_GET_PATHS,
  COMPANION_WRITE_METHODS,
  isForbiddenCompanionPath,
} from "../companion-v1-paths.mjs";
import { CompanionApiError } from "../companion-api-client.mjs";

function jsonError(res, status, error, extra = {}) {
  res.status(status).json({ ok: false, error, ...extra });
}

function allowedWrite(method, apiPath) {
  const list = COMPANION_WRITE_METHODS[method] || [];
  return list.includes(apiPath);
}

export function registerCompanionProxyApi(app, ctx = {}) {
  const getService = typeof ctx.getCompanionService === "function" ? ctx.getCompanionService : () => ctx.companionService;

  app.use(COMPANION_PROXY_PREFIX, async (req, res) => {
    const rel = String(req.path || "/");
    const apiPath = `/api/v1${rel === "/" ? "" : rel}`;

    if (isForbiddenCompanionPath(rel) || isForbiddenCompanionPath(apiPath)) {
      return jsonError(res, 404, "companion_forbidden", { path: apiPath });
    }

    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      if (!COMPANION_GET_PATHS.includes(apiPath)) {
        return jsonError(res, 404, "companion_unknown_path", { path: apiPath });
      }
    } else if (method === "PATCH" || method === "PUT") {
      if (!allowedWrite(method, apiPath)) {
        return jsonError(res, 404, "companion_forbidden", { path: apiPath, method });
      }
    } else {
      return jsonError(res, 405, "companion_method_not_allowed", { path: apiPath, method });
    }

    const svc = getService();
    if (!svc || svc.getMode() === "off") {
      return jsonError(res, 503, "companion_disabled", { mode: svc ? svc.getMode() : "off" });
    }
    const client = svc.getClient();
    if (!client) {
      return jsonError(res, 503, "companion_not_present");
    }

    try {
      if (method === "GET" || method === "HEAD") {
        const data = await client.request("GET", apiPath);
        return res.json(data == null ? {} : data);
      }
      if (method === "PATCH") {
        const data = await client.patchRuntimeConfig(req.body || {});
        return res.json(data);
      }
      if (method === "PUT") {
        const data = await client.putPolicy(req.body || {});
        return res.json(data);
      }
    } catch (e) {
      if (e instanceof CompanionApiError || (e && e.kind)) {
        const status = e.kind === "http" ? e.status || 502 : e.kind === "timeout" ? 504 : e.kind === "config" ? 503 : 502;
        return jsonError(res, status, "companion_upstream", { kind: e.kind, message: e.message });
      }
      return jsonError(res, 502, "companion_upstream", { message: String(e.message || e) });
    }
    return jsonError(res, 405, "companion_method_not_allowed");
  });
}
