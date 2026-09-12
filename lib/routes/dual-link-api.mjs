/**
 * Dual-link + telemetry archive HTTP surface.
 * Does not add flight-command send or Companion apply/restart.
 */

import { logger } from '../logger.mjs';
import { setMavlinkRawSink, getAllConnectionStatuses } from '../mavlink-connection.mjs';
import {
  QUEUE_PRIORITIES,
  ARCHIVE_COPY_HE,
} from '../telemetry-archive.mjs';
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

export function isMavlinkLinkUp(statuses = getAllConnectionStatuses()) {
  return (statuses || []).some((s) => s && (s.connected === true || s.listening === true));
}

function inferArchiveLinkRole() {
  const live = getAllConnectionStatuses();
  const up = (s) => s && (s.connected || s.listening);
  const cell = live.find((s) => s.linkRole === 'cellular' && up(s));
  const radio = live.find((s) => (s.linkRole || 'radio') !== 'cellular' && up(s));
  if (cell && !radio) return 'cellular';
  return 'radio';
}

export function registerDualLinkApi(app, ctx) {
  const archive = getTelemetryArchive({ db: ctx.db, dataDir });
  let drainTimer = null;

  setMavlinkRawSink((_conn, buf) => {
    try {
      if (!archive.isRecording()) return;
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
        return res.status(400).json({ ok: false, message: 'בחרו רדיו או סלולר' });
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
        radioSatisfies: false,
        streamPresent: links.video?.streamPresent === true,
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
      const rec = desc.recording || {};
      res.json({
        ok: true,
        ...desc,
        linkUp: isMavlinkLinkUp(),
        sessionBytes: rec.session ? Number(rec.session.bytes) || 0 : null,
        sessionFrames: rec.session ? Number(rec.session.frames) || 0 : null,
        lastWriteError: rec.lastWriteError || null,
        droppedWrites: Number(rec.droppedWrites) || 0,
        cellularEndpoint: readCellularEndpoint(ctx.db),
        priorities: QUEUE_PRIORITIES,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/telemetry-archive failed');
      res.status(500).json({
        ok: false,
        message: err.message,
        messageHe: ARCHIVE_COPY_HE.httpFail,
      });
    }
  });

  app.post('/api/telemetry-archive/start', (req, res) => {
    try {
      const body = req.body || {};
      const linkRole = body.linkRole === 'cellular' ? 'cellular' : inferArchiveLinkRole();
      const flightId = Number.isFinite(Number(body.flightId)) ? Number(body.flightId) : null;
      const linkUp = isMavlinkLinkUp();
      const started = archive.startRecording({ linkRole, flightId });
      const modem = probeHuaweiE3372({ env: ctx.env || process.env });
      if (!started.ok) {
        return res.status(500).json({
          ok: false,
          already: false,
          recording: started.recording,
          archive: archive.describe(modem.present),
          linkUp,
          message: started.error || 'start_failed',
          messageHe: ARCHIVE_COPY_HE.startFail,
        });
      }
      res.json({
        ok: true,
        already: started.already,
        recording: started.recording,
        archive: archive.describe(modem.present),
        linkUp,
        messageHe: started.already ? ARCHIVE_COPY_HE.startAlready : ARCHIVE_COPY_HE.startOk,
        warnHe: linkUp ? null : ARCHIVE_COPY_HE.startNoLink,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/telemetry-archive/start failed');
      res.status(500).json({
        ok: false,
        message: err.message,
        messageHe: ARCHIVE_COPY_HE.startFail,
      });
    }
  });

  app.post('/api/telemetry-archive/stop', (_req, res) => {
    try {
      const stopped = archive.stopRecording();
      const modem = probeHuaweiE3372({ env: ctx.env || process.env });
      const closed = stopped.closed
        ? {
            storedPath: stopped.closed.storedPath,
            bytes: stopped.closed.bytes,
            frames: stopped.closed.frames,
            linkRole: stopped.closed.linkRole,
            rowId: stopped.closed.rowId,
          }
        : null;
      const empty = stopped.empty === true || (closed && !(Number(closed.bytes) > 0));
      res.json({
        ok: true,
        closed,
        empty,
        warnHe: stopped.warnHe || null,
        recording: stopped.recording,
        archive: archive.describe(modem.present),
        messageHe: closed
          ? (empty ? ARCHIVE_COPY_HE.stopEmpty : ARCHIVE_COPY_HE.stopOk)
          : ARCHIVE_COPY_HE.stopIdle,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/telemetry-archive/stop failed');
      res.status(500).json({
        ok: false,
        message: err.message,
        messageHe: ARCHIVE_COPY_HE.stopFail,
      });
    }
  });

  app.post('/api/telemetry-archive/discard', (_req, res) => {
    try {
      const discarded = archive.discardRecording();
      const modem = probeHuaweiE3372({ env: ctx.env || process.env });
      res.json({
        ok: true,
        discarded: discarded.discarded,
        recording: discarded.recording,
        archive: archive.describe(modem.present),
        messageHe: discarded.discarded ? 'ההקלטה בוטלה. הקובץ נמחק.' : 'אין הקלטה לביטול.',
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/telemetry-archive/discard failed');
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
