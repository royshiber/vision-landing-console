import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionApiError } from '../lib/companion-api-client.mjs';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { healthyCompanionStatus } from '../lib/companion-mock-fixtures.mjs';
import { createCompanionService } from '../lib/companion-service.mjs';
import {
  companionMappedToSseOverlay,
  createCompanionEventBridge,
  mergeTelemetryWithCompanion,
  preserveFiniteIfNull,
} from '../lib/companion-events-bridge.mjs';
import { mapCompanionStatus, COMPANION_STATES } from '../lib/companion-status.mjs';

function createFakeRealClient({ stream = 'ok', status } = {}) {
  const snapshot = status || healthyCompanionStatus();
  const getFullSnapshot = vi.fn(async () => structuredClone(snapshot));
  /** @type {((envelope: object) => void) | null} */
  let onEvent = null;
  const openEventsStream = vi.fn(async ({ onEvent: cb, signal }) => {
    if (stream === '404') {
      throw new CompanionApiError({ kind: 'http', status: 404, message: 'not found' });
    }
    if (stream === '501') {
      throw new CompanionApiError({ kind: 'http', status: 501, message: 'not implemented' });
    }
    if (stream === 'connection') {
      throw new CompanionApiError({ kind: 'connection', message: 'ECONNREFUSED' });
    }
    onEvent = cb;
    const done = new Promise((resolve) => {
      if (!signal) return;
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { done };
  });
  return {
    kind: 'real',
    eventsUrl: () => 'http://jetson:8472/api/v1/events',
    openEventsStream,
    getFullSnapshot,
    emit(envelope) {
      onEvent?.(envelope);
    },
  };
}

describe('companion event bridge', () => {
  it('preserves EventSource /api/stream shape and adds companion', () => {
    const overlay = companionMappedToSseOverlay(mapCompanionStatus({ status: 'OK', system: { status: 'OK' } }), {
      mode: 'mock',
      reachable: true,
    });
    const merged = mergeTelemetryWithCompanion(
      {
        appVersion: '1.02.303',
        mavlink: { connected: false },
        jetson: { online: false, cpuLoadPct: null, ageMs: null },
        vision: { confidence: null, ageMs: null },
        slam: { posX: null },
        visionNav: { mode: 'prior_mission_map' },
      },
      overlay,
    );
    expect(merged.mavlink).toEqual({ connected: false });
    expect(merged.companion.mode).toBe('mock');
    expect(merged.companion.api).toBe('v1');
    expect(merged.jetson.companionStatus).toBe(COMPANION_STATES.OK);
  });

  it('does not overwrite legacy fields when there is no snapshot', () => {
    const merged = mergeTelemetryWithCompanion(
      { jetson: { online: true, cpuLoadPct: 11 }, vision: { confidence: null } },
      companionMappedToSseOverlay(null, { mode: 'real', reachable: false, error: 'timeout' }),
    );
    expect(merged.jetson.cpuLoadPct).toBe(11);
    expect(merged.companion.reachable).toBe(false);
    expect(merged.companion.error).toBe('timeout');
  });

  it('mock bridge emits overlay without a Jetson', async () => {
    const mock = createCompanionMock({ scenario: 'disconnected' });
    const bridge = createCompanionEventBridge({ client: mock, mode: 'mock', pollMs: 10_000 });
    await bridge.start();
    const overlay = bridge.getOverlay();
    expect(overlay.hasSnapshot).toBe(true);
    expect(overlay.vision.confidence).toBeNull();
    expect(overlay.companion.reachable).toBe(true);
    expect(overlay.jetson.companionStatus).toBe(COMPANION_STATES.OK);
    mock.setScenario('healthy');
    await bridge.refresh();
    expect(bridge.getOverlay().vision.confidence).not.toBeNull();
    bridge.stop();
  });

  it('off overlay keeps browser on /api/stream without companion data', () => {
    const merged = mergeTelemetryWithCompanion(
      { jetson: { online: false }, vision: { confidence: null } },
      null,
    );
    expect(merged.companion.mode).toBe('off');
    expect(merged.vision.confidence).toBeNull();
  });

  it('keeps finite legacy vision offsets when a companion snapshot overlay has nulls', () => {
    const overlay = companionMappedToSseOverlay(
      mapCompanionStatus({ timestamp: { t_monotonic_ns: 1, t_utc_ns: null }, system: { cpu_percent: 12 } }),
      { mode: 'mock', reachable: true },
    );
    expect(overlay.hasSnapshot).toBe(true);
    expect(overlay.vision.lateralOffsetM).toBeNull();
    expect(overlay.vision.headingErrorDeg).toBeNull();

    const merged = mergeTelemetryWithCompanion(
      {
        jetson: { online: true },
        vision: {
          lateralOffsetM: 1.25,
          headingErrorDeg: -3.5,
          confidence: 0.91,
          navLat: 32.1,
          navLon: 34.8,
        },
      },
      overlay,
    );
    expect(merged.vision.lateralOffsetM).toBe(1.25);
    expect(merged.vision.headingErrorDeg).toBe(-3.5);
    expect(merged.vision.navLat).toBe(32.1);
    expect(merged.vision.navLon).toBe(34.8);
  });

  it('lets finite companion overlay offsets replace legacy vision offsets', () => {
    const overlay = companionMappedToSseOverlay(
      mapCompanionStatus({ timestamp: { t_monotonic_ns: 1, t_utc_ns: null } }),
      { mode: 'mock', reachable: true },
    );
    overlay.vision = { ...overlay.vision, lateralOffsetM: 0.4, headingErrorDeg: 2 };
    const merged = mergeTelemetryWithCompanion(
      { vision: { lateralOffsetM: 1.25, headingErrorDeg: -3.5 } },
      overlay,
    );
    expect(merged.vision.lateralOffsetM).toBe(0.4);
    expect(merged.vision.headingErrorDeg).toBe(2);
  });

  it('preserveFiniteIfNull keeps a finite base when overlay is null', () => {
    expect(preserveFiniteIfNull(1.25, null)).toBe(1.25);
    expect(preserveFiniteIfNull(-3.5, undefined)).toBe(-3.5);
    expect(preserveFiniteIfNull(1.25, 0)).toBe(0);
    expect(preserveFiniteIfNull(null, null)).toBeNull();
  });

  it('uses /api/v1/events when the live stream is available and does not poll', async () => {
    vi.useFakeTimers();
    const client = createFakeRealClient();
    const bridge = createCompanionEventBridge({ client, mode: 'real', pollMs: 1000 });
    await bridge.start();
    expect(client.openEventsStream).toHaveBeenCalledOnce();
    expect(bridge.getTransport()).toBe('events');
    const snapshots = client.getFullSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.getFullSnapshot.mock.calls.length).toBe(snapshots);
    expect(bridge.getOverlay().hasSnapshot).toBe(true);
    bridge.stop();
    vi.useRealTimers();
  });

  it('maps a status EventEnvelope into the existing SSE overlay', async () => {
    const client = createFakeRealClient();
    const overlays = [];
    const bridge = createCompanionEventBridge({
      client,
      mode: 'real',
      onOverlay: (o) => overlays.push(o),
    });
    await bridge.start();
    expect(bridge.getOverlay().jetson.cpuLoadPct).toBe(41.2);
    const next = healthyCompanionStatus();
    next.system = { ...next.system, cpu_percent: 77.5 };
    client.emit({
      api_version: '1',
      event: 'status',
      timestamp: next.timestamp,
      payload: next,
    });
    expect(bridge.getTransport()).toBe('events');
    expect(bridge.getOverlay().hasSnapshot).toBe(true);
    expect(bridge.getOverlay().companion.reachable).toBe(true);
    expect(bridge.getOverlay().companion.system.cpu_percent).toBe(77.5);
    expect(bridge.getOverlay().jetson.cpuLoadPct).toBe(77.5);
    const merged = mergeTelemetryWithCompanion(
      { jetson: { online: false, cpuLoadPct: null }, vision: { confidence: null } },
      bridge.getOverlay(),
    );
    expect(merged.companion.mode).toBe('real');
    expect(merged.jetson.cpuLoadPct).toBe(77.5);
    expect(overlays.at(-1).jetson.cpuLoadPct).toBe(77.5);
    bridge.stop();
  });

  it.each(['404', '501', 'connection'])('falls back to status poll when events stream is %s', async (stream) => {
    vi.useFakeTimers();
    const client = createFakeRealClient({ stream });
    const bridge = createCompanionEventBridge({ client, mode: 'real', pollMs: 1000 });
    await bridge.start();
    expect(client.openEventsStream).toHaveBeenCalledOnce();
    expect(bridge.getTransport()).toBe('poll');
    const before = client.getFullSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getFullSnapshot.mock.calls.length).toBe(before + 1);
    expect(bridge.getOverlay().hasSnapshot).toBe(true);
    expect(bridge.getOverlay().jetson.cpuLoadPct).toBe(41.2);
    bridge.stop();
    vi.useRealTimers();
  });

  it('falls back to poll when the events stream is not implemented on the client', async () => {
    vi.useFakeTimers();
    const getFullSnapshot = vi.fn(async () => structuredClone(healthyCompanionStatus()));
    const client = {
      kind: 'real',
      eventsUrl: () => 'http://jetson:8472/api/v1/events',
      getFullSnapshot,
    };
    const bridge = createCompanionEventBridge({ client, mode: 'real', pollMs: 500 });
    await bridge.start();
    expect(bridge.getTransport()).toBe('poll');
    const before = getFullSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(getFullSnapshot.mock.calls.length).toBe(before + 1);
    bridge.stop();
    vi.useRealTimers();
  });

  it('mock bridge stays emitter-based and does not open the events stream', async () => {
    const mock = createCompanionMock({ scenario: 'disconnected' });
    mock.openEventsStream = vi.fn();
    const bridge = createCompanionEventBridge({ client: mock, mode: 'mock', pollMs: 10_000 });
    await bridge.start();
    expect(bridge.getTransport()).toBe('mock');
    expect(mock.openEventsStream).not.toHaveBeenCalled();
    const overlay = bridge.getOverlay();
    expect(overlay.hasSnapshot).toBe(true);
    expect(overlay.vision.confidence).toBeNull();
    expect(overlay.companion.reachable).toBe(true);
    mock.setScenario('healthy');
    await bridge.refresh();
    expect(bridge.getOverlay().vision.confidence).not.toBeNull();
    expect(bridge.getTransport()).toBe('mock');
    bridge.stop();
  });

  it('falls back to poll if the events stream ends after connect', async () => {
    vi.useFakeTimers();
    let endStream;
    const getFullSnapshot = vi.fn(async () => structuredClone(healthyCompanionStatus()));
    const client = {
      kind: 'real',
      eventsUrl: () => 'http://jetson:8472/api/v1/events',
      getFullSnapshot,
      openEventsStream: vi.fn(async ({ signal }) => {
        const done = new Promise((resolve) => {
          endStream = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { done };
      }),
    };
    const bridge = createCompanionEventBridge({ client, mode: 'real', pollMs: 1000 });
    await bridge.start();
    expect(bridge.getTransport()).toBe('events');
    const before = getFullSnapshot.mock.calls.length;
    endStream();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.getTransport()).toBe('poll');
    await vi.advanceTimersByTimeAsync(1000);
    expect(getFullSnapshot.mock.calls.length).toBe(before + 1);
    bridge.stop();
    vi.useRealTimers();
  });

  it('real service consumes client.eventsUrl and updates the overlay from SSE', async () => {
    const encoder = new TextEncoder();
    const status = healthyCompanionStatus();
    const envelope = {
      api_version: '1',
      event: 'status',
      timestamp: status.timestamp,
      payload: { ...status, system: { ...status.system, cpu_percent: 55 } },
    };
    const eventsUrls = [];
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/events')) {
        eventsUrls.push(u);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const svc = createCompanionService(
      { COMPANION_MODE: 'real', JETSON_COMPANION_BASE_URL: 'http://jetson:8472' },
      { fetchImpl, pollMs: 10_000, timeoutMs: 500 },
    );
    await svc.start();
    expect(eventsUrls).toEqual(['http://jetson:8472/api/v1/events']);
    expect(svc.bridge.getTransport()).toBe('events');
    await vi.waitFor(() => {
      expect(svc.getSseOverlay().companion.system.cpu_percent).toBe(55);
    });
    expect(svc.describe().eventsTransport).toBe('events');
    svc.stop();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
