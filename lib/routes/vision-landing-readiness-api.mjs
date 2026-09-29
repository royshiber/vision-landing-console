/**
 * GET /api/vision/landing-readiness
 * GET/PUT /api/vision/camera-install — operator confirm only; never invents camera_ok.
 * Read-only honesty snapshot for fixed-wing Experiment 1 (PIC hand-flies final, observe-only).
 * runwayLock is observe-only: not / detecting / locked, or unknown when no lock signal.
 * No flight-command send. No Companion apply/restart. No Companion-real widening.
 */

import { logger } from '../logger.mjs';
import { getConfig, setConfig } from '../db.mjs';
import {
  getAllConnectionStatuses,
  getActiveConnection,
  getConnectionParams,
} from '../mavlink-connection.mjs';
import { snapshotCompanionLinkFromCtx } from '../companion-connection.mjs';
import { snapshotDualLink, getTelemetryArchive } from '../dual-link-runtime.mjs';
import { collectCompanionVisionSignals } from '../vision-companion-probe.mjs';
import {
  buildVisionLandingReadiness,
  isGcsHeartbeatFresh,
} from '../vision-landing-readiness.mjs';
import { buildFieldPreflight } from '../field-preflight.mjs';
import {
  CAMERA_INSTALL_CONFIG_KEY,
  buildCameraInstallChecklist,
  normalizeCameraInstallOperator,
} from '../camera-install-checklist.mjs';
import { APP_VERSION } from '../../version.js';
import { extractCompanionSignal } from '../comm-links.mjs';
import { buildPreflightReadiness, preflightSampleFresh } from '../preflight-readiness.mjs';

const VISION_CONFIG_PROFILE_KEY = 'visionProfileStore';
const VISION_CONFIG_ARDU_KEY = 'arduTargetParams';

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function companionParamsFrom(overlay, companion) {
  const o = obj(overlay) || {};
  const c = obj(companion) || {};
  const vision = obj(o.vision) || obj(c.vision) || {};
  return obj(o.params)
    || obj(o.fc_params)
    || obj(o.fcParams)
    || obj(vision.params)
    || obj(vision.profile)
    || obj(c.params)
    || obj(c.fc_params)
    || obj(c.fcParams)
    || null;
}

function liveFcParams() {
  const active = getActiveConnection?.();
  if (active?.id) {
    const params = getConnectionParams(active.id);
    if (obj(params) && Object.keys(params).length > 0) return params;
  }
  for (const status of getAllConnectionStatuses()) {
    const params = getConnectionParams(status.id);
    if (obj(params) && Object.keys(params).length > 0) return params;
  }
  return null;
}

export async function collectVisionLandingReadinessInput(ctx = {}) {
  const companion = snapshotCompanionLinkFromCtx(ctx);
  const overlay = ctx.companionService?.getSseOverlay?.()?.companion || null;
  const links = snapshotDualLink(ctx);
  const statuses = getAllConnectionStatuses();
  const gcsHeartbeatFresh = statuses.some((s) => isGcsHeartbeatFresh(s))
    ? true
    : statuses.some((s) => s?.connected === true)
      ? false
      : null;
  const signals = await collectCompanionVisionSignals({
    overlay,
    client: ctx.companionService?.client || ctx.companionClient || null,
  });
  let persistedArduTarget = null;
  let persistedVisionProfile = null;
  let cameraInstallOperator = null;
  if (ctx.db) {
    try {
      persistedArduTarget = getConfig(ctx.db, VISION_CONFIG_ARDU_KEY, null);
      persistedVisionProfile = getConfig(ctx.db, VISION_CONFIG_PROFILE_KEY, null);
      cameraInstallOperator = getConfig(ctx.db, CAMERA_INSTALL_CONFIG_KEY, null);
    } catch {
      persistedArduTarget = null;
      persistedVisionProfile = null;
      cameraInstallOperator = null;
    }
  }
  const mergedOverlay = {
    ...(obj(overlay) || {}),
    vision: signals.vision || overlay?.vision || null,
    video: signals.video || overlay?.video || links.video || null,
    landing: signals.landing || overlay?.landing || null,
        extras: signals.extras || overlay?.extras || null,
        visionResult: signals.visionResult || null,
        optical_nav: signals.opticalNav || overlay?.optical_nav || overlay?.opticalNav || null,
        landingPathAbsent: signals.landingPathAbsent === true,
  };
  const active = getActiveConnection?.();
  const askGoActive = typeof ctx.assistService?.isAskVoiceGoActive === 'function'
    ? ctx.assistService.isAskVoiceGoActive()
    : null;
  return {
    companion,
    overlay: mergedOverlay,
    video: mergedOverlay.video,
    extras: mergedOverlay.extras,
    visionResult: mergedOverlay.visionResult,
    landingPathAbsent: mergedOverlay.landingPathAbsent,
    cellular: links.cellular,
    radio: links.radio,
    preferred: links.preferred,
    modemPresent: links.modemPresent,
    streamPresent: links.video?.streamPresent === true,
    modem: links.modem,
    comm: links.comm,
    rc: links.rc,
    cellularSignal: extractCompanionSignal(companion),
    gcsHeartbeatFresh,
    liveFcParams: liveFcParams(),
    companionParams: companionParamsFrom(mergedOverlay, companion),
    persistedArduTarget,
    persistedVisionProfile,
    cameraInstallOperator,
    manualRecordApi: liveManualRecordApi(ctx),
    archiveReady: true,
    askGoActive,
    consoleVersion: ctx.APP_VERSION || APP_VERSION,
    jetsonVersion: companion?.version || overlay?.version || null,
    fcVersion: active?.autopilotName
      || companion?.fcFirmware
      || obj(companion?.fc)?.firmware
      || null,
  };
}

function liveManualRecordApi(ctx = {}) {
  try {
    const archive = getTelemetryArchive({ db: ctx.db || null, dataDir: ctx.dataDir });
    return { recording: archive.isRecording() === true };
  } catch {
    return { recording: false };
  }
}

function persistCameraInstallOperator(db, raw) {
  const next = normalizeCameraInstallOperator(raw);
  if (db) setConfig(db, CAMERA_INSTALL_CONFIG_KEY, next);
  return next;
}

function cameraFlag(companion, key, now) {
  if (!companion || typeof companion !== 'object') return null;
  const at = companion.at;
  if (typeof at === 'number' && Number.isFinite(at) && now - at > 5000) return null;
  if (companion[key] === 1) return true;
  if (companion[key] === 0) return false;
  return null;
}

export function readPreflightReadinessInput(ctx = {}, now = Date.now()) {
  const active = getActiveConnection?.() || null;
  const links = snapshotDualLink(ctx);
  const sensors = preflightSampleFresh(active?.lastSysSensors, now);
  const gps = preflightSampleFresh(active?.lastGpsRaw, now);
  const battery = preflightSampleFresh(active?.lastBattery, now);
  const radioLive = links.radioConnection || null;
  const cellLive = links.cellularConnection || null;
  const companion = links.companion || {};
  let recording = false;
  try {
    recording = getTelemetryArchive({ db: ctx.db || null, dataDir: ctx.dataDir }).isRecording() === true;
  } catch {
    recording = false;
  }
  const radioType = String(radioLive?.type || '');
  const radioSerial = radioType === 'serial' || radioType === 'telemetry';
  return {
    sensors,
    gpsFixType: Number.isFinite(gps?.fixType) ? gps.fixType : null,
    batteryV: Number.isFinite(battery?.voltage_V) ? battery.voltage_V : null,
    radioConnected: radioLive?.connected === true && radioSerial && Number(radioLive?.heartbeatCount) > 0,
    radioSimulator: radioLive?.simulator === true,
    cellularConnected: cellLive?.connected === true,
    cam0: cameraFlag(active?.rfCompanion, 'cam0', now),
    cam1: cameraFlag(active?.rfCompanion, 'cam1', now),
    recording,
    jetsonReachable: companion.mode === 'real' && companion.reachable === true,
  };
}

export function registerVisionLandingReadinessApi(app, ctx = {}) {
  app.get('/api/preflight-readiness', (_req, res) => {
    try {
      res.json(buildPreflightReadiness(readPreflightReadinessInput(ctx)));
    } catch (err) {
      logger.error({ err }, 'GET /api/preflight-readiness failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/vision/landing-readiness', async (_req, res) => {
    try {
      const input = await collectVisionLandingReadinessInput(ctx);
      const snapshot = buildVisionLandingReadiness(input);
      res.json({
        ...snapshot,
        fieldPreflight: buildFieldPreflight(input),
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/vision/landing-readiness failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/vision/camera-install', async (_req, res) => {
    try {
      const input = await collectVisionLandingReadinessInput(ctx);
      res.json(buildCameraInstallChecklist({
        operator: input.cameraInstallOperator,
        companion: input.companion,
        vision: obj(input.overlay)?.vision,
        video: input.video,
        extras: input.extras,
        opticalNav: obj(input.overlay)?.optical_nav || obj(input.overlay)?.opticalNav,
      }));
    } catch (err) {
      logger.error({ err }, 'GET /api/vision/camera-install failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.put('/api/vision/camera-install', async (req, res) => {
    try {
      const body = obj(req.body) || {};
      const saved = persistCameraInstallOperator(ctx.db, body);
      const input = await collectVisionLandingReadinessInput(ctx);
      const snapshot = buildCameraInstallChecklist({
        operator: saved,
        companion: input.companion,
        vision: obj(input.overlay)?.vision,
        video: input.video,
        extras: input.extras,
        opticalNav: obj(input.overlay)?.optical_nav || obj(input.overlay)?.opticalNav,
      });
      res.json({
        ...snapshot,
        saved: true,
        operator: saved,
      });
    } catch (err) {
      logger.error({ err }, 'PUT /api/vision/camera-install failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });
}
