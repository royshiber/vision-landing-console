/**
 * Overlay Companion snapshots onto existing EventSource('/api/stream') telemetry.
 * Do not add a second browser EventSource. Phase A: mock events + poll; real WS later.
 */

import { mapCompanionStatus, toSseTelemetryOverlay, COMPANION_STATES } from "./companion-status.mjs";

const POLL_MS = 1000;

export function createCompanionEventsBridge(opts = {}) {
  const getClient = typeof opts.getClient === "function" ? opts.getClient : () => null;
  const mode = () => String(opts.getMode ? opts.getMode() : opts.mode || "off");
  let timer = null;
  let lastOverlay = null;
  let lastError = null;
  let started = false;

  async function refresh() {
    const m = mode();
    if (m === "off") {
      lastOverlay = {
        companion: { state: COMPANION_STATES.DISABLED, connected: false, version: null, updatedAt: Date.now() },
      };
      return lastOverlay;
    }
    const client = getClient();
    if (!client || typeof client.getStatus !== "function") {
      lastOverlay = {
        companion: { state: COMPANION_STATES.NOT_PRESENT, connected: false, version: null, updatedAt: Date.now() },
      };
      return lastOverlay;
    }
    try {
      const raw = await client.getStatus();
      const mapped = mapCompanionStatus(raw);
      lastOverlay = toSseTelemetryOverlay(mapped, { updatedAt: Date.now() });
      lastError = null;
    } catch (e) {
      lastError = e;
      lastOverlay = {
        companion: {
          state: COMPANION_STATES.DISCONNECTED,
          connected: false,
          version: null,
          updatedAt: Date.now(),
          errorKind: e && e.kind,
        },
      };
    }
    return lastOverlay;
  }

  return {
    refresh,
    getLastOverlay: () => lastOverlay,
    getLastError: () => lastError,
    async start() {
      if (started) return;
      started = true;
      await refresh();
      timer = setInterval(() => {
        refresh().catch(() => {});
      }, opts.pollMs > 0 ? opts.pollMs : POLL_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    stop() {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
