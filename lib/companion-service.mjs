/**
 * Console-side Companion wiring: mode + real|mock client + event bridge.
 * JETSON_COMPANION_BASE_URL is the only v1 base URL.
 * Real requires BOTH COMPANION_MODE=real AND a non-empty JETSON_COMPANION_BASE_URL.
 * A URL alone never enables real. COMPANION_MODE=real without a URL stays off.
 * The v1 base must serve /api/v1/* — do not confuse it with the legacy heartbeat
 * install API. Port 8081 is allowed when that is where v1 listens.
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
 * @param {{ fetchImpl?: typeof fetch, mockScenario?: string, pollMs?: number, timeoutMs?: number }} [opts]
 */
export function createCompanionService(env = process.env, opts = {}) {
  const runtime = {
    env,
    mode: 'off',
    baseUrl: null,
    client: null,
    bridge: null,
    started: false,
  };

  function buildFromEnv(nextEnv) {
    const mode = resolveCompanionMode(nextEnv);
    const baseUrl = resolveCompanionV1BaseUrl(nextEnv);
    /** @type {object | null} */
    let client = null;
    if (mode === 'mock') {
      client = createCompanionMock({ scenario: opts.mockScenario || nextEnv.COMPANION_MOCK_SCENARIO || 'healthy' });
    } else if (mode === 'real' && baseUrl) {
      client = createCompanionApiClient({
        baseUrl,
        env: nextEnv,
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
    runtime.env = nextEnv;
    runtime.mode = mode;
    runtime.baseUrl = baseUrl;
    runtime.client = client;
    runtime.bridge = bridge;
  }

  async function start() {
    runtime.started = true;
    return runtime.bridge?.start();
  }

  function stop() {
    runtime.started = false;
    runtime.bridge?.stop();
  }

  async function applyEnv(nextEnv) {
    const wasStarted = runtime.started;
    runtime.bridge?.stop();
    runtime.started = false;
    buildFromEnv(nextEnv || {});
    if (wasStarted) {
      return start();
    }
    return undefined;
  }

  buildFromEnv(env);

  return {
    get mode() {
      return runtime.mode;
    },
    get baseUrl() {
      return runtime.baseUrl;
    },
    get client() {
      return runtime.client;
    },
    get bridge() {
      return runtime.bridge;
    },
    applyEnv,
    getSseOverlay() {
      if (!runtime.bridge) {
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
      return runtime.bridge.getOverlay();
    },
    start,
    stop,
    describe() {
      return {
        lane: 'NEW',
        mode: runtime.mode,
        api: 'v1',
        baseUrlConfigured: !!runtime.baseUrl,
        baseUrl: runtime.mode === 'mock' ? 'mock://companion' : runtime.baseUrl,
        mockScenario: runtime.mode === 'mock' ? runtime.client?.scenario || null : null,
      };
    },
    setMockScenario(name) {
      if (runtime.mode !== 'mock' || typeof runtime.client?.setScenario !== 'function') return false;
      runtime.client.setScenario(name);
      return runtime.bridge?.refresh?.() || true;
    },
  };
}
