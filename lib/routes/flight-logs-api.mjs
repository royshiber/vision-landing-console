/**
 * Read-only flight book API. Cloud keys stay on the server.
 */
import path from 'node:path';
import { getFlightDebrief } from '../flight-logs/debrief.mjs';
import { NO_SERIES_HE } from '../flight-logs/messages.mjs';
import {
  listEvents,
  listFlightLogs,
  openFlightBundle,
  patchFlightOverlay,
  publicFlightLogsStatus,
  readFlightArtifact,
  syncFlightLogs,
} from '../flight-logs/sync.mjs';

function sendErr(res, err) {
  const status = Number(err?.status) || 500;
  const messageHe = err?.messageHe || (status === 500 ? 'שגיאה ביומן הטיסות' : err?.message) || 'שגיאה';
  res.status(status).json({ ok: false, messageHe });
}

export function registerFlightLogsApi(app, ctx) {
  app.get('/api/flight-logs/status', (_req, res) => {
    res.json(publicFlightLogsStatus(ctx));
  });

  app.post('/api/flight-logs/sync', async (_req, res) => {
    try {
      res.json(await syncFlightLogs(ctx, { reason: 'manual' }));
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights', (req, res) => {
    try {
      res.json(listFlightLogs(ctx, req.query || {}));
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights/:uid', async (req, res) => {
    try {
      const bundle = await openFlightBundle(ctx, req.params.uid);
      if (!bundle) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      res.json({ ok: true, ...bundle });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights/:uid/events', async (req, res) => {
    try {
      const bundle = await openFlightBundle(ctx, req.params.uid);
      if (!bundle) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      res.json({ ok: true, events: listEvents(ctx, req.params.uid, req.query || {}) });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights/:uid/series', async (req, res) => {
    try {
      const bundle = await openFlightBundle(ctx, req.params.uid);
      if (!bundle) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      if (!bundle.series) {
        return res.json({ ok: true, missing: true, messageHe: NO_SERIES_HE, series: null });
      }
      res.json({ ok: true, missing: false, ...bundle.series });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights/:uid/track', async (req, res) => {
    try {
      const bundle = await openFlightBundle(ctx, req.params.uid);
      if (!bundle) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      if (!bundle.track) return res.json({ ok: true, missing: true, messageHe: 'אין נתוני מסלול', track: null });
      res.json({ ok: true, missing: false, track: bundle.track });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights/:uid/artifacts/*', async (req, res) => {
    try {
      const name = req.params[0];
      const file = await readFlightArtifact(ctx, req.params.uid, name);
      if (!file) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      const filename = path.basename(file.filename).replace(/["\r\n]/g, '');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(file.bytes);
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/flight-logs/flights/:uid/debrief', async (req, res) => {
    try {
      const payload = await getFlightDebrief(ctx, req.params.uid);
      if (!payload) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      res.json(payload);
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/flight-logs/flights/:uid/debrief', async (req, res) => {
    try {
      const payload = await getFlightDebrief(ctx, req.params.uid, { force: Boolean(req.body?.force) });
      if (!payload) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      res.json(payload);
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.patch('/api/flight-logs/flights/:uid', (req, res) => {
    try {
      const flight = patchFlightOverlay(ctx, req.params.uid, req.body || {});
      if (!flight) return res.status(404).json({ ok: false, messageHe: 'הטיסה לא נמצאה' });
      res.json({ ok: true, flight });
    } catch (err) {
      sendErr(res, err);
    }
  });
}
