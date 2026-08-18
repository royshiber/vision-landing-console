import { describe, expect, it } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import {
  companionMappedToSseOverlay,
  createCompanionEventBridge,
  mergeTelemetryWithCompanion,
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
});
