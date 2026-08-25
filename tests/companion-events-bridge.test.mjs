import { describe, expect, it } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import {
  companionMappedToSseOverlay,
  createCompanionEventBridge,
  mergeTelemetryWithCompanion,
  preserveFiniteIfNull,
} from '../lib/companion-events-bridge.mjs';
import { mapCompanionStatus, COMPANION_STATES } from '../lib/companion-status.mjs';

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
});
