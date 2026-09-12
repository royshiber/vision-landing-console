import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, setConfig } from '../lib/db.mjs';
import { registerVisionLandingReadinessApi } from '../lib/routes/vision-landing-readiness-api.mjs';
import { resolveCompanionMode } from '../lib/companion-service.mjs';
import {
  VISION_LANDING_READINESS_IDS,
  FLIGHT_COMMANDS_GATE,
  FLIGHT_COMMAND_TOKENS,
  EXPERIMENT_PURPOSE_HE,
  EXPERIMENT_SUCCESS_HE,
  buildVisionLandingReadiness,
  buildPlndProfileHonesty,
  resolveCameraVisionState,
  resolveFcHeartbeatState,
  resolveJetsonCompanionState,
  resolvePlndProfileState,
  resolveRunwayDetectState,
  resolveRunwayLockState,
  resolveTelemetryRecordingState,
  resolveAnnotatedVideoHonesty,
  isGcsHeartbeatFresh,
  PLND_PROFILE_ALL_KEYS,
} from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'vision-landing-readiness-api.mjs'), 'utf8');
const coreSrc = fs.readFileSync(path.join(repoRoot, 'lib', 'vision-landing-readiness.mjs'), 'utf8');

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Vision Landing Readiness honesty matrix', () => {
  it('keeps Experiment 1 observe-only rows and never invents camera GPS or runway lock', () => {
    const empty = buildVisionLandingReadiness({});
    expect(empty.rows.map((r) => r.id)).toEqual([...VISION_LANDING_READINESS_IDS]);
    expect(empty.invented).toEqual({ camera: false, gps: false, runway: false, annotations: false, lock: false });
    expect(empty.rows.some((r) => /gps/i.test(r.id))).toBe(false);
    expect(empty.sendFlightCommands).toBe(false);
    expect(empty.experiment.observeOnly).toBe(true);
    expect(empty.experiment.picHandFlyFinal).toBe(true);
    expect(empty.experiment.control).toBe(false);
    expect(empty.experiment.success).toBe('runway_detect_on_final');
    expect(empty.experiment.annotationsRequired).toBe(false);
    expect(empty.experiment.runwayLockRequired).toBe(false);
    expect(empty.purposeHe).toBe(EXPERIMENT_PURPOSE_HE);
    expect(empty.successHe).toBe(EXPERIMENT_SUCCESS_HE);
    expect(empty.flightCommandsGate).toBe(FLIGHT_COMMANDS_GATE);
    expect(rowById(empty, 'camera_vision').state).toBe('unknown');
    expect(rowById(empty, 'camera_vision').stateHe).toBe('לא ידוע');
    expect(rowById(empty, 'runway_detect').state).toBe('unknown');
    expect(rowById(empty, 'runway_detect').successCriterion).toBe(true);
    expect(rowById(empty, 'runway_lock').state).toBe('unknown');
    expect(rowById(empty, 'runway_lock').stateHe).toBe('לא ידוע');
    expect(rowById(empty, 'runway_lock').requiredForExperiment1).toBe(false);
    expect(rowById(empty, 'runway_lock').stage).toBe('later');
    expect(rowById(empty, 'runway_lock').tone).not.toBe('bad');
    expect(empty.runwayLock).toEqual({ state: 'unknown', source: null });
    expect(rowById(empty, 'jetson_companion').state).toBe('off');
    expect(rowById(empty, 'fc_heartbeat').state).toBe('unknown');
    expect(rowById(empty, 'plnd_profile').state).toBe('unknown');
    expect(rowById(empty, 'plnd_profile').requiredForExperiment1).toBe(false);
    expect(rowById(empty, 'plnd_profile').keys).toHaveLength(PLND_PROFILE_ALL_KEYS.length);
    expect(rowById(empty, 'plnd_profile').keys.every((k) => k.state === 'unknown' && k.value == null)).toBe(true);
    expect(rowById(empty, 'annotated_video').state).toBe('later');
    expect(rowById(empty, 'annotated_video').stateHe).toBe('לא נדרש');
    expect(rowById(empty, 'annotated_video').requiredForExperiment1).toBe(false);
    expect(rowById(empty, 'annotated_video').reason).toBe('modem_absent');
    expect(rowById(empty, 'annotated_video').available).toBe(false);
    expect(empty.annotatedVideo.reason).toBe('modem_absent');
    expect(rowById(empty, 'telemetry_recording').state).toBe('not-recording');
    expect(rowById(empty, 'flight_commands_gate').state).toBe('closed');
  });

  it('maps Jetson from observed companion state only', () => {
    expect(resolveJetsonCompanionState({ jetson: 'reachable' })).toBe('reachable');
    expect(resolveJetsonCompanionState({ mode: 'real', reachable: false })).toBe('unreachable');
    expect(resolveJetsonCompanionState({ mode: 'mock' })).toBe('mock');
    expect(resolveJetsonCompanionState({ mode: 'off' })).toBe('off');
    const live = buildVisionLandingReadiness({
      companion: { jetson: 'reachable', mode: 'real', reachable: true },
    });
    expect(rowById(live, 'jetson_companion').stateHe).toBe('מגיע');
    expect(rowById(live, 'jetson_companion').missingHe).toBe('');
  });

  it('does not treat a URL-only companion as reachable', () => {
    expect(resolveCompanionMode({
      COMPANION_MODE: '',
      JETSON_COMPANION_BASE_URL: 'http://127.0.0.1:8081',
    })).toBe('off');
    expect(resolveCompanionMode({
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: '',
    })).toBe('off');
    const urlOnly = buildVisionLandingReadiness({
      companion: { mode: 'off', reachable: false, jetson: 'off' },
    });
    expect(rowById(urlOnly, 'jetson_companion').state).toBe('off');
    expect(rowById(urlOnly, 'jetson_companion').stateHe).not.toBe('מגיע');
  });

  it('reports FC heartbeat only from Companion UART or fresh GCS MAVLink', () => {
    expect(resolveFcHeartbeatState({})).toBe('unknown');
    expect(resolveFcHeartbeatState({ companionHeartbeat: true })).toBe('heartbeat');
    expect(resolveFcHeartbeatState({ gcsHeartbeatFresh: true })).toBe('heartbeat');
    expect(resolveFcHeartbeatState({ companionFc: 'linked' })).toBe('linked');
    expect(resolveFcHeartbeatState({ companionFc: 'unlinked' })).toBe('unlinked');
    expect(resolveFcHeartbeatState({ gcsHeartbeatFresh: false })).toBe('unlinked');
    expect(resolveFcHeartbeatState({ gcsHeartbeatFresh: null })).toBe('unknown');
    expect(isGcsHeartbeatFresh({ connected: true, lastHeartbeatAgeMs: 800 })).toBe(true);
    expect(isGcsHeartbeatFresh({ connected: true, lastHeartbeatAgeMs: 9000 })).toBe(false);
    expect(isGcsHeartbeatFresh({ connected: false, lastHeartbeatAgeMs: 100 })).toBe(false);
    const hb = buildVisionLandingReadiness({
      companion: { jetson: 'reachable', fc: 'heartbeat', fc_heartbeat: true },
    });
    expect(rowById(hb, 'fc_heartbeat').stateHe).toBe('דופק חי');
    expect(rowById(hb, 'fc_heartbeat').missingHe).toBe('');
  });

  it('keeps camera unknown unless a real Companion field is present', () => {
    expect(resolveCameraVisionState({})).toBe('unknown');
    expect(resolveCameraVisionState({ companionReachable: true })).toBe('unknown');
    expect(resolveCameraVisionState({ companionReachable: true, cameraOk: true })).toBe('ok');
    expect(resolveCameraVisionState({ companionReachable: true, cameraOk: false })).toBe('absent');
    expect(resolveCameraVisionState({ companionReachable: true, visionHealth: 'valid' })).toBe('unknown');
    expect(resolveCameraVisionState({ companionReachable: true, visionHealth: 'unavailable' })).toBe('unknown');
    expect(resolveCameraVisionState({ companionReachable: true, rawPipeline: 'csi' })).toBe('unknown');
    expect(resolveCameraVisionState({ companionReachable: true, rawPipeline: 'none' })).toBe('unknown');
    expect(resolveCameraVisionState({ companionReachable: false, cameraOk: true })).toBe('unknown');
    const invented = buildVisionLandingReadiness({
      companion: { jetson: 'off' },
      overlay: { vision: { camera_ok: true } },
    });
    expect(rowById(invented, 'camera_vision').state).toBe('unknown');
    expect(coreSrc).not.toMatch(/gpsFix|mockGps|sats/i);
  });

  it('treats runway detection on final as the only Experiment 1 success criterion', () => {
    expect(resolveRunwayDetectState({})).toBe('unknown');
    expect(resolveRunwayDetectState({ companionReachable: true })).toBe('unknown');
    expect(resolveRunwayDetectState({ companionReachable: true, landing: {} })).toBe('unknown');
    expect(resolveRunwayDetectState({
      companionReachable: false,
      landing: { detected: true },
    })).toBe('unknown');
    expect(resolveRunwayDetectState({
      companionReachable: true,
      landing: { detected: false },
    })).toBe('unknown');
    expect(resolveRunwayDetectState({
      companionReachable: true,
      landing: { detections: [{ label: 'runway' }] },
    })).toBe('detected');
    expect(resolveRunwayDetectState({
      companionReachable: true,
      landing: { detected: true, validity: 'valid' },
    })).toBe('not_implemented');
    expect(resolveRunwayDetectState({
      companionReachable: true,
      landing: { source: 'aruco', detected: true, validity: 'valid' },
    })).toBe('not_implemented');
    expect(resolveRunwayDetectState({
      companionReachable: true,
      landing: { lock_state: 'locked-confident' },
    })).toBe('unknown');
    const unknown = buildVisionLandingReadiness({
      companion: { jetson: 'off' },
      overlay: { landing: { detected: true } },
    });
    expect(rowById(unknown, 'runway_detect').state).toBe('unknown');
    const found = buildVisionLandingReadiness({
      companion: { jetson: 'reachable' },
      overlay: { landing: { source: 'runway', detections: [{ label: 'runway' }] } },
    });
    expect(rowById(found, 'runway_detect').state).toBe('detected');
    expect(rowById(found, 'runway_detect').stateHe).toBe('מזוהה');
    expect(rowById(found, 'runway_detect').successCriterion).toBe(true);
    expect(rowById(found, 'runway_lock').state).toBe('unknown');
    expect(rowById(found, 'runway_lock').requiredForExperiment1).toBe(false);
    expect(found.runwayLock).toEqual({ state: 'unknown', source: null });
    expect(found.experimentSuccess).toBe(true);
  });

  it('surfaces honest lock states without inventing locked or blocking Experiment 1', () => {
    expect(resolveRunwayLockState({})).toBe('unknown');
    expect(resolveRunwayLockState({ companionReachable: true })).toBe('unknown');
    expect(resolveRunwayLockState({ companionReachable: true, landing: {} })).toBe('unknown');
    expect(resolveRunwayLockState({
      companionReachable: false,
      landing: { lock_state: 'locked', detected: true, validity: 'valid', confidence: 0.9 },
    })).toBe('unknown');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { detected: false },
    })).toBe('unknown');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { detections: [{ label: 'runway' }], validity: 'degraded' },
    })).toBe('unknown');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { detected: true, validity: 'valid', confidence: 0.4 },
    })).toBe('unknown');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { detected: true, validity: 'valid', confidence: 0.8 },
    })).toBe('unknown');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { lock_state: 'locked-confident' },
    })).toBe('locked');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { lock: 'detecting' },
    })).toBe('detecting');
    expect(resolveRunwayLockState({
      companionReachable: true,
      landing: { locked: false },
    })).toBe('not');
    expect(resolveRunwayLockState({
      companionReachable: true,
      extras: { runway_lock: 'not' },
    })).toBe('not');
    const invented = buildVisionLandingReadiness({
      companion: { jetson: 'reachable' },
      overlay: { landing: { detected: true, validity: 'valid', confidence: 0.85 } },
    });
    expect(rowById(invented, 'runway_lock').state).toBe('unknown');
    expect(rowById(invented, 'runway_lock').stateHe).toBe('לא ידוע');
    expect(rowById(invented, 'runway_lock').requiredForExperiment1).toBe(false);
    expect(rowById(invented, 'runway_lock').tone).toBe('later');
    expect(rowById(invented, 'runway_detect').state).toBe('not_implemented');
    expect(invented.experimentSuccess).toBe(false);
    expect(invented.runwayLock).toEqual({ state: 'unknown', source: null });

    const locked = buildVisionLandingReadiness({
      companion: { jetson: 'reachable' },
      overlay: { landing: { source: 'runway', detections: [{ label: 'runway' }], lock_state: 'locked' } },
    });
    expect(rowById(locked, 'runway_detect').state).toBe('detected');
    expect(rowById(locked, 'runway_lock').state).toBe('locked');
    expect(rowById(locked, 'runway_lock').stateHe).toBe('נעול');
    expect(rowById(locked, 'runway_lock').requiredForExperiment1).toBe(false);
    expect(rowById(locked, 'runway_lock').source).toBe('landing.lock_state');
    expect(locked.experiment.success).toBe('runway_detect_on_final');
    expect(locked.experiment.runwayLockRequired).toBe(false);
    expect(locked.experimentSuccess).toBe(true);
    expect(locked.runwayLock).toEqual({ state: 'locked', source: 'landing.lock_state' });
  });

  it('treats a missing PLND profile as unknown until a real source is looked at', () => {
    expect(resolvePlndProfileState({})).toBe('unknown');
    expect(resolvePlndProfileState({ liveFcParams: { THR_MAX: 80 } })).toBe('missing');
    expect(resolvePlndProfileState({ liveFcParams: { PLND_ENABLED: 1 } })).toBe('present');
    expect(resolvePlndProfileState({ persistedArduTarget: { PLND_TYPE: 1 } })).toBe('present');
    expect(resolvePlndProfileState({ persistedVisionProfile: { vision_enable_alt_m: 40 } })).toBe('present');
    expect(resolvePlndProfileState({ companionParams: { vision_conf_min: 0.71 } })).toBe('present');
    const defaultsOnly = buildVisionLandingReadiness({
      liveFcParams: null,
      persistedArduTarget: null,
    });
    expect(rowById(defaultsOnly, 'plnd_profile').state).toBe('unknown');
    expect(rowById(defaultsOnly, 'plnd_profile').requiredForExperiment1).toBe(false);
    expect(rowById(defaultsOnly, 'plnd_profile').missingHe).toMatch(/לא חוסם את הניסוי/);
    expect(JSON.stringify(rowById(defaultsOnly, 'plnd_profile'))).not.toMatch(/55|0\.78|8\b/);
  });

  it('surfaces each PLND / vision-nav key as present, missing, or unknown without inventing values', () => {
    const empty = buildPlndProfileHonesty({});
    expect(empty.state).toBe('unknown');
    expect(empty.invented).toBe(false);
    expect(empty.keys.map((k) => k.key)).toEqual([...PLND_PROFILE_ALL_KEYS]);
    expect(empty.keys.every((k) => k.state === 'unknown' && k.value == null && k.source == null)).toBe(true);

    const looked = buildPlndProfileHonesty({ liveFcParams: { THR_MAX: 80 } });
    expect(looked.state).toBe('missing');
    expect(looked.keys.find((k) => k.key === 'PLND_ENABLED')).toMatchObject({ state: 'missing', value: null });
    expect(looked.keys.find((k) => k.key === 'flare_alt_m')).toMatchObject({ state: 'unknown', value: null });

    const live = buildVisionLandingReadiness({
      liveFcParams: { PLND_ENABLED: 1, PLND_TYPE: 2 },
    });
    const liveRow = rowById(live, 'plnd_profile');
    expect(liveRow.state).toBe('present');
    expect(liveRow.requiredForExperiment1).toBe(false);
    expect(liveRow.keys.find((k) => k.key === 'PLND_ENABLED')).toMatchObject({
      state: 'present',
      value: 1,
      source: 'fc',
      stateHe: 'קיים',
    });
    expect(liveRow.keys.find((k) => k.key === 'PLND_TYPE')).toMatchObject({ state: 'present', value: 2 });
    expect(liveRow.keys.find((k) => k.key === 'vision_enable_alt_m')).toMatchObject({ state: 'unknown', value: null });
    expect(liveRow.keys.find((k) => k.key === 'flare_alt_m').value).toBeNull();
    expect(JSON.stringify(liveRow)).not.toMatch(/55|0\.78/);

    const companion = buildVisionLandingReadiness({
      companionParams: { vision_enable_alt_m: 42, vision_conf_min: 0.71 },
    });
    const companionRow = rowById(companion, 'plnd_profile');
    expect(companionRow.state).toBe('present');
    expect(companionRow.keys.find((k) => k.key === 'vision_enable_alt_m')).toMatchObject({
      state: 'present',
      value: 42,
      source: 'companion',
    });
    expect(companionRow.keys.find((k) => k.key === 'flare_alt_m')).toMatchObject({ state: 'missing', value: null });
    expect(companionRow.keys.find((k) => k.key === 'PLND_ENABLED')).toMatchObject({ state: 'unknown', value: null });
  });

  it('does not require annotations for Experiment 1 even when a video path exists', () => {
    const absent = buildVisionLandingReadiness({
      video: { available: false, path: 'cellular', reason: 'modem_absent' },
      cellular: 'modem_absent',
      modemPresent: false,
    });
    expect(rowById(absent, 'annotated_video').state).toBe('later');
    expect(rowById(absent, 'annotated_video').stateHe).toBe('לא נדרש');
    expect(rowById(absent, 'annotated_video').requiredForExperiment1).toBe(false);
    expect(rowById(absent, 'annotated_video').tone).toBe('later');
    expect(rowById(absent, 'annotated_video').path).toBe('cellular');
    expect(rowById(absent, 'annotated_video').reason).toBe('modem_absent');
    expect(rowById(absent, 'annotated_video').available).toBe(false);
    expect(rowById(absent, 'annotated_video').missingHe).toMatch(/מודם סלולר לא מחובר/);
    expect(absent.annotatedVideo).toMatchObject({
      available: false,
      path: 'cellular',
      reason: 'modem_absent',
    });
    const invented = buildVisionLandingReadiness({
      video: { available: true, path: 'cellular', reason: 'cellular_connected' },
      cellular: 'connected',
      modemPresent: false,
    });
    expect(rowById(invented, 'annotated_video').available).toBe(false);
    expect(rowById(invented, 'annotated_video').reason).toBe('modem_absent');
    const live = buildVisionLandingReadiness({
      video: { available: true, path: 'cellular', reason: 'cellular_connected' },
      cellular: 'connected',
      modemPresent: true,
    });
    expect(rowById(live, 'annotated_video').state).toBe('later');
    expect(rowById(live, 'annotated_video').stateHe).toBe('לא נדרש');
    expect(rowById(live, 'annotated_video').requiredForExperiment1).toBe(false);
    expect(rowById(live, 'annotated_video').available).toBe(false);
    expect(rowById(live, 'annotated_video').reason).toBe('stream_absent');
    expect(rowById(live, 'annotated_video').radioSatisfies).toBe(false);
    const streamed = buildVisionLandingReadiness({
      video: { streamPresent: true, path: 'cellular' },
      cellular: 'connected',
      modemPresent: true,
    });
    expect(rowById(streamed, 'annotated_video').reason).toBe('cellular_connected');
    expect(rowById(streamed, 'annotated_video').available).toBe(true);
    expect(resolveAnnotatedVideoHonesty({ modemPresent: false }).reason).toBe('modem_absent');
  });

  it('defaults telemetry recording to not-recording unless a manual record API reports it', () => {
    expect(resolveTelemetryRecordingState({})).toBe('not-recording');
    expect(resolveTelemetryRecordingState({ manualRecordApi: { recording: true } })).toBe('recording');
    expect(resolveTelemetryRecordingState({ manualRecordApi: { recording: false } })).toBe('not-recording');
    const idle = buildVisionLandingReadiness({ archiveHasSession: true });
    expect(rowById(idle, 'telemetry_recording').state).toBe('not-recording');
    const armed = buildVisionLandingReadiness({ manualRecordApi: { recording: true } });
    expect(rowById(armed, 'telemetry_recording').state).toBe('recording');
    expect(rowById(armed, 'telemetry_recording').stateHe).toBe('מקליט');
  });

  it('keeps the flight-commands gate closed and does not implement send', () => {
    const snap = buildVisionLandingReadiness({
      companion: { jetson: 'reachable', fc: 'heartbeat', fc_heartbeat: true },
    });
    const gate = rowById(snap, 'flight_commands_gate');
    expect(gate.state).toBe('closed');
    expect(gate.stateHe).toBe('סגור');
    expect(gate.send).toBe(false);
    expect(gate.tokens).toEqual([...FLIGHT_COMMAND_TOKENS]);
    expect(gate.issue).toBe(29);
    expect(gate.observeOnly).toBe(true);
    expect(gate.missingHe).toMatch(/טייס מפקד מטיס ידנית עד הגמר/);
    expect(coreSrc).not.toMatch(/COMMAND_LONG|MAV_CMD_NAV_LAND|DO_SEND|flight-action-send/i);
    expect(apiSrc).not.toMatch(/COMMAND_LONG|MAV_CMD_COMPONENT_ARM|app\.post\('\/api\/flight/);
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });
});

describe('GET /api/vision/landing-readiness', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-vlr-${Date.now()}.sqlite`);
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  beforeAll(async () => {
    db = openDatabase(tmpPath);
    const app = express();
    app.use(express.json());
    registerVisionLandingReadinessApi(app, {
      db,
      env: {},
      companionService: {
        mode: 'off',
        getSseOverlay() {
          return { companion: { mode: 'off', reachable: false } };
        },
      },
    });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* ignore */ }
  });

  it('returns the honesty matrix without inventing camera or GPS', async () => {
    const r = await fetch(`${base}/api/vision/landing-readiness`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.rows).toHaveLength(9);
    expect(j.invented).toEqual({ camera: false, gps: false, runway: false, annotations: false, lock: false });
    expect(j.sendFlightCommands).toBe(false);
    expect(j.flightCommandsGate).toBe('closed');
    expect(j.purposeHe).toMatch(/טייס מפקד מטיס ידנית עד הגמר/);
    expect(j.successHe).toMatch(/זיהוי מסלול בגישת הגמר בלבד/);
    expect(j.experiment.success).toBe('runway_detect_on_final');
    expect(rowById(j, 'runway_detect').state).toBe('unknown');
    expect(rowById(j, 'runway_lock').state).toBe('unknown');
    expect(rowById(j, 'runway_lock').requiredForExperiment1).toBe(false);
    expect(j.runwayLock).toEqual({ state: 'unknown', source: null });
    expect(rowById(j, 'camera_vision').state).toBe('unknown');
    expect(rowById(j, 'plnd_profile').state).toBe('unknown');
    expect(rowById(j, 'plnd_profile').requiredForExperiment1).toBe(false);
    expect(rowById(j, 'plnd_profile').keys.every((k) => k.value == null)).toBe(true);
    expect(rowById(j, 'annotated_video').state).toBe('later');
    expect(rowById(j, 'annotated_video').reason).toBe('modem_absent');
    expect(j.annotatedVideo.reason).toBe('modem_absent');
    expect(j.annotatedVideo.available).toBe(false);
    expect(rowById(j, 'telemetry_recording').state).toBe('not-recording');
    expect(rowById(j, 'flight_commands_gate').tokens).toEqual(['ARM', 'LAND', 'auto-land']);
  });

  it('marks a persisted PLND profile present without claiming a live camera', async () => {
    setConfig(db, 'arduTargetParams', { PLND_ENABLED: 1, PLND_TYPE: 1 });
    const r = await fetch(`${base}/api/vision/landing-readiness`);
    const j = await r.json();
    expect(rowById(j, 'plnd_profile').state).toBe('present');
    expect(rowById(j, 'plnd_profile').requiredForExperiment1).toBe(false);
    expect(rowById(j, 'plnd_profile').keys.find((k) => k.key === 'PLND_ENABLED')).toMatchObject({
      state: 'present',
      value: 1,
      source: 'persisted',
    });
    expect(rowById(j, 'camera_vision').state).toBe('unknown');
  });
});

describe('Vision Landing Readiness UI', () => {
  it('pins APP_VERSION at 1.02.307', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.307'");
    expect(pkg.version).toBe('1.02.307');
  });

  it('places the Hebrew chip panel on Status and opens the same rows from Mission', () => {
    expect(html).toContain('id="visionLandingReadiness"');
    expect(html).toContain('id="visionLandingReadinessList"');
    expect(html).toMatch(/class="vlr-title">מוכנות נחיתה לפי ראייה</);
    expect(html).toContain('טייס מפקד מטיס ידנית עד הגמר');
    expect(html).toContain('המערכת צופה בלבד');
    expect(html).toContain('הצלחה היא זיהוי מסלול בגישת הגמר בלבד');
    expect(html).toContain('סימון ונעילה אינם נדרשים');
    expect(html).not.toContain('id="missionRunwayGlance"');
    expect(html).not.toContain('id="missionRunwayLockGlance"');
    expect(js).not.toMatch(/missionRunwayGlance/);
    expect(js).not.toMatch(/missionRunwayLockGlance/);
    expect(js).not.toMatch(/RUNWAY_GLANCE_HE/);
    expect(js).not.toMatch(/RUNWAY_LOCK_GLANCE_HE/);
    expect(js).not.toMatch(/זיהוי מסלול לצפייה\. אין נעילה/);
    expect(html).toMatch(/id="pfdReadinessStatusBtn"[^>]*>מוכנות בסטטוס</);
    expect(html.indexOf('id="visionLandingReadiness"')).toBeGreaterThan(html.indexOf('data-computer="fc"'));
    expect(html.indexOf('id="visionLandingReadiness"')).toBeLessThan(html.indexOf('pulse-talk-card'));
    expect(css).toMatch(/\.vlr-chip\b/);
    expect(css).toMatch(/\.vlr-row\[data-tone="ok"\]/);
    expect(js).toContain('function renderVisionLandingReadiness');
    expect(js).toContain('function refreshVisionLandingReadiness');
    expect(js).toContain("fetch('/api/vision/landing-readiness'");
    expect(js).toContain('snapshot.purposeHe');
    expect(js).toContain('snapshot.successHe');
    expect(js).toContain('dataset.stage');
    expect(js).toContain('function openStatusReadiness');
    expect(js).toMatch(/applyMainTab\('pulse'\)/);
    expect(js).toContain('pfdReadinessStatusBtn');
    expect(html).toContain('id="plndProfileHonesty"');
    expect(html).toContain('ערכים רק מקריאה אמיתית. אין המצאה. לא חוסם את ניסוי אחד.');
    expect(html).toContain('id="plndProfileHonestyKeys"');
    expect(css).toMatch(/\.plnd-honesty-key\b/);
    expect(js).toContain('function paintPlndProfileHonesty');
    expect(js).toContain('function openPlndProfileParams');
    expect(js).toContain("applyControlSubtab('visionNavParams')");
    expect(js).toContain('פתח בפרמטרים');
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });
});
