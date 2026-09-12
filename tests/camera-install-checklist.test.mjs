import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { registerVisionLandingReadinessApi } from '../lib/routes/vision-landing-readiness-api.mjs';
import {
  CAMERA_INSTALL_NO_FRAME_HE,
  CAMERA_INSTALL_MOUNT_DISCLAIMER_HE,
  CAMERA_INSTALL_STEP_IDS,
  buildCameraInstallChecklist,
  normalizeCameraInstallOperator,
  resolveLiveFrameVerify,
} from '../lib/camera-install-checklist.mjs';
import { buildVisionLandingReadiness } from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function stepById(checklist, id) {
  return checklist.steps.find((s) => s.id === id);
}

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function allConfirmedOperator() {
  return normalizeCameraInstallOperator({
    roles: { cam1: 'forward', cam2: 'down' },
    confirms: {
      role_select: true,
      physical_connect: true,
      jetson_wiring: true,
      companion_pipeline: true,
      live_frame: true,
    },
  });
}

describe('camera install checklist honesty', () => {
  it('keeps dual role labels and does not invent a frame', () => {
    const empty = buildCameraInstallChecklist({});
    expect(empty.roleLabelsHe.forward).toBe('קדמית');
    expect(empty.roleLabelsHe.down).toBe('מטה');
    expect(empty.roles.cam1.titleHe).toContain('קדמית');
    expect(empty.roles.cam2.titleHe).toContain('מטה');
    expect(empty.steps.map((s) => s.id)).toEqual([...CAMERA_INSTALL_STEP_IDS]);
    expect(empty.summary.cameraOk).toBeNull();
    expect(empty.liveFrame.state).toBe('missing');
    expect(empty.liveFrame.stateHe).toBe(CAMERA_INSTALL_NO_FRAME_HE);
    expect(stepById(empty, 'live_frame').systemState).toBe('missing');
    expect(stepById(empty, 'live_frame').systemStateHe).toBe(CAMERA_INSTALL_NO_FRAME_HE);
    expect(empty.invented).toEqual({ camera: false, frames: false, calibration: false });
    expect(empty.calibrationClaimed).toBe(false);
    expect(empty.mountNote.disclaimerHe).toBe(CAMERA_INSTALL_MOUNT_DISCLAIMER_HE);
    expect(empty.mountNote.estimateOnly).toBe(true);
  });

  it('does not mark camera_ok from operator confirm alone', () => {
    const confirmed = buildCameraInstallChecklist({
      operator: allConfirmedOperator(),
    });
    expect(confirmed.summary.operatorConfirmedCount).toBe(5);
    expect(confirmed.steps.every((s) => s.operatorConfirmed)).toBe(true);
    expect(confirmed.summary.cameraOk).toBeNull();
    expect(confirmed.probe.cameraOk).toBeNull();
    expect(confirmed.liveFrame.state).toBe('missing');
    expect(stepById(confirmed, 'live_frame').systemState).not.toBe('ok');
    expect(stepById(confirmed, 'companion_pipeline').systemState).toBe('unknown');
    const row = rowById(buildVisionLandingReadiness({
      cameraInstallOperator: allConfirmedOperator(),
    }), 'camera_install');
    expect(row.state).not.toBe('ok');
    expect(row.cameraOk).not.toBe(true);
    expect(row.missingHe).toMatch(/אישור מפעיל אינו דיווח מצלמה/);
  });

  it('keeps live frame missing when camera_ok is true but no fps age or count', () => {
    const noFrame = buildCameraInstallChecklist({
      companion: { jetson: 'reachable' },
      vision: { camera_ok: true },
    });
    expect(noFrame.summary.cameraOk).toBe(true);
    expect(noFrame.liveFrame.state).toBe('missing');
    expect(noFrame.liveFrame.stateHe).toBe(CAMERA_INSTALL_NO_FRAME_HE);
    expect(stepById(noFrame, 'live_frame').systemState).toBe('missing');
    expect(resolveLiveFrameVerify({})).toMatchObject({
      state: 'missing',
      stateHe: CAMERA_INSTALL_NO_FRAME_HE,
    });
  });

  it('verifies a live frame only from reported fps frames or age', () => {
    const fps = buildCameraInstallChecklist({
      companion: { jetson: 'reachable' },
      vision: { camera_ok: true, fps: 30 },
    });
    expect(fps.liveFrame.state).toBe('ok');
    expect(fps.liveFrame.fps).toBe(30);
    expect(stepById(fps, 'live_frame').systemState).toBe('ok');
    const age = resolveLiveFrameVerify({ frameAgeMs: 120 });
    expect(age.state).toBe('ok');
    const frames = resolveLiveFrameVerify({ frames: 4 });
    expect(frames.state).toBe('ok');
    const readiness = buildVisionLandingReadiness({
      companion: { jetson: 'reachable' },
      overlay: { vision: { camera_ok: true, fps: 24 } },
    });
    expect(rowById(readiness, 'camera_install').state).toBe('ok');
    expect(rowById(readiness, 'camera_vision').state).toBe('ok');
    expect(readiness.cameraInstall.invented.frames).toBe(false);
  });

  it('ignores client camera_ok on normalize and keeps mount as estimate only', () => {
    const sneaky = normalizeCameraInstallOperator({
      camera_ok: true,
      confirms: { live_frame: true },
      mountNote: { kind: 'preset_45_down', estimateOnly: false, text: 'calibrated' },
    });
    expect(sneaky.confirms.live_frame).toBe(true);
    expect(sneaky.mountNote.kind).toBe('preset_45_down');
    expect(sneaky.mountNote.estimateOnly).toBe(true);
    expect(sneaky.mountNote.disclaimerHe).toBe(CAMERA_INSTALL_MOUNT_DISCLAIMER_HE);
    expect(sneaky).not.toHaveProperty('camera_ok');
  });
});

describe('camera install API persist', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-cic-${Date.now()}.sqlite`);
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

  it('stores operator confirm without turning camera_ok green', async () => {
    const put = await fetch(`${base}/api/vision/camera-install`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        camera_ok: true,
        confirms: { physical_connect: true, live_frame: true },
        roles: { cam1: 'forward', cam2: 'down' },
      }),
    });
    const saved = await put.json();
    expect(put.status).toBe(200);
    expect(saved.ok).toBe(true);
    expect(saved.saved).toBe(true);
    expect(saved.summary.cameraOk).toBeNull();
    expect(saved.liveFrame.stateHe).toBe(CAMERA_INSTALL_NO_FRAME_HE);
    expect(saved.operator.confirms.physical_connect).toBe(true);
    expect(saved.operator.confirms.live_frame).toBe(true);

    const ready = await fetch(`${base}/api/vision/landing-readiness`);
    const snap = await ready.json();
    expect(rowById(snap, 'camera_vision').state).toBe('unknown');
    expect(rowById(snap, 'camera_install').state).not.toBe('ok');
    expect(snap.cameraInstall.summary.cameraOk).toBeNull();
    expect(snap.cameraInstall.operator.confirms.physical_connect).toBe(true);
  });
});

describe('camera install UI copy', () => {
  it('extends מוכנות with dual-role Hebrew checklist and no flight commands', () => {
    expect(html).toContain('id="cameraInstallChecklist"');
    expect(html.indexOf('id="cameraInstallChecklist"')).toBeGreaterThan(html.indexOf('id="visionLandingReadinessList"'));
    expect(js).toContain('function renderCameraInstallChecklist');
    expect(js).toContain('function cameraInstallBusy');
    expect(js).toMatch(/tag === 'input' \|\| tag === 'textarea'/);
    expect(js).toContain('אישור ביצעתי');
    expect(js).toContain('קדמית');
    expect(js).toContain('מטה');
    expect(js).toContain('אין פריים');
    expect(js).toContain('הערכה בלבד — לא כיול');
    expect(js).toContain("fetch('/api/vision/camera-install'");
    expect(css).toMatch(/\.cic-panel\b/);
    expect(css).toMatch(/\.cic-sys\[data-state="missing"\]/);
    expect(js).not.toMatch(/self-cal|auto.?calibrat|IMU.?vision.?calibrat/i);
    expect(js).not.toMatch(/FLIGHT_ACTION/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });
});
