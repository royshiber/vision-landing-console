/**
 * Dual-link + telemetry archive HTTP surface.
 * Does not add flight-command send or Companion apply/restart.
 */

import { logger } from '../logger.mjs';
import { setMavlinkRawSink, getAllConnectionStatuses } from '../mavlink-connection.mjs';
import { QUEUE_PRIORITIES } from '../telemetry-archive.mjs';
import {
  snapshotDualLink,
  connectLink,
  disconnectLink,
  setActiveLink,
  getTelemetryArchive,
  readCellularEndpoint,
} from '../dual-link-runtime.mjs';
import { probeHuaweiE3372 } from '../cellular-modem.mjs';
import { dataDir } from '../db.mjs';

function parseHostPort(s) {
  const m = String(s || '').trim().match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

export function registerDualLinkApi(app, ctx) {
  const archive = getTelemetryArchive({ db: ctx.db, dataDir });
  let drainTimer = null;

  setMavlinkRawSink((conn, buf) => {
    try {
      if (!archive.hasSession()) {
        archive.openSession({
          linkRole: conn?.linkRole === 'cellular' ? 'cellular' : 'radio',
        });
      }
      archive.appendRaw(buf);
    } catch {
      /* never starve flight */
    }
  });

  if (!drainTimer) {
    drainTimer = setInterval(() => {
      try { archive.drain({ maxJobs: 8 }); } catch { /* ignore */ }
    }, 250);
    drainTimer.unref?.();
  }

  app.get('/api/links', (_req, res) => {
    try {
      res.json({ ok: true, links: snapshotDualLink(ctx) });
    } catch (err) {
      logger.error({ err }, 'GET /api/links failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/links/connect', async (req, res) => {
    try {
      const body = req.body || {};
      const role = body.role === 'cellular' ? 'cellular' : 'radio';
      let host = body.host;
      let port = body.port;
      if ((!host || !port) && body.endpoint) {
        const hp = parseHostPort(body.endpoint);
        if (hp) { host = hp.host; port = hp.port; }
      }
      const result = await connectLink(ctx, {
        role,
        type: body.type,
        host,
        port,
        serialPort: body.serialPort,
        baudRate: body.baudRate,
      });
      if (!result.ok) {
        const status = result.state === 'modem_absent' ? 422 : 400;
        return res.status(status).json(result);
      }
      try { archive.openSession({ linkRole: role }); } catch { /* ignore */ }
      res.json({ ...result, links: snapshotDualLink(ctx) });
    } catch (err) {
      logger.error({ err }, 'POST /api/links/connect failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/links/disconnect', (req, res) => {
    try {
      const role = req.body?.role === 'cellular' ? 'cellular' : 'radio';
      const result = disconnectLink(ctx, role);
      try {
        if (getAllConnectionStatuses().length === 0) archive.closeSession();
      } catch { /* ignore */ }
      res.json({ ...result, links: snapshotDualLink(ctx) });
    } catch (err) {
      logger.error({ err }, 'POST /api/links/disconnect failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/links/active', (req, res) => {
    try {
      const role = req.body?.role;
      if (role !== 'radio' && role !== 'cellular') {
        return res.status(400).json({ ok: false, message: 'בחרו טלמטריה רגילה או סלולר' });
      }
      const result = setActiveLink(ctx, role);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'POST /api/links/active failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/links/annotated-video', (_req, res) => {
    try {
      const links = snapshotDualLink(ctx);
      res.json({
        ok: true,
        path: 'cellular',
        from: 'jetson',
        neverRadio: true,
        ...links.video,
        cellular: links.cellular,
        modem: links.modem,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/links/annotated-video failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.get('/api/telemetry-archive', (_req, res) => {
    try {
      const modem = probeHuaweiE3372({ env: ctx.env || process.env });
      const desc = archive.describe(modem.present);
      res.json({
        ok: true,
        ...desc,
        cellularEndpoint: readCellularEndpoint(ctx.db),
        priorities: QUEUE_PRIORITIES,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/telemetry-archive failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  app.post('/api/telemetry-archive/downlink', (_req, res) => {
    try {
      const modem = probeHuaweiE3372({ env: ctx.env || process.env });
      const queued = archive.enqueueDownlink({ requestedAt: Date.now() });
      res.json({
        ok: queued.accepted,
        stub: true,
        modemPresent: modem.present,
        queue: queued,
        messageHe: modem.present
          ? 'סנכרון נכנס לתור נמוך. טלמטריית טיסה קודמת.'
          : 'מודם לא מחובר. הסנכרון נשמר כתור מדומה.',
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/telemetry-archive/downlink failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });
}
