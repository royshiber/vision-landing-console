/**
 * ONE Node-side HTTP client for Jetson Companion API v1.
 * No UI logic. Browser never uses this against the Jetson directly.
 */

import { COMPANION_API_VERSION, COMPANION_V1_PATHS, COMPANION_V1_FORBIDDEN } from './companion-v1-paths.mjs';
import { sanitizeDeployPayload } from './companion-release-mgmt.mjs';

export class CompanionApiError extends Error {
  /**
   * @param {{ kind: 'config'|'timeout'|'connection'|'http'|'parse', message: string, status?: number, cause?: unknown, body?: unknown }} opts
   */
  constructor(opts) {
    super(opts.message);
    this.name = 'CompanionApiError';
    this.kind = opts.kind;
    this.status = opts.status ?? null;
    this.body = opts.body ?? null;
    if (opts.cause) this.cause = opts.cause;
  }
}

export function resolveCompanionV1BaseUrl(env = process.env) {
  const raw = String(env.JETSON_COMPANION_BASE_URL || '').trim().replace(/\/+$/, '');
  return raw || null;
}

export function companionAuthHeaders(env = process.env) {
  const token = String(env.COMPANION_SHARED_SECRET || env.JETSON_COMPANION_TOKEN || '').trim();
  if (!token) return {};
  return { 'X-Companion-Token': token, Authorization: `Bearer ${token}` };
}

/**
 * Join base + Jetson path without duplicating /api/v1.
 * Accepts origin-only (`http://host:8472`) or prefix-included (`http://host:8472/api/v1`).
 */
export function joinCompanionUrl(baseUrl, pathname) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let path = String(pathname || '');
  if (!path.startsWith('/')) path = `/${path}`;
  const baseHasV1 = /\/api\/v1$/i.test(base);
  const pathHasV1 = /^\/api\/v1(?=\/|$)/i.test(path);
  if (baseHasV1 && pathHasV1) {
    path = path.replace(/^\/api\/v1/i, '') || '/';
  }
  return `${base}${path}`;
}

/**
 * @param {{
 *   baseUrl?: string | null,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 */
export function createCompanionApiClient(opts = {}) {
  const env = opts.env || process.env;
  const baseUrl = opts.baseUrl !== undefined ? opts.baseUrl : resolveCompanionV1BaseUrl(env);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : Number(env.COMPANION_TIMEOUT_MS) || 8000;
  const fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);

  async function request(pathname, { method = 'GET', body } = {}) {
    if (!baseUrl) {
      throw new CompanionApiError({
        kind: 'config',
        message: 'JETSON_COMPANION_BASE_URL is not set',
      });
    }
    const url = joinCompanionUrl(baseUrl, pathname);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json', ...companionAuthHeaders(env) };
      let payload;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: ac.signal,
      });
      const text = await res.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new CompanionApiError({
            kind: 'parse',
            message: 'Companion API returned invalid JSON',
            status: res.status,
            cause: err,
          });
        }
      }
      if (!res.ok) {
        throw new CompanionApiError({
          kind: 'http',
          message: data.message || data.error || `Companion HTTP ${res.status}`,
          status: res.status,
          body: data,
        });
      }
      return data;
    } catch (err) {
      if (err instanceof CompanionApiError) throw err;
      if (err?.name === 'AbortError') {
        throw new CompanionApiError({
          kind: 'timeout',
          message: `Companion API timeout after ${timeoutMs}ms`,
          cause: err,
        });
      }
      throw new CompanionApiError({
        kind: 'connection',
        message: err?.message || 'Companion API connection failed',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const client = {
    kind: 'real',
    apiVersion: COMPANION_API_VERSION,
    get baseUrl() {
      return baseUrl;
    },
    get timeoutMs() {
      return timeoutMs;
    },
    eventsUrl() {
      return baseUrl ? joinCompanionUrl(baseUrl, COMPANION_V1_PATHS.events) : null;
    },
    wsUrl() {
      if (!baseUrl) return null;
      const u = new URL(joinCompanionUrl(baseUrl, COMPANION_V1_PATHS.ws));
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return u.toString();
    },
    getHealth: () => request(COMPANION_V1_PATHS.health),
    getVersion: () => request(COMPANION_V1_PATHS.version),
    getStatus: () => request(COMPANION_V1_PATHS.status),
    getStatusSystem: () => request(COMPANION_V1_PATHS.statusSystem),
    getStatusFc: () => request(COMPANION_V1_PATHS.statusFc),
    getStatusMavlink: () => request(COMPANION_V1_PATHS.statusMavlink),
    getStatusChannels: () => request(COMPANION_V1_PATHS.statusChannels),
    getStatusVision: () => request(COMPANION_V1_PATHS.statusVision),
    getVisionResult: () => request(COMPANION_V1_PATHS.visionResult),
    getStatusNavigation: () => request(COMPANION_V1_PATHS.statusNavigation),
    getNavigationEstimate: () => request(COMPANION_V1_PATHS.navigationEstimate),
    getStatusLanding: () => request(COMPANION_V1_PATHS.statusLanding),
    getStatusVideo: () => request(COMPANION_V1_PATHS.statusVideo),
    getDiagnostics: () => request(COMPANION_V1_PATHS.diagnostics),
    getMaintenance: () => request(COMPANION_V1_PATHS.maintenance),
    getMaintenanceReleases: () => request(COMPANION_V1_PATHS.maintenanceReleases),
    getMaintenanceRelease: (id) => request(`${COMPANION_V1_PATHS.maintenanceReleases}/${encodeURIComponent(String(id || ''))}`),
    getMaintenanceBackups: () => request(COMPANION_V1_PATHS.maintenanceBackups),
    getMaintenanceAudit: () => request(COMPANION_V1_PATHS.maintenanceAudit),
    postMaintenanceBackup: () => request(COMPANION_V1_PATHS.maintenanceBackup, { method: 'POST', body: {} }),
    postMaintenanceDeploy: (body) => {
      let payload;
      try {
        payload = sanitizeDeployPayload(body);
      } catch (err) {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: err?.message || 'invalid deploy payload',
        });
      }
      return request(COMPANION_V1_PATHS.maintenanceDeploy, { method: 'POST', body: payload });
    },
    postMaintenanceRollback: () => request(COMPANION_V1_PATHS.maintenanceRollback, { method: 'POST', body: {} }),
    getConfig: () => request(COMPANION_V1_PATHS.config),
    getPolicy: () => request(COMPANION_V1_PATHS.policy),
    getPolicyPreview: () => request(COMPANION_V1_PATHS.policyPreview),
    /** Client/proxy only — no apply/restart. */
    patchConfigRuntime: (body) => request(COMPANION_V1_PATHS.configRuntime, { method: 'PATCH', body: body || {} }),
    /** Client/proxy only — no apply/restart. */
    putPolicy: (body) => request(COMPANION_V1_PATHS.policy, { method: 'PUT', body: body || {} }),
  };

  for (const name of COMPANION_V1_FORBIDDEN) {
    if (name in client) {
      throw new Error(`CompanionApiClient must not expose ${name}`);
    }
  }

  return client;
}
