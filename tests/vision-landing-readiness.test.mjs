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
  buildVisionLandingReadiness,
  resolveCameraVisionState,
  resolveFcHeartbeatState,
  resolveJetsonCompanionState,
  resolvePlndProfileState,
  resolveTelemetryRecordingState,
  isGcsHeartbeatFresh,
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
  it('keeps seven honest ids and never invents camera or GPS', () => {
    const empty = buildVisionLandingReadiness({});
    expect(empty.rows.map((r) => r.id)).toEqual([...VISION_LANDING_READINESS_IDS]);
    expect(empty.invented).toEqual({ camera: false, gps: false });
    expect(empty.rows.some((r) => /gps/i.test(r.id))).toBe(false);
    expect(empty.sendFlightCommands).toBe(false);
    expect(empty.flightCommandsGate).toBe(FLIGHT_COMMANDS_GATE);
    expect(rowById(empty, 'camera_vision').state).toBe('unknown');
    expect(rowById(empty, 'camera_vision').stateHe).toBe('לא ידוע');
    expect(rowById(empty, 'jetson_companion').state).toBe('off');
    expect(rowById(empty, 'fc_heartbeat').state).toBe('unknown');
    expect(rowById(empty, 'plnd_profile').state).toBe('missing');
    expect(rowById(empty, 'annotated_video').state).toBe('modem_absent');
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
    expect(resolveCameraVisionState({ companionReachable: true, visionHealth: 'valid' })).toBe('ok');
    expect(resolveCameraVisionState({ companionReachable: true, visionHealth: 'unavailable' })).toBe('absent');
    expect(resolveCameraVisionState({ companionReachable: true, rawPipeline: 'csi' })).toBe('ok');
    expect(resolveCameraVisionState({ companionReachable: true, rawPipeline: 'none' })).toBe('absent');
    expect(resolveCameraVisionState({ companionReachable: false, cameraOk: true })).toBe('unknown');
    const invented = buildVisionLandingReadiness({
      companion: { jetson: 'off' },
      overlay: { vision: { camera_ok: true } },
    });
    expect(rowById(invented, 'camera_vision').state).toBe('unknown');
    expect(coreSrc).not.toMatch(/gpsFix|mockGps|sats/i);
  });

  it('treats PLND as present only from a live READ or a persisted store', () => {
    expect(resolvePlndProfileState({})).toBe('missing');
    expect(resolvePlndProfileState({ liveFcParams: { THR_MAX: 80 } })).toBe('missing');
    expect(resolvePlndProfileState({ liveFcParams: { PLND_ENABLED: 1 } })).toBe('present');
    expect(resolvePlndProfileState({ persistedArduTarget: { PLND_TYPE: 1 } })).toBe('present');
    expect(resolvePlndProfileState({ persistedVisionProfile: { vision_enable_alt_m: 40 } })).toBe('present');
    const defaultsOnly = buildVisionLandingReadiness({
      liveFcParams: null,
      persistedArduTarget: null,
    });
    expect(rowById(defaultsOnly, 'plnd_profile').state).toBe('missing');
    expect(rowById(defaultsOnly, 'plnd_profile').missingHe).toBe('אין פרופיל נחיתה לפי ראייה');
  });

  it('allows modem_absent on the cellular annotated-video path and never uses radio', () => {
    const absent = buildVisionLandingReadiness({
      video: { available: false, path: 'cellular', reason: 'modem_absent' },
    });
    expect(rowById(absent, 'annotated_video').state).toBe('modem_absent');
    expect(rowById(absent, 'annotated_video').stateHe).toBe('מודם חסר');
    expect(rowById(absent, 'annotated_video').path).toBe('cellular');
    const live = buildVisionLandingReadiness({
      video: { available: true, path: 'cellular', reason: 'cellular_connected' },
    });
    expect(rowById(live, 'annotated_video').state).toBe('available');
    expect(rowById(live, 'annotated_video').stateHe).toBe('זמין');
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
    expect(gate.missingHe).toMatch(/שער אנושי/);
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
    expect(j.rows).toHaveLength(7);
    expect(j.invented).toEqual({ camera: false, gps: false });
    expect(j.sendFlightCommands).toBe(false);
    expect(j.flightCommandsGate).toBe('closed');
    expect(rowById(j, 'camera_vision').state).toBe('unknown');
    expect(rowById(j, 'annotated_video').state).toBe('modem_absent');
    expect(rowById(j, 'telemetry_recording').state).toBe('not-recording');
    expect(rowById(j, 'flight_commands_gate').tokens).toEqual(['ARM', 'LAND', 'auto-land']);
  });

  it('marks a persisted PLND profile present without claiming a live camera', async () => {
    setConfig(db, 'arduTargetParams', { PLND_ENABLED: 1, PLND_TYPE: 1 });
    const r = await fetch(`${base}/api/vision/landing-readiness`);
    const j = await r.json();
    expect(rowById(j, 'plnd_profile').state).toBe('present');
    expect(rowById(j, 'camera_vision').state).toBe('unknown');
  });
});

describe('Vision Landing Readiness UI', () => {
  it('pins APP_VERSION at 1.02.281', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.281'");
    expect(pkg.version).toBe('1.02.281');
  });

  it('places the Hebrew chip panel on Status and opens the same rows from Mission', () => {
    expect(html).toContain('id="visionLandingReadiness"');
    expect(html).toContain('id="visionLandingReadinessList"');
    expect(html).toMatch(/class="vlr-title">מוכנות נחיתה לפי ראייה</);
    expect(html).toMatch(/id="pfdReadinessStatusBtn"[^>]*>מוכנות בסטטוס</);
    expect(html.indexOf('id="visionLandingReadiness"')).toBeGreaterThan(html.indexOf('data-computer="fc"'));
    expect(html.indexOf('id="visionLandingReadiness"')).toBeLessThan(html.indexOf('pulse-talk-card'));
    expect(css).toMatch(/\.vlr-chip\b/);
    expect(css).toMatch(/\.vlr-row\[data-tone="ok"\]/);
    expect(js).toContain('function renderVisionLandingReadiness');
    expect(js).toContain('function refreshVisionLandingReadiness');
    expect(js).toContain("fetch('/api/vision/landing-readiness'");
    expect(js).toContain('function openStatusReadiness');
    expect(js).toMatch(/applyMainTab\('pulse'\)/);
    expect(js).toContain('pfdReadinessStatusBtn');
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });
});
