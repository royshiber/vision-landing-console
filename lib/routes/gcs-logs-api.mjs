/**
 * Ground-station flight log upload. Off unless AIRVIX_GCS_LOG_UPLOAD=1.
 */
import path from 'node:path';
import { dataDir } from '../db.mjs';
import { logger } from '../logger.mjs';
import { listArchiveSessions, resolveArchiveRoot, resolveArchiveSessionFile } from '../telemetry-archive.mjs';
import { GCS_LOG_COPY, createGcsLogUploader } from '../flight-logs/gcs-upload.mjs';

export function registerGcsLogsApi(app, ctx = {}) {
  const archiveRoot = ctx.archiveRoot || resolveArchiveRoot(ctx.dataDir || dataDir);
  const uploader = ctx.gcsUploader || createGcsLogUploader({
    env: process.env,
    storePath: ctx.gcsStorePath || path.join(ctx.dataDir || dataDir, 'gcs-log-uploads.json'),
    archiveRoot,
  });

  function pendingSessionFiles() {
    if (typeof ctx.listPendingSessions === 'function') {
      return ctx.listPendingSessions()
        .filter((session) => session && session.id && session.absPath && session.downloadable !== false && !session.open && !session.empty)
        .filter((session) => !uploader.isCompletePath(session.absPath))
        .map((session) => ({ id: Number(session.id), absPath: session.absPath }));
    }
    if (!ctx.db) return [];
    const listed = listArchiveSessions(ctx.db, { archiveRoot });
    const out = [];
    for (const session of listed.sessions || []) {
      if (!session?.downloadable || session.open || session.empty || !session.id) continue;
      const file = resolveArchiveSessionFile(ctx.db, { id: session.id, archiveRoot });
      if (!file?.ok || !file.absPath) continue;
      if (uploader.isCompletePath(file.absPath)) continue;
      out.push({ id: session.id, absPath: file.absPath });
    }
    return out;
  }

  function withPending(body) {
    const pending = pendingSessionFiles();
    body.pendingCount = pending.length;
    body.pendingSessionIds = pending.map((row) => row.id);
    const active = (body.items || []).some((item) => item.state === 'uploading' || item.state === 'interrupted');
    if (body.enabled && body.configured && !active && pending.length) {
      body.messageHe = GCS_LOG_COPY.pending;
      body.state = 'ready';
    }
    return body;
  }

  app.get('/api/gcs-logs', async (_req, res) => {
    try {
      const body = withPending(uploader.status());
      if (body.enabled && body.configured) {
        const remote = await uploader.listRemote();
        const known = new Set(body.items.map((item) => item.key));
        for (const item of remote) {
          if (!known.has(item.key)) body.items.push(item);
        }
      }
      res.json(body);
    } catch (err) {
      logger.warn({ err: err?.message }, 'gcs log list failed');
      res.status(502).json({ ok: false, messageHe: GCS_LOG_COPY.failed, items: uploader.status().items });
    }
  });

  app.post('/api/gcs-logs/upload', async (req, res) => {
    try {
      const snap = uploader.status();
      if (!snap.enabled) {
        return res.status(409).json({ ...snap, ok: false, messageHe: GCS_LOG_COPY.off });
      }
      const requested = [];
      if (Array.isArray(req.body?.sessionIds)) {
        for (const raw of req.body.sessionIds) {
          const id = Number(raw);
          if (Number.isFinite(id) && id > 0) requested.push(id);
        }
      } else if (Number.isFinite(Number(req.body?.sessionId)) && Number(req.body.sessionId) > 0) {
        requested.push(Number(req.body.sessionId));
      }
      let files = [];
      if (requested.length && typeof ctx.listPendingSessions === 'function') {
        const known = new Map(pendingSessionFiles().map((row) => [row.id, row.absPath]));
        files = requested.map((id) => known.get(id)).filter(Boolean).map((absPath) => ({ absPath }));
      } else if (requested.length && ctx.db) {
        for (const id of requested) {
          const file = resolveArchiveSessionFile(ctx.db, { id, archiveRoot });
          if (file?.ok && file.absPath) files.push({ absPath: file.absPath });
        }
      } else if (!requested.length) {
        files = pendingSessionFiles();
      }
      if (!files.length && typeof req.body?.filePath === 'string' && ctx.allowFilePath === true) {
        files = [{ absPath: req.body.filePath }];
      }
      if (!files.length) {
        return res.status(404).json({ ok: false, messageHe: GCS_LOG_COPY.empty });
      }
      let result = null;
      for (const file of files) {
        result = await uploader.uploadFile(file.absPath);
        if (!result.ok) break;
      }
      res.status(result.status || (result.ok ? 200 : 409)).json(withPending(result));
    } catch (err) {
      logger.warn({ err: err?.message }, 'gcs log upload failed');
      res.status(502).json({ ok: false, messageHe: GCS_LOG_COPY.failed });
    }
  });

  app.post('/api/gcs-logs/resume', async (req, res) => {
    try {
      const result = await uploader.resume(String(req.body?.id || ''));
      res.status(result.status || (result.ok ? 200 : 409)).json(result);
    } catch (err) {
      logger.warn({ err: err?.message }, 'gcs log resume failed');
      res.status(502).json({ ok: false, messageHe: GCS_LOG_COPY.interrupted });
    }
  });

  app.get('/api/gcs-logs/download', async (req, res) => {
    try {
      const result = await uploader.download(String(req.query?.key || ''));
      if (!result.ok) return res.status(result.status || 404).json({ ok: false, messageHe: result.messageHe });
      const name = path.posix.basename(result.key).replace(/[^A-Za-z0-9._-]/g, '_') || 'log.tlog';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(result.bytes);
    } catch (err) {
      logger.warn({ err: err?.message }, 'gcs log download failed');
      res.status(502).json({ ok: false, messageHe: GCS_LOG_COPY.failed });
    }
  });
}
