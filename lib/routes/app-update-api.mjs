import { getActiveConnection } from '../mavlink-connection.mjs';
import { isLoopbackRequest } from '../app-update.mjs';
import { logger } from '../logger.mjs';

function mavFrom(ctx) {
  if (typeof ctx.getMavConn === 'function') return ctx.getMavConn();
  try {
    return getActiveConnection();
  } catch {
    return null;
  }
}

export function registerAppUpdateApi(app, ctx = {}) {
  const svc = ctx.updateService;
  if (!svc) return;

  app.get('/api/v1/update/status', async (req, res) => {
    try {
      const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
      const status = await svc.status({ refresh, mavConn: mavFrom(ctx) });
      res.json(status);
    } catch (err) {
      logger.warn({ message: err?.message || 'status' }, 'update status failed');
      res.status(200).json({
        ok: true,
        current: null,
        latest: null,
        available: false,
        lastChecked: null,
        error: 'offline',
        blockedReason: null,
        changelog: [],
      });
    }
  });

  app.post('/api/v1/update/apply', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({
        ok: false,
        error: 'localhost_only',
        message: 'עדכון זמין רק מהמחשב הזה.',
      });
    }
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await svc.apply({
        confirmUnknown: body.confirmUnknown === true,
        mavConn: mavFrom(ctx),
      });
      const status = result.status || (result.ok ? 202 : 409);
      res.status(status).json(result);
    } catch (err) {
      logger.warn({ message: err?.message || 'apply' }, 'update apply failed');
      res.status(500).json({ ok: false, error: 'apply_failed', message: 'העדכון נכשל.' });
    }
  });
}
