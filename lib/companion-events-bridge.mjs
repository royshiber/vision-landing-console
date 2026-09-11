/**
 * Bridge Companion events into existing /api/stream.
 * Real mode prefers GET /api/v1/events (SSE); poll is the fallback.
 * Mock stays emitter-based. Browser keeps EventSource('/api/stream').
 */

import { CompanionApiError } from './companion-api-client.mjs';
import { mapCompanionStatus, emptyCompanionMapped, COMPANION_STATES } from './companion-status.mjs';
import { summarizeCompanionLink } from './companion-link.mjs';
import {
  mergeCompanionEventIntoBundle,
  normalizeCompanionEventEnvelope,
} from './companion-events-sse.mjs';

/**
 * @param {object | null} mapped  output of mapCompanionStatus
 * @param {{ mode: string, reachable: boolean, error?: string | null }} meta
 */
export function companionMappedToSseOverlay(mapped, meta) {
  const unreachable = meta.reachable === false;
  const m = mapped || emptyCompanionMapped();
  const link = meta.link || summarizeCompanionLink({
    mode: meta.mode,
    reachable: !!meta.reachable && !unreachable,
    health: meta.health || null,
    overlay: unreachable ? null : m,
  });
  return {
    hasSnapshot: !!mapped && !unreachable,
    companion: {
      mode: meta.mode,
      reachable: !!meta.reachable,
      api: "v1",
      overall: unreachable ? COMPANION_STATES.DISCONNECTED : m.overall,
      state: unreachable ? COMPANION_STATES.DISCONNECTED : m.overall,
      states: unreachable ? null : m.states,
      error: meta.error || null,
      unavailable: unreachable,
      message: unreachable ? "Companion API not available" : null,
      version: unreachable ? null : m.version,
      system: unreachable ? null : m.system,
      fc: unreachable ? null : m.fc,
      fc_linked: link.fc_linked,
      fc_heartbeat: link.fc_heartbeat,
      link,
      health: unreachable ? null : (meta.health || null),
      mavlink: unreachable ? null : m.mavlink,
      vision: unreachable ? null : m.vision,
      navigation: unreachable ? null : m.navigation,
      landing: unreachable ? null : m.landing,
      video: unreachable ? null : m.video,
      channels: unreachable ? null : m.channels,
      diagnostics: unreachable ? null : m.diagnostics,
      config: unreachable ? null : m.config,
      policy: unreachable ? null : m.policy,
      policyPreview: unreachable ? null : m.policyPreview,
      api_version: unreachable ? null : m.api_version,
    },
    jetson: unreachable ? undefined : m.compatibility.jetson,
    vision: unreachable ? undefined : m.compatibility.vision,
    slam: unreachable ? undefined : m.compatibility.slam,
    visionNav: unreachable ? undefined : m.compatibility.visionNav,
  };
}

/**
 * Compatibility overlay hardcodes lateralOffsetM/headingErrorDeg as null.
 * A later companion snapshot must not wipe finite POST /api/vision/frame values.
 * Finite overlay numbers still win.
 * @param {unknown} baseVal
 * @param {unknown} overlayVal
 * @returns {unknown}
 */
export function preserveFiniteIfNull(baseVal, overlayVal) {
  if (overlayVal == null && Number.isFinite(baseVal)) return baseVal;
  return overlayVal === undefined ? baseVal : overlayVal;
}

/**
 * Merge companion overlay into the existing SSE telemetry payload.
 * When there is no snapshot, legacy jetson/vision/slam fields are unchanged.
 */
export function mergeTelemetryWithCompanion(base, overlay) {
  const payload = { ...base };
  if (!overlay) {
    payload.companion = {
      mode: 'off',
      reachable: false,
      api: 'v1',
      overall: COMPANION_STATES.DISCONNECTED,
      states: null,
      error: null,
    };
    return payload;
  }
  payload.companion = overlay.companion;
  const overlayJetson = overlay.jetson;
  if (overlay.hasSnapshot || overlayJetson) {
    payload.jetson = { ...base.jetson, ...overlayJetson };
    if (overlayJetson) {
      for (const key of ['cpuLoadPct', 'memPct', 'tempC']) {
        if (Number.isFinite(Number(overlayJetson[key]))) payload.jetson[key] = overlayJetson[key];
      }
    }
    payload.vision = { ...base.vision, ...overlay.vision };
    payload.vision.lateralOffsetM = preserveFiniteIfNull(
      base.vision?.lateralOffsetM,
      overlay.vision?.lateralOffsetM,
    );
    payload.vision.headingErrorDeg = preserveFiniteIfNull(
      base.vision?.headingErrorDeg,
      overlay.vision?.headingErrorDeg,
    );
    payload.slam = { ...base.slam, ...overlay.slam };
    if (overlay.visionNav?.mode) {
      payload.visionNav = { ...base.visionNav, ...overlay.visionNav };
    }
  }
  return payload;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Jetson companion_agent.py exposes cpuLoadPct / memPct / tempC on GET /api/health.
 * Map that legacy body into a status-shaped bundle so Status gauges have a data path.
 */
export function statusBundleFromLegacyHealth(health) {
  const h = health && typeof health === 'object' && !Array.isArray(health) ? health : {};
  const systemIn = h.system && typeof h.system === 'object' ? h.system : {};
  const cpu = finiteOrNull(h.cpuLoadPct ?? h.cpu_percent ?? systemIn.cpuLoadPct ?? systemIn.cpu_percent);
  const mem = finiteOrNull(h.memPct ?? h.mem_pct ?? systemIn.memPct ?? systemIn.mem_pct);
  const temp = finiteOrNull(h.tempC ?? h.temperature_c ?? systemIn.tempC ?? systemIn.temperature_c);
  return {
    timestamp: h.timestamp ?? { t_monotonic_ns: Date.now() * 1e6, t_utc_ns: null },
    status: h.status || h.overall || 'OK',
    system: {
      ...systemIn,
      cpu_percent: cpu,
      cpuLoadPct: cpu,
      memPct: mem,
      temperature_c: temp,
      tempC: temp,
    },
    fc: h.fc && typeof h.fc === 'object' ? h.fc : {},
    mavlink: h.mavlink && typeof h.mavlink === 'object' ? h.mavlink : {},
    companion_version: h.companion_version || h.agentVersion || h.version || null,
    api_version: h.api_version || h.api || null,
    health: h,
    legacyHealth: true,
  };
}

export async function collectStatusBundle(client) {
  if (typeof client.getFullSnapshot === "function") {
    return client.getFullSnapshot();
  }
  const health = client.getHealth ? await client.getHealth() : null;
  let status;
  try {
    status = await client.getStatus();
  } catch (err) {
    if (health && err instanceof CompanionApiError && err.kind === 'http' && Number(err.status) === 404) {
      return statusBundleFromLegacyHealth(health);
    }
    throw err;
  }
  const [visionResult, navigationEstimate, diagnostics, version, config, policy, policyPreview] = await Promise.all([
    client.getVisionResult ? client.getVisionResult().catch(() => null) : Promise.resolve(null),
    client.getNavigationEstimate ? client.getNavigationEstimate().catch(() => null) : Promise.resolve(null),
    client.getDiagnostics ? client.getDiagnostics().catch(() => null) : Promise.resolve(null),
    client.getVersion ? client.getVersion().catch(() => null) : Promise.resolve(null),
    client.getConfig ? client.getConfig().catch(() => null) : Promise.resolve(null),
    client.getPolicy ? client.getPolicy().catch(() => null) : Promise.resolve(null),
    client.getPolicyPreview ? client.getPolicyPreview().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    ...status,
    visionResult,
    navigationEstimate,
    diagnostics,
    companion_version: version && version.companion_version,
    api_version: version && version.api_version,
    config,
    policy,
    policyPreview,
    health,
  };
}

/**
 * @param {{
 *   client: object,
 *   mode: string,
 *   pollMs?: number,
 *   onOverlay?: (overlay: object) => void,
 * }} opts
 */
export function createCompanionEventBridge(opts) {
  const client = opts.client;
  const mode = opts.mode || client?.kind || 'off';
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 1000;
  let overlay = companionMappedToSseOverlay(null, { mode, reachable: false });
  let lastBundle = null;
  let timer = null;
  let stopped = true;
  /** @type {'idle' | 'mock' | 'events' | 'poll'} */
  let transport = 'idle';
  /** @type {AbortController | null} */
  let streamAbort = null;
  const mockHandler = () => {
    refresh().catch(() => {});
  };

  function publishBundle(bundle, reachable, error) {
    if (reachable && bundle) {
      lastBundle = bundle;
      const mapped = mapCompanionStatus(bundle);
      const link = summarizeCompanionLink({
        mode,
        reachable: true,
        health: bundle.health || null,
        overlay: mapped,
      });
      overlay = companionMappedToSseOverlay(mapped, {
        mode,
        reachable: true,
        error: null,
        health: bundle.health || null,
        link,
      });
    } else {
      lastBundle = null;
      overlay = companionMappedToSseOverlay(null, {
        mode,
        reachable: false,
        error: error || 'companion_unreachable',
      });
    }
    opts.onOverlay?.(overlay);
  }

  async function refresh() {
    try {
      const bundle = await collectStatusBundle(client);
      publishBundle(bundle, true, null);
    } catch (err) {
      publishBundle(null, false, err?.kind || err?.message || 'companion_unreachable');
    }
  }

  function applyEnvelope(raw) {
    const envelope = normalizeCompanionEventEnvelope(raw);
    if (!envelope) return;
    if (!lastBundle && envelope.event !== 'status') {
      refresh().catch(() => {});
      return;
    }
    const merged = mergeCompanionEventIntoBundle(lastBundle, envelope);
    publishBundle(merged, true, null);
  }

  function startPoll() {
    if (stopped || timer || client.kind === 'mock') return;
    transport = 'poll';
    timer = setInterval(() => {
      refresh().catch(() => {});
    }, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopPoll() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function tryStartEventsStream() {
    if (typeof client.openEventsStream !== 'function') return false;
    streamAbort = new AbortController();
    try {
      const handle = await client.openEventsStream({
        onEvent: applyEnvelope,
        signal: streamAbort.signal,
      });
      if (stopped) {
        streamAbort.abort();
        return true;
      }
      transport = 'events';
      const done = handle?.done;
      if (done && typeof done.then === 'function') {
        done.catch(() => {}).finally(() => {
          if (!stopped) startPoll();
        });
      }
      return true;
    } catch {
      // 404 / 501 / connection / any other open failure → poll fallback.
      streamAbort = null;
      return false;
    }
  }

  return {
    getOverlay() {
      return overlay;
    },
    getTransport() {
      return transport;
    },
    refresh,
    async start() {
      if (!client || !stopped) return;
      stopped = false;
      await refresh();
      if (stopped) return;
      if (client.kind === 'mock') {
        transport = 'mock';
        if (typeof client.on === 'function') {
          client.on('companion', mockHandler);
        }
        return;
      }
      const streaming = await tryStartEventsStream();
      if (!streaming && !stopped) startPoll();
    },
    stop() {
      stopped = true;
      stopPoll();
      if (streamAbort) {
        streamAbort.abort();
        streamAbort = null;
      }
      transport = 'idle';
      if (typeof client?.off === 'function') {
        client.off('companion', mockHandler);
      }
    },
  };
}
