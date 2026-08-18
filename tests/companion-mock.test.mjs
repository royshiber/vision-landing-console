import { describe, expect, it } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { mapCompanionStatus, COMPANION_STATES } from '../lib/companion-status.mjs';
import { COMPANION_READ_METHODS, COMPANION_WRITE_METHODS } from '../lib/companion-v1-paths.mjs';
import { createCompanionApiClient } from '../lib/companion-api-client.mjs';

describe('companion mock', () => {
  it('implements the same method names as the real client', () => {
    const mock = createCompanionMock();
    const real = createCompanionApiClient({ baseUrl: 'http://example.invalid' });
    for (const name of [...COMPANION_READ_METHODS, ...COMPANION_WRITE_METHODS]) {
      expect(typeof mock[name]).toBe('function');
      expect(typeof real[name]).toBe('function');
    }
  });

  it('healthy: Jetson/FC/MAVLink/vision/video OK', async () => {
    const mock = createCompanionMock({ scenario: 'healthy' });
    const mapped = mapCompanionStatus(await mock.getFullSnapshot());
    expect(mapped.states.system).toBe(COMPANION_STATES.OK);
    expect(mapped.states.fc).toBe(COMPANION_STATES.OK);
    expect(mapped.states.mavlink).toBe(COMPANION_STATES.OK);
    expect(mapped.states.vision).toBe(COMPANION_STATES.OK);
    expect(mapped.states.video).toBe(COMPANION_STATES.OK);
    expect(mapped.vision.confidence).toBeGreaterThan(0.5);
  });

  it('disconnected: FC down, camera absent, vision waiting, video unavailable', async () => {
    const mock = createCompanionMock({ scenario: 'disconnected' });
    const mapped = mapCompanionStatus(await mock.getFullSnapshot());
    expect(mapped.states.fc).toBe(COMPANION_STATES.DISCONNECTED);
    expect(mapped.states.vision).toBe(COMPANION_STATES.WAITING_FOR_HARDWARE);
    expect(mapped.states.video).toBe(COMPANION_STATES.NOT_PRESENT);
    expect(mapped.vision.confidence).toBeNull();
    expect(mapped.video.fps).toBeNull();
  });

  it('degraded: stale MAVLink, degraded vision, degraded network', async () => {
    const mock = createCompanionMock({ scenario: 'degraded' });
    const mapped = mapCompanionStatus(await mock.getFullSnapshot());
    expect(mapped.states.mavlink).toBe(COMPANION_STATES.STALE);
    expect(mapped.states.vision).toBe(COMPANION_STATES.DEGRADED);
    expect(mapped.states.channels).toBe(COMPANION_STATES.DEGRADED);
    expect(mapped.overall).toBe(COMPANION_STATES.DEGRADED);
  });

  it('policy preview does not claim apply support', async () => {
    const mock = createCompanionMock();
    const preview = await mock.getPolicyPreview();
    expect(preview.applySupported).toBe(false);
  });
});
