/**
 * GET /api/vision/landing-readiness
 * Read-only honesty snapshot for fixed-wing Experiment 1 (PIC hand-flies final, observe-only).
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
import { snapshotDualLink } from '../dual-link-runtime.mjs';
import {
  buildVisionLandingReadiness,
  isGcsHeartbeatFresh,
} from '../vision-landing-readiness.mjs';

const VISION_CONFIG_PROFILE_KEY = 'visionProfileStore';
const VISION_CONFIG_ARDU_KEY = 'arduTargetParams';

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

export function collectVisionLandingReadinessInput(ctx = {}) {
  const companion = snapshotCompanionLinkFromCtx(ctx);
  const overlay = ctx.companionService?.getSseOverlay?.()?.companion || null;
  const links = snapshotDualLink(ctx);
  const statuses = getAllConnectionStatuses();
  const gcsHeartbeatFresh = statuses.some((s) => isGcsHeartbeatFresh(s))
    ? true
    : statuses.some((s) => s?.connected === true)
      ? false
      : null;
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
  return {
    companion,
    overlay,
    video: links.video,
    cellular: links.cellular,
    modemPresent: links.modemPresent,
    gcsHeartbeatFresh,
    liveFcParams: liveFcParams(),
    persistedArduTarget,
    persistedVisionProfile,
    manualRecordApi: null,
  };
}

export function registerVisionLandingReadinessApi(app, ctx = {}) {
  app.get('/api/vision/landing-readiness', (_req, res) => {
    try {
      const snapshot = buildVisionLandingReadiness(collectVisionLandingReadinessInput(ctx));
      res.json(snapshot);
    } catch (err) {
      logger.error({ err }, 'GET /api/vision/landing-readiness failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });
}
