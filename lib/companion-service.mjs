/**
 * Console-side Companion wiring: mode + real|mock client + event bridge.
 * JETSON_COMPANION_BASE_URL is the only v1 base URL (never heartbeat :8081).
 * Real requires BOTH COMPANION_MODE=real AND a non-empty JETSON_COMPANION_BASE_URL.
 * A URL alone never enables real. COMPANION_MODE=real without a URL stays off.
 */

import { createCompanionApiClient, resolveCompanionV1BaseUrl } from './companion-api-client.mjs';
import { createCompanionMock } from './companion-mock.mjs';
import { createCompanionEventBridge } from './companion-events-bridge.mjs';
import { COMPANION_STATES } from './companion-status.mjs';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'off'|'mock'|'real'}
 */
export function resolveCompanionMode(env = process.env) {
  const raw = String(env.COMPANION_MODE || '').trim().toLowerCase();
  if (raw === 'mock' || raw === 'off') return raw;
  const hasUrl = Boolean(resolveCompanionV1BaseUrl(env));
  if (raw === 'real' && hasUrl) return 'real';
  return 'off';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetchImpl?: typeof fetch, mockScenario?: string, pollMs?: number }} [opts]
 */
export function createCompanionService(env = process.env, opts = {}) {
  const mode = resolveCompanionMode(env);
  const baseUrl = resolveCompanionV1BaseUrl(env);
  /** @type {object | null} */
  let client = null;
  if (mode === 'mock') {
    client = createCompanionMock({ scenario: opts.mockScenario || env.COMPANION_MOCK_SCENARIO || 'healthy' });
  } else if (mode === 'real' && baseUrl) {
    client = createCompanionApiClient({
      baseUrl,
      env,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
  }

  const bridge = client
    ? createCompanionEventBridge({
        client,
        mode,
        pollMs: opts.pollMs,
      })
    : null;

  return {
    mode,
    baseUrl,
    client,
    bridge,
    getSseOverlay() {
      if (!bridge) {
        return {
          hasSnapshot: false,
          companion: {
            mode: 'off',
            reachable: false,
            api: 'v1',
            overall: COMPANION_STATES.DISCONNECTED,
            states: null,
            error: null,
          },
        };
      }
      return bridge.getOverlay();
    },
    start() {
      return bridge?.start();
    },
    stop() {
      bridge?.stop();
    },
    describe() {
      return {
        lane: 'NEW',
        mode,
        api: 'v1',
        baseUrlConfigured: !!baseUrl,
        baseUrl: mode === 'mock' ? 'mock://companion' : baseUrl,
        mockScenario: mode === 'mock' ? client?.scenario || null : null,
      };
    },
    setMockScenario(name) {
      if (mode !== 'mock' || typeof client?.setScenario !== 'function') return false;
      client.setScenario(name);
      return bridge?.refresh?.() || true;
    },
  };
}
