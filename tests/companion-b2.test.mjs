import { describe, expect, it } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { createCompanionService } from '../lib/companion-service.mjs';
import { mapCompanionStatus, COMPANION_STATES } from '../lib/companion-status.mjs';
import {
  CONFIG_TIER,
  flattenCompanionConfig,
  mapFcMessageCategories,
  mapPolicyPreview,
  policyTokenState,
  videoPipelineUiState,
} from '../lib/companion-display.mjs';
import { healthyCompanionConfig } from '../lib/companion-mock-fixtures.mjs';

describe('companion B2 foundation', () => {
  it('dashboard healthy: FC/MAVLink/vision/landing/video live without fake zeros', async () => {
    const mapped = mapCompanionStatus(await createCompanionMock({ scenario: 'healthy' }).getFullSnapshot());
    expect(mapped.states.fc).toBe(COMPANION_STATES.OK);
    expect(mapped.states.mavlink).toBe(COMPANION_STATES.OK);
    expect(mapped.states.vision).toBe(COMPANION_STATES.OK);
    expect(mapped.landing.detected).toBe(true);
    expect(mapped.landing.display_only).toBe(true);
    expect(mapped.video.raw_ui).toBe('available');
    expect(mapped.system.cpu_percent).toBe(41.2);
    expect(mapped.vision.confidence).toBe(0.82);
    expect(mapped.fc.message_categories.GPS.validity).toBe('invalid');
    expect(mapped.navigation.ekf_injected).toBe(false);
    expect(mapped.navigation.label).toContain('Companion');
  });

  it('dashboard disconnected: unavailable hardware stays null not zero', async () => {
    const mapped = mapCompanionStatus(await createCompanionMock({ scenario: 'disconnected' }).getFullSnapshot());
    expect(mapped.states.fc).toBe(COMPANION_STATES.DISCONNECTED);
    expect(mapped.states.mavlink).toBe(COMPANION_STATES.DISCONNECTED);
    expect(mapped.vision.confidence).toBeNull();
    expect(mapped.vision.fps).toBeNull();
    expect(mapped.landing.detected).toBe(false);
    expect(mapped.landing.confidence).toBeNull();
    expect(mapped.video.raw_ui).toBe('unavailable');
    expect(mapped.system.gpu_percent).toBeNull();
    expect(mapped.navigation.posX).toBeNull();
  });

  it('dashboard degraded: stale MAVLink, weak vision, missing target', async () => {
    const mapped = mapCompanionStatus(await createCompanionMock({ scenario: 'degraded' }).getFullSnapshot());
    expect(mapped.overall).toBe(COMPANION_STATES.DEGRADED);
    expect(mapped.states.mavlink).toBe(COMPANION_STATES.STALE);
    expect(mapped.states.vision).toBe(COMPANION_STATES.DEGRADED);
    expect(mapped.landing.target).toBeNull();
    expect(mapped.vision.fps).toBeNull();
    expect(mapped.video.raw_ui).toBe('degraded');
  });

  it('maps FC sysid and display-only message categories', async () => {
    const fc = await createCompanionMock({ scenario: 'healthy' }).getStatusFc();
    const cats = mapFcMessageCategories(fc);
    expect(fc.heartbeat.system_id).toBe(1);
    expect(cats.HEARTBEAT.validity).toBe('valid');
    expect(cats.PARAMETERS.present).toBe(false);
    expect(cats.VISION.state).toBe('DISABLED');
  });

  it('channels keep Jetson-in-path and do not invent listen state', async () => {
    const ch = await createCompanionMock({ scenario: 'healthy' }).getStatusChannels();
    expect(ch.rc.jetson_in_path).toBe(false);
    expect(ch.rfd900x.jetson_in_path).toBe(false);
    expect(ch.gcs_tailscale.jetson_in_path).toBe(true);
    expect(ch.vision_loopback.bind).toBe('127.0.0.1:14540');
    const down = await createCompanionMock({ scenario: 'disconnected' }).getStatusChannels();
    expect(down.rc.listening).toBeNull();
  });

  it('vision detections and landing stay display-only', async () => {
    const mapped = mapCompanionStatus(await createCompanionMock({ scenario: 'healthy' }).getFullSnapshot());
    expect(mapped.vision.detections[0].bbox_px).toEqual([120, 80, 220, 180]);
    expect(mapped.landing.range_m).toBe(12.4);
    expect(mapped.landing.display_only).toBe(true);
    const missing = mapCompanionStatus(await createCompanionMock({ scenario: 'disconnected' }).getFullSnapshot());
    expect(missing.landing.confidence).not.toBe(0);
    expect(missing.landing.confidence).toBeNull();
  });

  it('navigation estimate is labeled and not EKF-injected', async () => {
    const mapped = mapCompanionStatus(await createCompanionMock({ scenario: 'healthy' }).getFullSnapshot());
    expect(mapped.navigation.position_m).toEqual([1.2, -0.4, 8.1]);
    expect(mapped.navigation.ekf_injected).toBe(false);
  });

  it('video pipeline states include stopped and unavailable', () => {
    expect(videoPipelineUiState('csi')).toBe('available');
    expect(videoPipelineUiState('stopped')).toBe('stopped');
    expect(videoPipelineUiState('none')).toBe('unavailable');
    expect(videoPipelineUiState('csi', { degraded: true })).toBe('degraded');
    expect(videoPipelineUiState(null)).toBe('unavailable');
  });

  it('config rows expose tiers and are not editable in B2', () => {
    const rows = flattenCompanionConfig(healthyCompanionConfig());
    expect(rows.some((r) => r.tier === CONFIG_TIER.FLIGHT_CRITICAL && r.editable === false)).toBe(true);
    expect(rows.some((r) => r.tier === CONFIG_TIER.RUNTIME && r.key.includes('log_level'))).toBe(true);
    expect(rows.every((r) => r.editable === false)).toBe(true);
  });

  it('policy preview is read-only and does not invent unspecified tokens as allowed', async () => {
    const policy = await createCompanionMock({ scenario: 'healthy' }).getPolicy();
    expect(policyTokenState(policy.channels.gcs_4g, 'VISION')).toBe('denied');
    expect(policyTokenState(policy.channels.gcs_4g, 'HEARTBEAT')).toBe('allowed');
    const mapped = mapPolicyPreview(policy);
    expect(mapped.applySupported).toBe(false);
    const preview = await createCompanionMock().getPolicyPreview();
    expect(preview.applySupported).toBe(false);
    expect(preview.writes_etc).toBe(false);
  });

  it('diagnostics cover B2 subsystems', async () => {
    const d = await createCompanionMock({ scenario: 'healthy' }).getDiagnostics();
    expect(d.subsystems.fc).toBe('valid');
    expect(d.subsystems.network).toBe('valid');
    expect(d.subsystems.policy).toBe('valid');
    const down = mapCompanionStatus(await createCompanionMock({ scenario: 'disconnected' }).getFullSnapshot());
    expect(down.diagnostics.subsystems.vision).toBe('unavailable');
  });

  it('stale landing hides target and mock mode can switch scenarios', async () => {
    const svc = createCompanionService({ COMPANION_MODE: 'mock' });
    expect(svc.mode).toBe('mock');
    await svc.setMockScenario('disconnected');
    expect(svc.client.scenario).toBe('disconnected');
    const mapped = mapCompanionStatus(await svc.client.getFullSnapshot());
    expect(mapped.states.fc).toBe(COMPANION_STATES.DISCONNECTED);
  });

  it('real mode unavailable overlay does not synthesize zeros', () => {
    const mapped = mapCompanionStatus(null);
    expect(mapped.vision.confidence).toBeNull();
    expect(mapped.system.cpu_percent).toBeNull();
    expect(mapped.landing.confidence).toBeNull();
  });
});
