/**
 * Bridge Companion events (SSE / WS later, poll + mock now) into existing /api/stream.
 * Browser keeps EventSource('/api/stream') — no second client event architecture.
 */

import { mapCompanionStatus, emptyCompanionMapped, COMPANION_STATES } from './companion-status.mjs';

/**
 * @param {object | null} mapped  output of mapCompanionStatus
 * @param {{ mode: string, reachable: boolean, error?: string | null }} meta
 */
export function companionMappedToSseOverlay(mapped, meta) {
  const unreachable = meta.reachable === false;
  const m = mapped || emptyCompanionMapped();
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
  if (overlay.hasSnapshot) {
    payload.jetson = { ...base.jetson, ...overlay.jetson };
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

async function collectStatusBundle(client) {
  if (typeof client.getFullSnapshot === "function") {
    return client.getFullSnapshot();
  }
  const [status, visionResult, navigationEstimate, diagnostics, version, config, policy, policyPreview] = await Promise.all([
    client.getStatus(),
    client.getVisionResult().catch(() => null),
    client.getNavigationEstimate().catch(() => null),
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
  let timer = null;
  let stopped = true;
  const mockHandler = () => {
    refresh().catch(() => {});
  };

  async function refresh() {
    try {
      const bundle = await collectStatusBundle(client);
      const mapped = mapCompanionStatus(bundle);
      overlay = companionMappedToSseOverlay(mapped, { mode, reachable: true, error: null });
      opts.onOverlay?.(overlay);
    } catch (err) {
      overlay = companionMappedToSseOverlay(null, {
        mode,
        reachable: false,
        error: err?.kind || err?.message || 'companion_unreachable',
      });
      opts.onOverlay?.(overlay);
    }
  }

  return {
    getOverlay() {
      return overlay;
    },
    refresh,
    async start() {
      if (!client || !stopped) return;
      stopped = false;
      await refresh();
      if (typeof client.on === 'function') {
        client.on('companion', mockHandler);
      }
      if (client.kind !== 'mock') {
        timer = setInterval(() => {
          refresh().catch(() => {});
        }, pollMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (typeof client?.off === 'function') {
        client.off('companion', mockHandler);
      }
    },
  };
}
