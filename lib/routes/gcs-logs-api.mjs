/**
 * Ground-station flight log upload. Off unless AIRVIX_GCS_LOG_UPLOAD=1.
 */
import path from 'node:path';
import { dataDir } from '../db.mjs';
import { logger } from '../logger.mjs';
import { resolveArchiveRoot, resolveArchiveSessionFile } from '../telemetry-archive.mjs';
import { GCS_LOG_COPY, createGcsLogUploader } from '../flight-logs/gcs-upload.mjs';

export function registerGcsLogsApi(app, ctx = {}) {
  const archiveRoot = ctx.archiveRoot || resolveArchiveRoot(ctx.dataDir || dataDir);
  const uploader = ctx.gcsUploader || createGcsLogUploader({
    env: process.env,
    storePath: ctx.gcsStorePath || path.join(ctx.dataDir || dataDir, 'gcs-log-uploads.json'),
    archiveRoot,
  });

  app.get('/api/gcs-logs', async (_req, res) => {
    try {
      const body = uploader.status();
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
      const sessionId = Number(req.body?.sessionId);
      let filePath = null;
      if (Number.isFinite(sessionId) && sessionId > 0 && ctx.db) {
        const file = resolveArchiveSessionFile(ctx.db, { id: sessionId, archiveRoot });
        if (file?.ok && file.absPath) filePath = file.absPath;
      }
      if (!filePath && typeof req.body?.filePath === 'string' && ctx.allowFilePath === true) {
        filePath = req.body.filePath;
      }
      if (!filePath) {
        return res.status(404).json({ ok: false, messageHe: GCS_LOG_COPY.empty });
      }
      const result = await uploader.uploadFile(filePath);
      res.status(result.status || (result.ok ? 200 : 409)).json(result);
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
