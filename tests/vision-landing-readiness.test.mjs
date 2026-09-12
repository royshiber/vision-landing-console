import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';
import {
  buildVisionLandingReadiness,
  cameraReadiness,
  recordingReadiness,
  flightCommandReadiness,
  MANUAL_RECORD_API_PRESENT,
  VISION_LANDING_QUESTION_HE,
  VISION_LANDING_SCOPE_HE,
} from '../lib/vision-landing-readiness.mjs';
import { registerVisionLandingReadinessApi } from '../lib/routes/vision-landing-readiness-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const engine = fs.readFileSync(path.join(repoRoot, 'lib', 'vision-landing-readiness.mjs'), 'utf8');
const api = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'vision-landing-readiness-api.mjs'), 'utf8');
const httpRegister = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'http-register.mjs'), 'utf8');
const coreApi = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'core-api.mjs'), 'utf8');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const emptyInput = {
  companion: { jetson: 'off', fc: 'unknown', hasData: false },
  vision: null,
  dual: { cellular: 'modem_absent', modemPresent: false, video: { available: false, reason: 'modem_absent' } },
  mavlink: { connected: false, heartbeatCount: 0 },
  arduTarget: {},
  arduCurrent: null,
  visionProfile: {},
  recording: { apiPresent: false, armed: false },
};

describe('Vision Landing Readiness honesty', () => {
  it('never invents a live camera from a missing snapshot', () => {
    const unknown = cameraReadiness({
      companion: { jetson: 'reachable', hasData: true },
      vision: null,
    });
    expect(unknown.state).toBe('unknown');
    expect(unknown.chip).toBe('warn');
    expect(unknown.chip).not.toBe('on');

    const absent = cameraReadiness({
      companion: { jetson: 'reachable', hasData: true },
      vision: { camera_ok: false },
    });
    expect(absent.state).toBe('absent');
    expect(absent.chip).toBe('off');

    const ok = cameraReadiness({
      companion: { jetson: 'reachable', hasData: true },
      vision: { camera_ok: true, running: true, health: 'ok' },
    });
    expect(ok.state).toBe('ok');
    expect(ok.chip).toBe('on');

    const invented = buildVisionLandingReadiness(emptyInput);
    const cam = invented.items.find((r) => r.id === 'camera');
    expect(cam.state).toBe('unknown');
    expect(cam.chip).not.toBe('on');
  });

  it('treats modem_absent annotations as a follow-on, not an Experiment #1 blocker', () => {
    const body = buildVisionLandingReadiness(emptyInput);
    const video = body.items.find((r) => r.id === 'video');
    expect(video.state).toBe('modem_absent');
    expect(video.blocker).toBe(false);
    expect(video.role).toBe('followOn');
    expect(video.missingHe).toMatch(/מודם/);
    expect(video.missingHe).toMatch(/לא חוסם את ניסוי אחד/);
  });

  it('defaults recording to not-recording when no manual-record API exists', () => {
    expect(MANUAL_RECORD_API_PRESENT).toBe(false);
    const none = recordingReadiness({ recording: { apiPresent: false } });
    expect(none.id).toBe('lock');
    expect(none.state).toBe('not_recording');
    expect(none.armed).toBe(false);
    expect(none.blocker).toBe(false);
    expect(none.missingHe).toMatch(/לא חוסם את ניסוי אחד/);
    const armed = recordingReadiness({ recording: { apiPresent: true, armed: true } });
    expect(armed.state).toBe('armed');
    expect(armed.chip).toBe('on');
    expect(armed.blocker).toBe(false);
  });

  it('keeps flight commands gated and never ready to send', () => {
    const gate = flightCommandReadiness();
    expect(gate.enabled).toBe(false);
    expect(gate.sendsArm).toBe(false);
    expect(gate.sendsLand).toBe(false);
    expect(gate.sendsAutoLand).toBe(false);
    expect(gate.state).toBe('gated');
    const readySensors = buildVisionLandingReadiness({
      companion: { jetson: 'reachable', fc: 'heartbeat', hasData: true, fc_heartbeat: true },
      vision: { camera_ok: true, running: true, health: 'ok' },
      dual: { cellular: 'connected', modemPresent: true, video: { available: true } },
      mavlink: { connected: true, heartbeatCount: 12, lastHeartbeatAgeMs: 200 },
      arduTarget: { PLND_ENABLED: 1, PLND_TYPE: 1 },
      arduCurrent: { PLND_ENABLED: 1, PLND_TYPE: 1 },
      visionProfile: { vision_enable_alt_m: 40, vision_conf_min: 0.6 },
      recording: { apiPresent: false, armed: false },
    });
    expect(readySensors.sensorsReady).toBe(true);
    expect(readySensors.experimentReady).toBe(true);
    expect(readySensors.picHandFly).toBe(true);
    expect(readySensors.observeOnly).toBe(true);
    expect(readySensors.flightCommandsEnabled).toBe(false);
    expect(readySensors.answerHe).toMatch(/טייס מטיס/);
    expect(readySensors.answerHe).not.toMatch(/פקודות טיסה חסומות/);
    expect(readySensors.items.find((r) => r.id === 'flightCommands').blocker).toBe(false);
    expect(engine).not.toMatch(/FLIGHT_ACTION|COMMAND_LONG|MAV_CMD_NAV_LAND|ARM_DISARM/);
    expect(api).not.toMatch(/app\.post\(/);
  });

  it('does not invent a FC heartbeat from silence', () => {
    const body = buildVisionLandingReadiness({
      ...emptyInput,
      companion: { jetson: 'reachable', fc: 'unknown', hasData: true },
      mavlink: { connected: false, heartbeatCount: 0 },
    });
    const fc = body.items.find((r) => r.id === 'fc');
    expect(fc.chip).toBe('off');
    expect(fc.state).toBe('unknown');
  });

  it('reports PLND profile honestly and never blocks Experiment #1', () => {
    const missing = buildVisionLandingReadiness(emptyInput).items.find((r) => r.id === 'plnd');
    expect(missing.state).toBe('absent');
    expect(missing.blocker).toBe(false);
    expect(missing.missingHe).toMatch(/לא חוסם את ניסוי אחד/);
    const consoleOnly = buildVisionLandingReadiness({
      ...emptyInput,
      arduTarget: { PLND_ENABLED: 1, PLND_TYPE: 1 },
    }).items.find((r) => r.id === 'plnd');
    expect(consoleOnly.state).toBe('console');
    expect(consoleOnly.chip).toBe('warn');
    expect(consoleOnly.blocker).toBe(false);
    const onFc = buildVisionLandingReadiness({
      ...emptyInput,
      arduTarget: { PLND_ENABLED: 1, PLND_TYPE: 1 },
      arduCurrent: { PLND_ENABLED: 1, PLND_TYPE: 1 },
    }).items.find((r) => r.id === 'plnd');
    expect(onFc.state).toBe('present');
    expect(onFc.chip).toBe('on');
  });

  it('can mark Experiment #1 ready without annotations, lock-status, or flight commands', () => {
    const body = buildVisionLandingReadiness({
      companion: { jetson: 'reachable', fc: 'heartbeat', hasData: true, fc_heartbeat: true },
      vision: { camera_ok: true, running: true, health: 'ok' },
      dual: { cellular: 'modem_absent', modemPresent: false, video: { available: false, reason: 'modem_absent' } },
      mavlink: { connected: true, heartbeatCount: 8, lastHeartbeatAgeMs: 300 },
      arduTarget: {},
      arduCurrent: null,
      visionProfile: {},
      recording: { apiPresent: false, armed: false },
    });
    expect(body.experiment).toBe(1);
    expect(body.scopeHe).toBe(VISION_LANDING_SCOPE_HE);
    expect(body.experimentReady).toBe(true);
    expect(body.items.find((r) => r.id === 'video').blocker).toBe(false);
    expect(body.items.find((r) => r.id === 'lock').blocker).toBe(false);
    expect(body.items.find((r) => r.id === 'plnd').blocker).toBe(false);
    expect(body.flightCommandsEnabled).toBe(false);
    expect(body.answerHe).toMatch(/זיהוי מסלול לצפייה/);
  });

  it('exposes a live GET that stays display-only', async () => {
    const app = express();
    registerVisionLandingReadinessApi(app, {
      companionService: { mode: 'off', getSseOverlay: () => null },
      arduTargetParams: {},
      visionProfileStore: {},
    });
    const server = await listen(app);
    const addr = server.address();
    const r = await fetch(`http://127.0.0.1:${addr.port}/api/vision-landing/readiness`);
    const j = await r.json();
    await new Promise((resolve) => server.close(resolve));
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.experiment).toBe(1);
    expect(j.questionHe).toBe(VISION_LANDING_QUESTION_HE);
    expect(j.scopeHe).toBe(VISION_LANDING_SCOPE_HE);
    expect(j.experimentReady).toBe(false);
    expect(j.flightCommandsEnabled).toBe(false);
    expect(j.picHandFly).toBe(true);
    expect(j.observeOnly).toBe(true);
    const ids = j.items.map((row) => row.id);
    expect(ids).toEqual(['jetson', 'fc', 'camera', 'plnd', 'video', 'lock', 'flightCommands']);
    expect(j.items.find((row) => row.id === 'camera').state).not.toBe('ok');
    expect(j.items.find((row) => row.id === 'lock').state).toBe('not_recording');
    expect(j.items.find((row) => row.id === 'lock').blocker).toBe(false);
    expect(j.items.find((row) => row.id === 'video').blocker).toBe(false);
    expect(j.items.find((row) => row.id === 'flightCommands').enabled).toBe(false);
  });
});

describe('Vision Landing Readiness UI', () => {
  it('places the checklist on Mission glance, Status, and diagnostics', () => {
    expect(html).toContain('id="missionReadinessGlance"');
    expect(html).toMatch(/id="pfdReadinessTitle"[^>]*>אפשר להתחיל ניסוי אחד\?</);
    expect(html).toContain('גישה סופית. טייס מטיס. זיהוי מסלול לצפייה בלבד.');
    expect(html).toContain('id="pulseVisionLandingReadiness"');
    expect(html).toContain('id="visionLandingReadinessStrip"');
    expect(html).toContain('id="pulseVlrList"');
    expect(html).toContain('id="diagVlrList"');
    expect(css).toMatch(/\.vlr-chip\b/);
    expect(css).toMatch(/\.vlr-chip\[data-state="on"\]/);
    expect(css).toMatch(/\.vlr-chip\[data-state="warn"\]/);
    expect(css).toMatch(/\.vlr-chip\[data-state="off"\]/);
    expect(js).toMatch(/function renderVisionLandingReadiness\(/);
    expect(js).toMatch(/\/api\/vision-landing\/readiness/);
    expect(js).toMatch(/fillVisionLandingList/);
  });

  it('does not add flight-command send controls', () => {
    expect(js).not.toMatch(/FLIGHT_ACTION/);
    expect(js).not.toMatch(/MAV_CMD_NAV_LAND|MAV_CMD_COMPONENT_ARM_DISARM/);
    const chromeStart = js.indexOf('function setupFlightHudChromeHandlers');
    const chrome = js.slice(chromeStart, js.indexOf('setupFlightHudChromeHandlers();'));
    expect(chrome).not.toMatch(/ARM the|DISARM|LAND|auto-land|FLIGHT_ACTION/);
    expect(html).not.toMatch(/data-flight-cmd|sendArm|sendLand|autoLandBtn/);
  });

  it('routes Assist נחיתה ויזואלית to Mission readiness', () => {
    expect(findAssistRoute('נחיתה ויזואלית')?.id).toBe('readiness');
    expect(findAssistRoute('ניסוי נחיתה')?.id).toBe('readiness');
    expect(findAssistRoute('ניסוי אחד')?.id).toBe('readiness');
    expect(resolveAssistIntent('ניסוי אחד').slots.route_id).toBe('readiness');
    expect(resolveAssistIntent('נחיתה ויזואלית').slots.route_id).toBe('readiness');
    expect(hebrewOpenRouteAnswer('readiness')).toBe('פותחים את המוכנות.');
    expect(resolveAssistIntent('ARM the plane').prohibited).toBe(true);
    expect(resolveAssistIntent('land now').prohibited).toBe(true);
  });
});

describe('Vision Landing Readiness registration', () => {
  it('registers the readiness GET on the HTTP surface', () => {
    expect(httpRegister).toMatch(/registerVisionLandingReadinessApi\(app, ctx\)/);
    expect(coreApi).toMatch(/visionLandingReadiness:\s*true/);
  });

  it('pins APP_VERSION at 1.02.284', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.284'");
    expect(pkg.version).toBe('1.02.284');
  });
});
