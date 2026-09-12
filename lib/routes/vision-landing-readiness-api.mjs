/**
 * GET /api/vision-landing/readiness
 * Display-only experiment checklist. No flight-command send. No Companion apply.
 */

import { logger } from '../logger.mjs';
import { snapshotCompanionLinkFromCtx } from '../companion-connection.mjs';
import { snapshotDualLink } from '../dual-link-runtime.mjs';
import { getActiveConnection, getConnectionParams } from '../mavlink-connection.mjs';
import {
  buildVisionLandingReadiness,
  resolveManualRecordState,
} from '../vision-landing-readiness.mjs';

function snapshotLocalMavlink() {
  const conn = getActiveConnection?.();
  if (!conn) {
    return { connected: false, heartbeatCount: 0, lastHeartbeatAgeMs: null };
  }
  const status = typeof conn.getStatus === 'function' ? conn.getStatus() : conn;
  return {
    connected: !!status.connected,
    heartbeatCount: Number(status.heartbeatCount) || 0,
    lastHeartbeatAgeMs: status.lastHeartbeatAgeMs ?? null,
    id: status.id ?? conn.id ?? null,
  };
}

export function collectVisionLandingReadinessInput(ctx = {}) {
  const companion = snapshotCompanionLinkFromCtx(ctx);
  const overlay = ctx.companionService?.getSseOverlay?.()?.companion || null;
  const dual = snapshotDualLink(ctx);
  const mavlink = snapshotLocalMavlink();
  let arduCurrent = ctx.arduCurrentParams || null;
  if (!arduCurrent && mavlink.id != null) {
    arduCurrent = getConnectionParams(mavlink.id) || null;
  }
  return {
    companion,
    vision: overlay?.vision || null,
    video: overlay?.video || dual?.video || null,
    dual,
    mavlink,
    arduTarget: ctx.arduTargetParams || {},
    arduCurrent,
    visionProfile: ctx.visionProfileStore || {},
    recording: resolveManualRecordState(ctx),
  };
}

export function registerVisionLandingReadinessApi(app, ctx) {
  app.get('/api/vision-landing/readiness', (_req, res) => {
    try {
      const input = collectVisionLandingReadinessInput(ctx);
      const body = buildVisionLandingReadiness(input);
      res.json({
        ...body,
        source: 'live',
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/vision-landing/readiness failed');
      res.status(500).json({ ok: false, message: err?.message || 'readiness failed' });
    }
  });
}
