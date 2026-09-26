/**
 * ONE Node-side HTTP client for Jetson Companion API v1.
 * No UI logic. Browser never uses this against the Jetson directly.
 */

import {
  COMPANION_API_VERSION,
  COMPANION_CAMERA_IDS,
  COMPANION_V1_PATHS,
  COMPANION_V1_FORBIDDEN,
  cameraFramePath,
} from './companion-v1-paths.mjs';
import { normalizeCompanionSecret, readCompanionTokenFromEnv } from './companion-secret.mjs';
import { sanitizeDeployPayload } from './companion-release-mgmt.mjs';
import {
  normalizeCompanionEventEnvelope,
  readCompanionSseStream,
} from './companion-events-sse.mjs';
import { jetsonFetch, openJetsonWebSocket } from './jetson-socks.mjs';
import {
  classifyCompanionUrl,
  hebrewTransportError,
  pickActiveCompanionProbe,
  transportCardId,
} from './link-attribution.mjs';

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

/** Split a comma-separated companion base list. Order is the try order. */
export function parseCompanionBaseUrls(raw) {
  const text = normalizeCompanionSecret(raw);
  if (!text) return [];
  const out = [];
  for (const part of text.split(',')) {
    const url = part.trim().replace(/\/+$/, '');
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export function resolveCompanionBaseUrlList(env = process.env) {
  const listed = parseCompanionBaseUrls(env?.JETSON_COMPANION_BASE_URLS);
  const single = parseCompanionBaseUrls(env?.JETSON_COMPANION_BASE_URL);
  const out = [];
  for (const url of [...listed, ...single]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** First address. A non-empty list still satisfies the BOTH gate. */
export function resolveCompanionV1BaseUrl(env = process.env) {
  return resolveCompanionBaseUrlList(env)[0] || null;
}

export function companionAuthHeaders(env = process.env) {
  const token = readCompanionTokenFromEnv(env);
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
  const explicit = opts.baseUrls != null
    ? opts.baseUrls
    : (opts.baseUrl !== undefined ? opts.baseUrl : env.JETSON_COMPANION_BASE_URL);
  const candidates = (Array.isArray(explicit) ? explicit : [explicit])
    .flatMap((item) => parseCompanionBaseUrls(item));
  let baseUrl = candidates[0] || null;
  let picked = candidates.length <= 1;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : Number(env.COMPANION_TIMEOUT_MS) || 8000;
  const failoverMs = Number.isFinite(opts.failoverTimeoutMs)
    ? opts.failoverTimeoutMs
    : (Number(env.COMPANION_FAILOVER_TIMEOUT_MS) || 2000);
  const directFetch = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  const fetchImpl = (url, init) => jetsonFetch(url, init, {
    fetchImpl: directFetch,
    env,
    socksFetch: opts.socksFetch,
  });
  let pathSnapshot = null;

  async function probeOne(candidate) {
    const transport = classifyCompanionUrl(candidate);
    const started = Date.now();
    const url = joinCompanionUrl(candidate, '/api/v1/health');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(200, failoverMs));
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...companionAuthHeaders(env) },
        signal: ac.signal,
      });
      try { await res.arrayBuffer(); } catch { /* body optional */ }
      const status = Number(res?.status) || 0;
      if (status <= 0) {
        return {
          url: candidate,
          transport,
          id: transportCardId(transport),
          ok: false,
          status: null,
          rttMs: null,
          errorHe: 'אין הגעה לכתובת',
        };
      }
      return {
        url: candidate,
        transport,
        id: transportCardId(transport),
        ok: true,
        status,
        rttMs: Date.now() - started,
        errorHe: null,
      };
    } catch (err) {
      return {
        url: candidate,
        transport,
        id: transportCardId(transport),
        ok: false,
        status: null,
        rttMs: null,
        errorHe: hebrewTransportError(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function readModem(candidate) {
    const url = joinCompanionUrl(candidate, COMPANION_V1_PATHS.statusModem);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(200, failoverMs));
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...companionAuthHeaders(env) },
        signal: ac.signal,
      });
      if (!res || !res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const modem = data.modem && typeof data.modem === 'object' ? data.modem : data;
      if (!('present' in modem) && !('state' in modem) && !('reason' in modem) && modem.up !== true) {
        return null;
      }
      return modem;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function noteActive(nextUrl, prevUrl) {
    if (!nextUrl || nextUrl === prevUrl) return;
    if (typeof opts.onActiveUrl !== 'function') return;
    try { opts.onActiveUrl(nextUrl, prevUrl); } catch { /* listener owns its errors */ }
  }

  async function refreshCompanionPaths({ force = false } = {}) {
    const now = Date.now();
    if (!force && pathSnapshot && now - pathSnapshot.probedAt < 5000) return pathSnapshot;
    if (!candidates.length) {
      baseUrl = null;
      pathSnapshot = {
        probedAt: now,
        activeUrl: null,
        activeId: null,
        paths: [],
        modem: null,
        switched: false,
      };
      return pathSnapshot;
    }
    const probes = await Promise.all(candidates.map((url) => probeOne(url)));
    const preferred = pickActiveCompanionProbe(probes);
    const prev = baseUrl;
    if (preferred?.url) baseUrl = preferred.url;
    else if (!baseUrl) baseUrl = candidates[0];
    let modem = pathSnapshot?.modem || null;
    if (preferred?.url) {
      const fresh = await readModem(preferred.url);
      if (fresh) modem = fresh;
    }
    const switched = Boolean(preferred?.url && prev && preferred.url !== prev);
    pathSnapshot = {
      probedAt: now,
      activeUrl: baseUrl,
      activeId: preferred ? transportCardId(preferred.transport) : null,
      paths: probes,
      modem,
      switched,
    };
    if (switched) noteActive(baseUrl, prev);
    return pathSnapshot;
  }

  async function probe(candidate) {
    const row = await probeOne(candidate);
    return row.ok === true;
  }

  async function selectWorkingBaseUrl() {
    const snap = await refreshCompanionPaths({ force: true });
    picked = true;
    return snap.activeUrl || null;
  }

  async function ensurePicked() {
    if (picked) return baseUrl;
    return selectWorkingBaseUrl();
  }

  async function failoverFrom(failedBase) {
    const snap = await refreshCompanionPaths({ force: true });
    if (snap.activeUrl && snap.activeUrl !== failedBase) return snap.activeUrl;
    return null;
  }

  async function request(pathname, { method = 'GET', body, _failover = true } = {}) {
    await ensurePicked();
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
      if (err instanceof CompanionApiError) {
        if (_failover && (err.kind === 'timeout' || err.kind === 'connection')) {
          const alt = await failoverFrom(baseUrl);
          if (alt) return request(pathname, { method, body, _failover: false });
        }
        throw err;
      }
      if (err?.name === 'AbortError') {
        const timeoutErr = new CompanionApiError({
          kind: 'timeout',
          message: `Companion API timeout after ${timeoutMs}ms`,
          cause: err,
        });
        if (_failover) {
          const alt = await failoverFrom(baseUrl);
          if (alt) return request(pathname, { method, body, _failover: false });
        }
        throw timeoutErr;
      }
      const connErr = new CompanionApiError({
        kind: 'connection',
        message: err?.message || 'Companion API connection failed',
        cause: err,
      });
      if (_failover) {
        const alt = await failoverFrom(baseUrl);
        if (alt) return request(pathname, { method, body, _failover: false });
      }
      throw connErr;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestBytes(pathname, { _failover = true } = {}) {
    await ensurePicked();
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
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'image/jpeg, application/json', ...companionAuthHeaders(env) },
        signal: ac.signal,
      });
      const ctype = String(res.headers.get('content-type') || '');
      if (!res.ok) {
        let body = {};
        try {
          const text = await res.text();
          body = text ? JSON.parse(text) : {};
        } catch {
          body = {};
        }
        throw new CompanionApiError({
          kind: 'http',
          message: body.message || body.reason || `Companion HTTP ${res.status}`,
          status: res.status,
          body,
        });
      }
      if (ctype.includes('json')) {
        throw new CompanionApiError({
          kind: 'http',
          message: 'no_frame',
          status: 404,
          body: { reason: 'no_frame' },
        });
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) {
        throw new CompanionApiError({
          kind: 'http',
          message: 'no_frame',
          status: 404,
          body: { reason: 'no_frame' },
        });
      }
      return { contentType: ctype || 'image/jpeg', bytes };
    } catch (err) {
      if (err instanceof CompanionApiError) {
        if (_failover && (err.kind === 'timeout' || err.kind === 'connection')) {
          const alt = await failoverFrom(baseUrl);
          if (alt) return requestBytes(pathname, { _failover: false });
        }
        throw err;
      }
      if (err?.name === 'AbortError') {
        if (_failover) {
          const alt = await failoverFrom(baseUrl);
          if (alt) return requestBytes(pathname, { _failover: false });
        }
        throw new CompanionApiError({
          kind: 'timeout',
          message: `Companion API timeout after ${timeoutMs}ms`,
          cause: err,
        });
      }
      if (_failover) {
        const alt = await failoverFrom(baseUrl);
        if (alt) return requestBytes(pathname, { _failover: false });
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

  async function openByteStream(pathname) {
    await ensurePicked();
    if (!baseUrl) {
      throw new CompanionApiError({
        kind: 'config',
        message: 'JETSON_COMPANION_BASE_URL is not set',
      });
    }
    const url = joinCompanionUrl(baseUrl, pathname);
    const ac = new AbortController();
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'multipart/x-mixed-replace, image/jpeg', ...companionAuthHeaders(env) },
      signal: ac.signal,
    });
    const ctype = String(res.headers.get('content-type') || '');
    if (!res.ok || !res.body || ctype.includes('json')) {
      let body = {};
      try {
        const text = await res.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      throw new CompanionApiError({
        kind: 'http',
        message: body.message || body.reason || `Companion HTTP ${res.status}`,
        status: res.status || 502,
        body,
      });
    }
    return {
      body: res.body,
      contentType: ctype || 'multipart/x-mixed-replace; boundary=frame',
      abort() { ac.abort(); },
    };
  }

  const client = {
    kind: 'real',
    apiVersion: COMPANION_API_VERSION,
    get baseUrl() {
      return baseUrl;
    },
    get candidateBaseUrls() {
      return candidates.slice();
    },
    getPathSnapshot() {
      return pathSnapshot;
    },
    refreshCompanionPaths,
    selectWorkingBaseUrl,
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
    openWebSocket(wsOpts = {}) {
      const url = this.wsUrl();
      if (!url) {
        throw new CompanionApiError({
          kind: 'config',
          message: 'JETSON_COMPANION_BASE_URL is not set',
        });
      }
      return openJetsonWebSocket(url, { ...wsOpts, env });
    },
    getHealth: async () => {
      try {
        return await request(COMPANION_V1_PATHS.health);
      } catch (err) {
        if (err instanceof CompanionApiError && err.kind === 'http' && Number(err.status) === 404) {
          return request('/api/health');
        }
        throw err;
      }
    },
    getVersion: () => request(COMPANION_V1_PATHS.version),
    getStatus: () => request(COMPANION_V1_PATHS.status),
    getStatusSystem: () => request(COMPANION_V1_PATHS.statusSystem),
    getStatusFc: () => request(COMPANION_V1_PATHS.statusFc),
    getNetworkUplinks: () => request(COMPANION_V1_PATHS.networkUplinks),
    setNetworkUplink: (link, body) => {
      const kind = String(link || '').trim().toLowerCase();
      if (kind !== 'wifi' && kind !== 'cellular') {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: 'bad_link',
          body: { ok: false, reason: 'bad_link' },
        });
      }
      if (!body || typeof body.enabled !== 'boolean') {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: 'bad_body',
          body: { ok: false, reason: 'bad_body' },
        });
      }
      return request(`${COMPANION_V1_PATHS.networkUplinks}/${kind}`, {
        method: 'POST',
        body: { enabled: body.enabled },
      });
    },
    getStatusMavlink: () => request(COMPANION_V1_PATHS.statusMavlink),
    getStatusChannels: () => request(COMPANION_V1_PATHS.statusChannels),
    getStatusVision: () => request(COMPANION_V1_PATHS.statusVision),
    getStatusCameras: () => request(COMPANION_V1_PATHS.statusCameras),
    getStatusGimbal: () => request(COMPANION_V1_PATHS.statusGimbal),
    /**
     * Latest JPEG for cam0..cam3. 404 / empty is honest — never invent a frame.
     * @param {'cam0'|'cam1'|'cam2'|'cam3'|string} camId
     */
    getCameraFrame: async (camId) => {
      const key = String(camId || '').trim().toLowerCase();
      if (!COMPANION_CAMERA_IDS.includes(key)) {
        throw new CompanionApiError({
          kind: 'http',
          status: 404,
          message: 'unknown_camera',
          body: { ok: false, reason: 'unknown_camera' },
        });
      }
      return requestBytes(cameraFramePath(key));
    },
    getCam0Status: () => request(COMPANION_V1_PATHS.cam0Status),
    getCam0Health: () => request(COMPANION_V1_PATHS.cam0Health),
    getCam0Settings: () => request(COMPANION_V1_PATHS.cam0Settings),
    postCam0Settings: (body) => request(COMPANION_V1_PATHS.cam0Settings, { method: 'POST', body: body || {} }),
    getCam1Status: () => request(COMPANION_V1_PATHS.cam1Status),
    getCam1Health: () => request(COMPANION_V1_PATHS.cam1Health),
    getCam1Settings: () => request(COMPANION_V1_PATHS.cam1Settings),
    postCam1Settings: (body) => request(COMPANION_V1_PATHS.cam1Settings, { method: 'POST', body: body || {} }),
    getCam1Snapshot: () => requestBytes(COMPANION_V1_PATHS.cam1Snapshot),
    openCam1Stream: () => openByteStream(COMPANION_V1_PATHS.cam1Stream),
    getCam0Detections: () => request(COMPANION_V1_PATHS.cam0Detections),
    getCam0Modules: () => request(COMPANION_V1_PATHS.cam0Modules),
    postCam0Module: (name, body) => request(`${COMPANION_V1_PATHS.cam0Modules}/${encodeURIComponent(String(name || ''))}`, { method: 'POST', body: body || {} }),
    getCam0Calibration: () => request(COMPANION_V1_PATHS.cam0Calibration),
    postCam0CalibrationCapture: (body) => request(COMPANION_V1_PATHS.cam0CalibrationCapture, { method: 'POST', body: body || {} }),
    postCam0CalibrationSolve: () => request(COMPANION_V1_PATHS.cam0CalibrationSolve, { method: 'POST', body: {} }),
    postCam0RecordStart: (body) => request(COMPANION_V1_PATHS.cam0RecordStart, { method: 'POST', body: body || {} }),
    postCam0RecordStop: () => request(COMPANION_V1_PATHS.cam0RecordStop, { method: 'POST', body: {} }),
    getCam0Recordings: () => request(COMPANION_V1_PATHS.cam0Recordings),
    getCam0Recording: (flightId) => request(`${COMPANION_V1_PATHS.cam0Recordings}/${encodeURIComponent(String(flightId || ''))}`),
    getCam0RecordingFrame: (flightId, index) => requestBytes(`${COMPANION_V1_PATHS.cam0Recordings}/${encodeURIComponent(String(flightId || ''))}/frame.jpg?i=${encodeURIComponent(index ?? 0)}`),
    getCam0Snapshot: () => requestBytes(COMPANION_V1_PATHS.cam0Snapshot),
    postGimbalRate: (body) => request(COMPANION_V1_PATHS.gimbalRate, { method: 'POST', body: body || {} }),
    postGimbalAngle: (body) => request(COMPANION_V1_PATHS.gimbalAngle, { method: 'POST', body: body || {} }),
    postGimbalCenter: (body) => request(COMPANION_V1_PATHS.gimbalCenter, { method: 'POST', body: body || {} }),
    postGimbalZoom: (body) => request(COMPANION_V1_PATHS.gimbalZoom, { method: 'POST', body: body || {} }),
    postGimbalMode: (body) => request(COMPANION_V1_PATHS.gimbalMode, { method: 'POST', body: body || {} }),
    postGimbalPhoto: (body) => request(COMPANION_V1_PATHS.gimbalPhoto, { method: 'POST', body: body || {} }),
    postGimbalRecord: (body) => request(COMPANION_V1_PATHS.gimbalRecord, { method: 'POST', body: body || {} }),
    getVisionResult: () => request(COMPANION_V1_PATHS.visionResult),
    getStatusNavigation: () => request(COMPANION_V1_PATHS.statusNavigation),
    getStatusOpticalNav: () => request(COMPANION_V1_PATHS.statusOpticalNav),
    getNavigationEstimate: () => request(COMPANION_V1_PATHS.navigationEstimate),
    getStatusLanding: () => request(COMPANION_V1_PATHS.statusLanding),
    getStatusVideo: () => request(COMPANION_V1_PATHS.statusVideo),
    getDiagnostics: () => request(COMPANION_V1_PATHS.diagnostics),
    getMaintenance: () => request(COMPANION_V1_PATHS.maintenance),
    getMaintenanceReleases: () => request(COMPANION_V1_PATHS.maintenanceReleases),
    getMaintenanceRelease: (id) => request(`${COMPANION_V1_PATHS.maintenanceReleases}/${encodeURIComponent(String(id || ''))}`),
    getMaintenanceBackups: () => request(COMPANION_V1_PATHS.maintenanceBackups),
    getVersions: () => request(COMPANION_V1_PATHS.versions),
    postVersionsRollback: (backupId) => request(COMPANION_V1_PATHS.versionsRollback, {
      method: 'POST',
      body: { backup_id: String(backupId || ''), confirm: true },
    }),
    postVersionsKnownGood: () => request(COMPANION_V1_PATHS.versionsKnownGood, {
      method: 'POST',
      body: { known_good: true, confirm: true },
    }),
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
    /**
     * GET /api/v1/events (text/event-stream). Resolves once the response is accepted.
     * Reading continues until abort or the server closes; `done` settles then.
     * Same auth headers as other Companion calls. Not used by the browser.
     * @param {{ onEvent?: (envelope: object) => void, signal?: AbortSignal }} [opts]
     * @returns {Promise<{ done: Promise<void> }>}
     */
    async openEventsStream({ onEvent, signal } = {}) {
      await ensurePicked();
      if (!baseUrl) {
        throw new CompanionApiError({
          kind: 'config',
          message: 'JETSON_COMPANION_BASE_URL is not set',
        });
      }
      const url = joinCompanionUrl(baseUrl, COMPANION_V1_PATHS.events);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const connectTimer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...companionAuthHeaders(env),
          },
          signal: ac.signal,
        });
        clearTimeout(connectTimer);
        if (!res.ok) {
          let data = {};
          try {
            const text = await res.text();
            if (text) data = JSON.parse(text);
          } catch {
            // body is optional on error
          }
          throw new CompanionApiError({
            kind: 'http',
            message: data.message || data.error || `Companion HTTP ${res.status}`,
            status: res.status,
            body: data,
          });
        }
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          throw new CompanionApiError({
            kind: 'parse',
            status: res.status,
            message: 'Companion /events did not return text/event-stream',
          });
        }
        if (!res.body || typeof res.body.getReader !== 'function') {
          throw new CompanionApiError({
            kind: 'connection',
            message: 'Companion events stream has no body',
          });
        }
        const done = readCompanionSseStream(
          res.body,
          (raw) => {
            const envelope = normalizeCompanionEventEnvelope(raw);
            if (envelope) onEvent?.(envelope);
          },
          ac.signal,
        ).catch((err) => {
          if (signal?.aborted || ac.signal.aborted) return;
          throw err;
        });
        return { done };
      } catch (err) {
        clearTimeout(connectTimer);
        if (err instanceof CompanionApiError) throw err;
        if (err?.name === 'AbortError') {
          throw new CompanionApiError({
            kind: 'timeout',
            message: `Companion events connect timeout after ${timeoutMs}ms`,
            cause: err,
          });
        }
        throw new CompanionApiError({
          kind: 'connection',
          message: err?.message || 'Companion events connection failed',
          cause: err,
        });
      }
    },
  };

  for (const name of COMPANION_V1_FORBIDDEN) {
    if (name in client) {
      throw new Error(`CompanionApiClient must not expose ${name}`);
    }
  }

  return client;
}
