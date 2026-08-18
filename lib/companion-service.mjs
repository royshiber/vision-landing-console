/**
 * Companion service: COMPANION_MODE=off|mock|real (default off unless URL set).
 */

import { createCompanionApiClient } from "./companion-api-client.mjs";
import { createCompanionMock } from "./companion-mock.mjs";
import { createCompanionEventsBridge } from "./companion-events-bridge.mjs";
import { COMPANION_STATES } from "./companion-status.mjs";

export function resolveCompanionMode(env = process.env) {
  const raw = String(env.COMPANION_MODE || "").trim().toLowerCase();
  if (raw === "off" || raw === "mock" || raw === "real") return raw;
  if (String(env.JETSON_COMPANION_BASE_URL || "").trim()) return "real";
  return "off";
}

export function createCompanionService(opts = {}) {
  const env = opts.env || process.env;
  let mode = resolveCompanionMode(env);
  const mock = opts.mock || createCompanionMock();
  const realClient =
    opts.realClient ||
    createCompanionApiClient({
      baseUrl: env.JETSON_COMPANION_BASE_URL,
      sharedSecret: env.COMPANION_SHARED_SECRET,
      fetch: opts.fetch,
    });

  function getClient() {
    if (mode === "mock") return mock;
    if (mode === "real") return realClient;
    return null;
  }

  const bridge = createCompanionEventsBridge({
    getMode: () => mode,
    getClient,
    pollMs: opts.pollMs,
  });

  return {
    getMode: () => mode,
    setMode(next) {
      const n = String(next || "").toLowerCase();
      if (n === "off" || n === "mock" || n === "real") mode = n;
    },
    getClient,
    getMock: () => mock,
    getBridge: () => bridge,
    describe() {
      const overlay = bridge.getLastOverlay();
      return {
        mode,
        state: overlay?.companion?.state || (mode === "off" ? COMPANION_STATES.DISABLED : COMPANION_STATES.NOT_PRESENT),
        connected: overlay?.companion?.connected === true,
        version: overlay?.companion?.version || null,
      };
    },
    start: () => bridge.start(),
    stop: () => bridge.stop(),
  };
}
