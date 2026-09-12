import { describe, it, expect } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { mapCompanionStatus } from '../lib/companion-status.mjs';
import {
  collectCompanionVisionSignals,
  probeCameraVision,
  probeRunwayDetect,
} from '../lib/vision-companion-probe.mjs';
import { buildVisionLandingReadiness } from '../lib/vision-landing-readiness.mjs';

const reachable = { jetson: 'reachable', fc: 'heartbeat', hasData: true, fc_heartbeat: true };

describe('Companion camera / runway probe honesty', () => {
  it('keeps a missing camera unknown and never invents ok', () => {
    const missing = probeCameraVision({
      companion: reachable,
      vision: null,
      video: null,
    });
    expect(missing.state).toBe('unknown');
    expect(missing.cameraOk).toBeNull();

    const healthOnly = probeCameraVision({
      companion: reachable,
      vision: { health: 'valid', running: true, fps: 30 },
    });
    expect(healthOnly.state).toBe('unknown');
    expect(healthOnly.cameraOk).toBeNull();

    const pipelineOnly = probeCameraVision({
      companion: reachable,
      video: { raw_pipeline: 'csi', raw_fps: 30 },
    });
    expect(pipelineOnly.state).toBe('unknown');
  });

  it('maps reported camera_ok without inventing GPS', () => {
    const ok = probeCameraVision({
      companion: reachable,
      vision: { camera_ok: true, running: true, health: 'valid', fps: 30, frame_id: 9 },
      video: { raw_pipeline: 'csi' },
    });
    expect(ok.state).toBe('ok');
    expect(ok.cameraOk).toBe(true);
    expect(ok.fieldsUsed).toContain('vision.camera_ok');

    const absent = probeCameraVision({
      companion: reachable,
      vision: { camera_ok: false, health: 'unavailable' },
    });
    expect(absent.state).toBe('absent');

    const extrasAbsent = probeCameraVision({
      companion: reachable,
      extras: { camera_connected: false },
    });
    expect(extrasAbsent.state).toBe('absent');
    expect(JSON.stringify(ok)).not.toMatch(/lat|lon|gps/i);
  });

  it('never invents runway detected from Aruco or an empty landing skeleton', () => {
    const aruco = probeRunwayDetect({
      companion: reachable,
      landing: {
        source: 'aruco',
        validity: 'valid',
        detected: true,
        target: { marker_id: 17 },
        detections: [{ label: 'aruco', detection_id: 17, confidence: 0.8 }],
      },
    });
    expect(aruco.state).toBe('not_implemented');
    expect(aruco.detected).toBeNull();
    expect(aruco.detector).toBe('landing_target');

    const skeleton = probeRunwayDetect({
      companion: reachable,
      landing: { detected: false, display_only: true, target: null, validity: null },
    });
    expect(skeleton.state).toBe('unknown');
    expect(skeleton.detected).toBeNull();

    const invented = probeRunwayDetect({
      companion: reachable,
      vision: { camera_ok: true, running: true },
    });
    expect(invented.state).not.toBe('detected');
  });

  it('maps honest runway fields: detected / not_detected / not_implemented / absent', () => {
    const detected = probeRunwayDetect({
      companion: reachable,
      landing: {
        source: 'runway',
        validity: 'valid',
        detections: [{ label: 'runway', detection_id: 1, confidence: 0.7 }],
      },
    });
    expect(detected.state).toBe('detected');
    expect(detected.detected).toBe(true);

    const flag = probeRunwayDetect({
      companion: reachable,
      extras: { runway_detected: false, runway_detector: true },
    });
    expect(flag.state).toBe('not_detected');

    const missingPath = probeRunwayDetect({
      companion: reachable,
      landingPathAbsent: true,
    });
    expect(missingPath.state).toBe('not_implemented');

    const absent = probeRunwayDetect({
      companion: reachable,
      extras: { runway_detector: false },
    });
    expect(absent.state).toBe('absent');
  });

  it('maps mock Companion payloads without treating Aruco as runway', async () => {
    const healthy = mapCompanionStatus(await createCompanionMock({ scenario: 'healthy' }).getFullSnapshot());
    const cam = probeCameraVision({
      companion: reachable,
      vision: healthy.vision,
      video: healthy.video,
    });
    expect(cam.state).toBe('ok');
    expect(healthy.vision.camera_ok).toBe(true);

    const runway = probeRunwayDetect({
      companion: reachable,
      vision: healthy.vision,
      landing: healthy.landing,
    });
    expect(healthy.landing.detected).toBe(true);
    expect(runway.state).toBe('not_implemented');
    expect(runway.detected).toBeNull();

    const down = mapCompanionStatus(await createCompanionMock({ scenario: 'disconnected' }).getFullSnapshot());
    expect(probeCameraVision({
      companion: reachable,
      vision: down.vision,
      video: down.video,
    }).state).toBe('absent');
    expect(probeRunwayDetect({
      companion: reachable,
      landing: down.landing,
    }).state).toBe('not_implemented');
  });

  it('fills missing overlay rows from Companion GET paths and marks a 404 landing path absent', async () => {
    const client = createCompanionMock({ scenario: 'healthy' });
    const filled = await collectCompanionVisionSignals({ overlay: {}, client });
    expect(filled.live.vision).toBe(true);
    expect(filled.vision.camera_ok).toBe(true);
    expect(filled.landing.source).toBe('aruco');

    const missingLanding = await collectCompanionVisionSignals({
      overlay: { vision: { camera_ok: true } },
      client: {
        getStatusLanding: async () => {
          const err = new Error('missing');
          err.status = 404;
          err.kind = 'http';
          throw err;
        },
      },
    });
    expect(missingLanding.landingPathAbsent).toBe(true);
    expect(probeRunwayDetect({
      companion: reachable,
      vision: missingLanding.vision,
      landingPathAbsent: missingLanding.landingPathAbsent,
    }).state).toBe('not_implemented');
  });
});

describe('Experiment #1 readiness from probed Companion fields', () => {
  function row(body, id) {
    return body.rows.find((r) => r.id === id);
  }

  it('can observe without annotations, lock, or PLND, and never requires detected already', () => {
    const body = buildVisionLandingReadiness({
      companion: reachable,
      overlay: {
        vision: { camera_ok: true, running: true, health: 'valid' },
        video: { raw_pipeline: 'csi' },
      },
    });
    expect(body.experimentSuccess).toBe(false);
    expect(body.experiment.annotationsRequired).toBe(false);
    expect(body.experiment.runwayLockRequired).toBe(false);
    expect(row(body, 'camera_vision').state).toBe('ok');
    expect(row(body, 'runway_detect').state).toBe('unknown');
    expect(row(body, 'annotated_video').requiredForExperiment1).toBe(false);
    expect(row(body, 'runway_lock').requiredForExperiment1).toBe(false);
    expect(row(body, 'plnd_profile').requiredForExperiment1).toBe(false);
  });

  it('does not treat a healthy Aruco landing-target as Experiment #1 success', () => {
    const body = buildVisionLandingReadiness({
      companion: reachable,
      overlay: {
        vision: { camera_ok: true, running: true, health: 'valid' },
        landing: {
          source: 'aruco',
          validity: 'valid',
          detected: true,
          detections: [{ label: 'aruco', detection_id: 17, confidence: 0.8 }],
        },
      },
    });
    expect(row(body, 'runway_detect').state).toBe('not_implemented');
    expect(body.experimentSuccess).toBe(false);
    expect(row(body, 'runway_detect').stateHe).toMatch(/אין גלאי/);
  });

  it('marks Experiment #1 success only from a runway detect signal', () => {
    const body = buildVisionLandingReadiness({
      companion: reachable,
      overlay: {
        vision: { camera_ok: true, running: true, health: 'valid' },
        landing: {
          source: 'runway',
          validity: 'valid',
          detections: [{ label: 'runway', detection_id: 3, confidence: 0.9 }],
        },
      },
    });
    expect(row(body, 'runway_detect').state).toBe('detected');
    expect(body.experimentSuccess).toBe(true);
    expect(body.experiment.observeOnly).toBe(true);
    expect(body.experiment.runwayLockRequired).toBe(false);
  });
});
