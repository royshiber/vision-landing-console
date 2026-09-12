/**
 * GET /api/vision/landing-readiness
 * Read-only honesty snapshot for fixed-wing Experiment 1 (PIC hand-flies final, observe-only).
 * runwayLock is observe-only: not / detecting / locked, or unknown when no lock signal.
 * No flight-command send. No Companion apply/restart. No Companion-real widening.
 */

import { logger } from '../logger.mjs';
import { getConfig } from '../db.mjs';
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
  if (ctx.db) {
    try {
      persistedArduTarget = getConfig(ctx.db, VISION_CONFIG_ARDU_KEY, null);
      persistedVisionProfile = getConfig(ctx.db, VISION_CONFIG_PROFILE_KEY, null);
    } catch {
      persistedArduTarget = null;
      persistedVisionProfile = null;
    }
  }
  const mergedOverlay = {
    ...(obj(overlay) || {}),
    vision: signals.vision || overlay?.vision || null,
    video: signals.video || overlay?.video || links.video || null,
    landing: signals.landing || overlay?.landing || null,
    extras: signals.extras || overlay?.extras || null,
    visionResult: signals.visionResult || null,
    landingPathAbsent: signals.landingPathAbsent === true,
  };
  return {
    companion,
    overlay: mergedOverlay,
    video: mergedOverlay.video,
    extras: mergedOverlay.extras,
    visionResult: mergedOverlay.visionResult,
    landingPathAbsent: mergedOverlay.landingPathAbsent,
    cellular: links.cellular,
    modemPresent: links.modemPresent,
    gcsHeartbeatFresh,
    liveFcParams: liveFcParams(),
    companionParams: companionParamsFrom(mergedOverlay, companion),
    persistedArduTarget,
    persistedVisionProfile,
    manualRecordApi: liveManualRecordApi(ctx),
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

export function registerVisionLandingReadinessApi(app, ctx = {}) {
  app.get('/api/vision/landing-readiness', async (_req, res) => {
    try {
      const snapshot = buildVisionLandingReadiness(await collectVisionLandingReadinessInput(ctx));
      res.json(snapshot);
    } catch (err) {
      logger.error({ err }, 'GET /api/vision/landing-readiness failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });
}
