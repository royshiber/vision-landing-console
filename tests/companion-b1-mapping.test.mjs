import { describe, expect, it } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { mapCompanionStatus, COMPANION_STATES } from '../lib/companion-status.mjs';

describe('companion B1 mapping', () => {
  it('dashboard system fields stay null when missing', async () => {
    const mock = createCompanionMock({ scenario: 'disconnected' });
    const mapped = mapCompanionStatus(await mock.getFullSnapshot());
    expect(mapped.system.gpu_percent).toBeNull();
    expect(mapped.vision.confidence).toBeNull();
  });

  it('FC status is observe-only', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const fc = await mock.getStatusFc();
    expect(fc.armed).toBe(false);
    expect(fc.heartbeat.validity).toBe('valid');
  });

  it('MAVLink status includes null drops', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const mav = await mock.getStatusMavlink();
    expect(mav.router_running).toBe(true);
    expect(mav.messages_dropped).toBeNull();
  });

  it('vision result keeps target geometry', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const result = await mock.getVisionResult();
    expect(result.landing_target.angle_x_rad).toBe(0.02);
    expect(result.landing_target.distance_m).toBe(12.4);
  });

  it('navigation estimate keeps frames and nulls', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const est = await mock.getNavigationEstimate();
    expect(est.position_frame).toBe('ned_local');
    const degraded = createCompanionMock({ scenario: 'degraded' });
    const bad = await degraded.getNavigationEstimate();
    expect(bad.position_m).toBeNull();
  });

  it('landing is display-only from Jetson payload', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const landing = await mock.getStatusLanding();
    expect(landing.validity).toBe('valid');
    expect(landing.target.marker_id).toBe(17);
  });

  it('channels describe the four links', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const ch = await mock.getStatusChannels();
    expect(ch.rc.jetson_in_path).toBe(false);
    expect(ch.rfd900x.jetson_in_path).toBe(false);
    expect(ch.gcs_tailscale.jetson_in_path).toBe(true);
    expect(ch.vision_loopback.bind).toBe('127.0.0.1:14540');
  });

  it('diagnostics are Jetson-authored', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const d = await mock.getDiagnostics();
    expect(d.subsystems.api).toBe('valid');
  });

  it('mock scenarios visibly change mapped state', async () => {
    const healthy = mapCompanionStatus(await createCompanionMock({ scenario: 'healthy' }).getFullSnapshot());
    const disconnected = mapCompanionStatus(await createCompanionMock({ scenario: 'disconnected' }).getFullSnapshot());
    const degraded = mapCompanionStatus(await createCompanionMock({ scenario: 'degraded' }).getFullSnapshot());
    expect(healthy.overall).toBe(COMPANION_STATES.OK);
    expect(disconnected.states.fc).toBe(COMPANION_STATES.DISCONNECTED);
    expect(disconnected.vision.confidence).toBeNull();
    expect(disconnected.landing.confidence).toBeNull();
    expect(degraded.overall).toBe(COMPANION_STATES.DEGRADED);
  });
});
