import { describe, expect, it } from 'vitest';
import { COMPANION_STATES, mapCompanionStatus } from '../lib/companion-status.mjs';
import {
  healthyCompanionStatus,
  disconnectedCompanionStatus,
  degradedCompanionStatus,
  staleCompanionStatus,
  healthyVisionResult,
  healthyNavEstimate,
  apiUpFcDownCompanionStatus,
  waitingVisionResult,
  waitingNavEstimate,
} from '../lib/companion-mock-fixtures.mjs';

describe('companion-status mapper', () => {
  it('maps a healthy OpenAPI payload', () => {
    const m = mapCompanionStatus({
      ...healthyCompanionStatus(),
      visionResult: healthyVisionResult(),
      navigationEstimate: healthyNavEstimate(),
      companion_version: '0.1.0',
    });
    expect(m.overall).toBe(COMPANION_STATES.OK);
    expect(m.states.fc).toBe(COMPANION_STATES.OK);
    expect(m.vision.confidence).toBe(0.82);
    expect(m.vision.fps).toBe(30);
    expect(m.fc.armed).toBe(false);
    expect(m.compatibility.transitional).toBe(true);
    expect(m.compatibility.vision.confidence).toBe(0.82);
    expect(m.compatibility.jetson.cpuLoadPct).toBe(41.2);
  });

  it('keeps missing numerics as null, not zero', () => {
    const m = mapCompanionStatus(disconnectedCompanionStatus());
    expect(m.vision.confidence).toBeNull();
    expect(m.vision.fps).toBeNull();
    expect(m.vision.range_m).toBeNull();
    expect(m.navigation.posX).toBeNull();
    expect(m.video.fps).toBeNull();
    expect(m.fc.armed).toBeNull();
    expect(m.mavlink.messages_sent).toBeNull();
    expect(m.compatibility.vision.confidence).toBeNull();
    expect(m.compatibility.slam.posX).toBeNull();
    expect(m.states.fc).toBe(COMPANION_STATES.DISCONNECTED);
    expect(m.states.vision).toBe(COMPANION_STATES.WAITING_FOR_HARDWARE);
    expect(m.states.video).toBe(COMPANION_STATES.NOT_PRESENT);
  });

  it('does not treat empty vision object as confidence 0', () => {
    const m = mapCompanionStatus({ timestamp: { t_monotonic_ns: 1, t_utc_ns: null }, vision: {} });
    expect(m.vision.confidence).not.toBe(0);
    expect(m.vision.confidence).toBeNull();
  });

  it('maps STALE navigation/landing validity', () => {
    const m = mapCompanionStatus(staleCompanionStatus());
    expect(m.overall).toBe(COMPANION_STATES.STALE);
    expect(m.navigation.validity).toBe('stale');
    expect(m.landing.validity).toBe('stale');
    expect(m.landing.target).toBeNull();
    expect(m.vision.fps).toBeNull();
  });

  it('maps degraded health', () => {
    const m = mapCompanionStatus(degradedCompanionStatus());
    expect(m.overall).toBe(COMPANION_STATES.DEGRADED);
    expect(m.states.vision).toBe(COMPANION_STATES.DEGRADED);
    expect(m.vision.fps).toBeNull();
    expect(m.landing.target).toBeNull();
  });

  it('maps API-up FC-down snapshot without turning unknown zeros into live values', () => {
    const m = mapCompanionStatus({
      ...apiUpFcDownCompanionStatus(),
      visionResult: waitingVisionResult(),
      navigationEstimate: waitingNavEstimate(),
    });
    expect(m.connected).toBe(true);
    expect(m.states.system).toBe(COMPANION_STATES.OK);
    expect(m.system.cpu_percent).toBeNull();
    expect(m.system.gpu_percent).toBeNull();
    expect(m.states.fc).toBe(COMPANION_STATES.DISCONNECTED);
    expect(m.fc.connected).toBe(false);
    expect(m.fc.heartbeat_validity).toBe('invalid');
    expect(m.fc.armed).toBeNull();
    expect(m.states.mavlink).toBe(COMPANION_STATES.DISCONNECTED);
    expect(m.mavlink.connected).toBe(false);
    expect(m.mavlink.heartbeat_ok).toBe(false);
    expect(m.mavlink.messages_sent).toBe(0);
    expect(m.mavlink.messages_dropped).toBeNull();
    expect(m.mavlink.rx_drop_rate).toBeNull();
    expect(m.states.vision).toBe(COMPANION_STATES.WAITING_FOR_HARDWARE);
    expect(m.vision.running).toBe(false);
    expect(m.vision.health).toBe('unavailable');
    expect(m.vision.camera_ok).toBe(false);
    expect(m.vision.confidence).toBeNull();
    expect(m.vision.fps).toBeNull();
    expect(m.vision.frame_id).toBeNull();
    expect(m.states.landing).toBe(COMPANION_STATES.DISABLED);
    expect(m.landing.validity).toBe('invalid');
    expect(m.landing.confidence).toBeNull();
    expect(m.landing.target).toBeNull();
    expect(m.states.video).toBe(COMPANION_STATES.NOT_PRESENT);
    expect(m.video.raw_pipeline).toBe('stopped');
    expect(m.video.rawAvailable).toBe(false);
    expect(m.video.fps).toBeNull();
    expect(m.navigation.confidence).toBeNull();
    expect(m.navigation.posX).toBeNull();
  });
});
