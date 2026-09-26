/**
 * NEW thin proxy: browser → localhost:4010 /api/jetson/v1/* → Companion API v1.
 * Does not expose ARM / DISARM / SET_MODE / LAND / UART / systemd / GStreamer / policy apply.
 */

import { CompanionApiError } from '../companion-api-client.mjs';
import { COMPANION_PROXY_PREFIX, COMPANION_V1_FORBIDDEN } from '../companion-v1-paths.mjs';
import { sanitizeRuntimeConfigPatch } from '../companion-display.mjs';

function sendCompanionError(res, err) {
  if (err instanceof CompanionApiError) {
    const status =
      err.kind === 'timeout' ? 504
      : err.kind === 'parse' ? 502
      : err.kind === 'http' ? (err.status || 502)
      : 503;
    return res.status(status).json({
      ok: false,
      lane: 'NEW',
      code: `companion_${err.kind}`,
      message: err.message,
      status,
      ...(err.body && typeof err.body === 'object' ? { details: err.body } : {}),
    });
  }
  return res.status(503).json({
    ok: false,
    lane: 'NEW',
    code: 'companion_error',
    message: err?.message || 'Companion proxy failed',
  });
}

async function runClient(res, fn) {
  try {
    const data = await fn();
    return res.json({ ok: true, lane: 'NEW', data });
  } catch (err) {
    return sendCompanionError(res, err);
  }
}

/**
 * @param {import('express').Application} app
 * @param {object} ctx
 */
export function registerCompanionProxyApi(app, ctx) {
  const prefix = COMPANION_PROXY_PREFIX;

  function getClient() {
    return ctx.companionService?.client || ctx.companionClient || null;
  }

  app.get(`${prefix}`, (_req, res) => {
    const desc = ctx.companionService?.describe?.() || { lane: 'NEW', mode: 'off', api: 'v1' };
    res.json({ ok: true, ...desc, forbidden: [...COMPANION_V1_FORBIDDEN] });
  });

  app.use(prefix, (req, res, next) => {
    if (!getClient()) {
      return res.status(503).json({
        ok: false,
        lane: 'NEW',
        code: 'companion_disabled',
        message: 'Companion API client is off — set COMPANION_MODE=mock|real and JETSON_COMPANION_BASE_URL for real',
      });
    }
    return next();
  });

  app.get(`${prefix}/health`, (_req, res) => runClient(res, () => getClient().getHealth()));
  app.get(`${prefix}/version`, (_req, res) => runClient(res, () => getClient().getVersion()));
  app.get(`${prefix}/status`, (_req, res) => runClient(res, () => getClient().getStatus()));
  app.get(`${prefix}/status/system`, (_req, res) => runClient(res, () => getClient().getStatusSystem()));
  app.get(`${prefix}/status/fc`, (_req, res) => runClient(res, () => getClient().getStatusFc()));
  app.get(`${prefix}/network/uplinks`, (_req, res) => runClient(res, () => getClient().getNetworkUplinks()));
  app.post(`${prefix}/network/uplinks/:link`, (req, res) => {
    const link = String(req.params.link || '').trim().toLowerCase();
    if (link !== 'wifi' && link !== 'cellular') {
      return res.status(400).json({ ok: false, lane: 'NEW', reason: 'bad_link', message: 'קישור לא מוכר' });
    }
    return runClient(res, () => getClient().setNetworkUplink(link, req.body || {}));
  });
  app.get(`${prefix}/status/mavlink`, (_req, res) => runClient(res, () => getClient().getStatusMavlink()));
  app.get(`${prefix}/status/channels`, (_req, res) => runClient(res, () => getClient().getStatusChannels()));
  app.get(`${prefix}/status/vision`, (_req, res) => runClient(res, () => getClient().getStatusVision()));
  app.get(`${prefix}/status/cameras`, (_req, res) => runClient(res, () => getClient().getStatusCameras()));
  app.get(`${prefix}/status/gimbal`, (_req, res) => runClient(res, () => getClient().getStatusGimbal()));

  async function sendCameraFrame(req, res) {
    try {
      const frame = await getClient().getCameraFrame(req.params.id);
      if (!frame?.bytes?.length) {
        return res.status(404).json({ ok: false, lane: 'NEW', reason: 'no_frame', message: 'אין פריים' });
      }
      res.set('Content-Type', frame.contentType || 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.send(frame.bytes);
    } catch (err) {
      return sendCompanionError(res, err);
    }
  }
  app.get(`${prefix}/cameras/:id/frame`, sendCameraFrame);
  app.get(`${prefix}/cameras/:id/frame.jpg`, sendCameraFrame);
  app.get(`${prefix}/cam0/status`, (_req, res) => runClient(res, () => getClient().getCam0Status()));
  app.get(`${prefix}/cam0/health`, (_req, res) => runClient(res, () => getClient().getCam0Health()));
  app.get(`${prefix}/cam0/settings`, (_req, res) => runClient(res, () => getClient().getCam0Settings()));
  app.post(`${prefix}/cam0/settings`, (req, res) => runClient(res, () => getClient().postCam0Settings(req.body || {})));
  app.get(`${prefix}/cam0/detections`, (_req, res) => runClient(res, () => getClient().getCam0Detections()));
  app.get(`${prefix}/cam0/modules`, (_req, res) => runClient(res, () => getClient().getCam0Modules()));
  app.post(`${prefix}/cam0/modules/:name`, (req, res) => runClient(res, () => getClient().postCam0Module(req.params.name, req.body || {})));
  app.get(`${prefix}/cam0/calibration`, (_req, res) => runClient(res, () => getClient().getCam0Calibration()));
  app.post(`${prefix}/cam0/calibration/capture`, (req, res) => runClient(res, () => getClient().postCam0CalibrationCapture(req.body || {})));
  app.post(`${prefix}/cam0/calibration/solve`, (_req, res) => runClient(res, () => getClient().postCam0CalibrationSolve()));
  app.post(`${prefix}/cam0/record/start`, (req, res) => runClient(res, () => getClient().postCam0RecordStart(req.body || {})));
  app.post(`${prefix}/cam0/record/stop`, (_req, res) => runClient(res, () => getClient().postCam0RecordStop()));
  app.get(`${prefix}/cam0/recordings`, (_req, res) => runClient(res, () => getClient().getCam0Recordings()));
  app.get(`${prefix}/cam0/recordings/:id`, (req, res) => runClient(res, () => getClient().getCam0Recording(req.params.id)));
  app.get(`${prefix}/cam0/recordings/:id/frame.jpg`, async (req, res) => {
    try {
      const frame = await getClient().getCam0RecordingFrame(req.params.id, req.query.i);
      if (!frame?.bytes?.length) {
        return res.status(404).json({ ok: false, lane: 'NEW', reason: 'no_frame', message: 'אין אות' });
      }
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      return res.send(frame.bytes);
    } catch (err) {
      return sendCompanionError(res, err);
    }
  });
  app.get(`${prefix}/cam1/status`, (_req, res) => runClient(res, () => getClient().getCam1Status()));
  app.get(`${prefix}/cam1/health`, (_req, res) => runClient(res, () => getClient().getCam1Health()));
  app.get(`${prefix}/cam1/settings`, (_req, res) => runClient(res, () => getClient().getCam1Settings()));
  app.post(`${prefix}/cam1/settings`, (req, res) => runClient(res, () => getClient().postCam1Settings(req.body || {})));
  app.get(`${prefix}/cam1/snapshot.png`, async (_req, res) => {
    try {
      const frame = await getClient().getCam1Snapshot();
      if (!frame?.bytes?.length) {
        return res.status(404).json({ ok: false, lane: 'NEW', reason: 'no_frame', message: 'אין אות' });
      }
      res.set('Content-Type', frame.contentType || 'image/png');
      res.set('Cache-Control', 'no-store');
      return res.send(frame.bytes);
    } catch (err) {
      return sendCompanionError(res, err);
    }
  });
  app.get(`${prefix}/cam1/stream.mjpg`, async (req, res) => {
    let upstream = null;
    try {
      upstream = await getClient().openCam1Stream();
      res.writeHead(200, {
        'Content-Type': upstream.contentType || 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      const reader = upstream.body.getReader();
      const abort = () => {
        try { reader.cancel(); } catch { /* closed */ }
        try { upstream.abort(); } catch { /* closed */ }
      };
      req.on('close', abort);
      while (!req.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (err) {
      try { upstream?.abort?.(); } catch { /* closed */ }
      if (!res.headersSent) return sendCompanionError(res, err);
      res.end();
    }
  });
  app.get(`${prefix}/cam0/snapshot.png`, async (req, res) => {
    try {
      const frame = await getClient().getCam0Snapshot();
      if (!frame?.bytes?.length) {
        return res.status(404).json({ ok: false, lane: 'NEW', reason: 'no_frame', message: 'אין אות' });
      }
      res.set('Content-Type', frame.contentType || 'image/png');
      res.set('Cache-Control', 'no-store');
      return res.send(frame.bytes);
    } catch (err) {
      return sendCompanionError(res, err);
    }
  });

  app.post(`${prefix}/gimbal/rate`, (req, res) => runClient(res, () => getClient().postGimbalRate(req.body || {})));
  app.post(`${prefix}/gimbal/angle`, (req, res) => runClient(res, () => getClient().postGimbalAngle(req.body || {})));
  app.post(`${prefix}/gimbal/center`, (req, res) => runClient(res, () => getClient().postGimbalCenter(req.body || {})));
  app.post(`${prefix}/gimbal/zoom`, (req, res) => runClient(res, () => getClient().postGimbalZoom(req.body || {})));
  app.post(`${prefix}/gimbal/mode`, (req, res) => runClient(res, () => getClient().postGimbalMode(req.body || {})));
  app.post(`${prefix}/gimbal/photo`, (req, res) => runClient(res, () => getClient().postGimbalPhoto(req.body || {})));
  app.post(`${prefix}/gimbal/record`, (req, res) => runClient(res, () => getClient().postGimbalRecord(req.body || {})));
  app.get(`${prefix}/vision/result`, (_req, res) => runClient(res, () => getClient().getVisionResult()));
  app.get(`${prefix}/status/navigation`, (_req, res) => runClient(res, () => getClient().getStatusNavigation()));
  app.get(`${prefix}/navigation/estimate`, (_req, res) => runClient(res, () => getClient().getNavigationEstimate()));
  app.get(`${prefix}/status/landing`, (_req, res) => runClient(res, () => getClient().getStatusLanding()));
  app.get(`${prefix}/status/video`, (_req, res) => runClient(res, () => getClient().getStatusVideo()));
  app.get(`${prefix}/diagnostics`, (_req, res) => runClient(res, () => getClient().getDiagnostics()));
  app.get(`${prefix}/maintenance`, (_req, res) => runClient(res, () => getClient().getMaintenance()));
  app.get(`${prefix}/maintenance/releases`, (_req, res) => runClient(res, () => getClient().getMaintenanceReleases()));
  app.get(`${prefix}/maintenance/releases/:id`, (req, res) =>
    runClient(res, () => getClient().getMaintenanceRelease(req.params.id)),
  );
  app.get(`${prefix}/maintenance/backups`, (_req, res) => runClient(res, () => getClient().getMaintenanceBackups()));
  app.get(`${prefix}/maintenance/audit`, (_req, res) => runClient(res, () => getClient().getMaintenanceAudit()));
  app.post(`${prefix}/maintenance/backup`, (_req, res) => runClient(res, () => getClient().postMaintenanceBackup()));
  app.post(`${prefix}/maintenance/deploy`, (req, res) =>
    runClient(res, () => getClient().postMaintenanceDeploy(req.body || {})),
  );
  app.post(`${prefix}/maintenance/rollback`, (_req, res) => runClient(res, () => getClient().postMaintenanceRollback()));
  app.get(`${prefix}/config`, (_req, res) => runClient(res, () => getClient().getConfig()));
  app.get(`${prefix}/policy`, (_req, res) => runClient(res, () => getClient().getPolicy()));
  app.get(`${prefix}/policy/preview`, (_req, res) => runClient(res, () => getClient().getPolicyPreview()));
  app.get(`${prefix}/_console/mock-scenario`, (_req, res) => {
    const desc = ctx.companionService?.describe?.() || {};
    if (desc.mode !== 'mock') {
      return res.status(404).json({ ok: false, lane: 'NEW', code: 'companion_mock_only' });
    }
    res.json({ ok: true, lane: 'NEW', scenario: desc.mockScenario || 'healthy' });
  });
  app.put(`${prefix}/_console/mock-scenario`, async (req, res) => {
    const desc = ctx.companionService?.describe?.() || {};
    if (desc.mode !== 'mock') {
      return res.status(404).json({ ok: false, lane: 'NEW', code: 'companion_mock_only' });
    }
    const next = String(req.body?.scenario || '').trim().toLowerCase();
    try {
      await ctx.companionService.setMockScenario(next);
      res.json({ ok: true, lane: 'NEW', scenario: ctx.companionService.client?.scenario || next });
    } catch (err) {
      res.status(400).json({ ok: false, lane: 'NEW', code: 'companion_mock_scenario', message: err?.message || 'bad scenario' });
    }
  });
  app.get(`${prefix}/events`, (_req, res) => {
    const url = getClient().eventsUrl?.();
    res.json({
      ok: true,
      lane: 'NEW',
      note: 'Browser stays on GET /api/stream. Jetson /events is consumed by the Node bridge.',
      eventsUrl: url,
    });
  });
  app.get(`${prefix}/ws`, (_req, res) => {
    res.json({
      ok: true,
      lane: 'NEW',
      note: 'WebSocket is Node-side only. Browser uses EventSource /api/stream.',
      wsUrl: getClient().wsUrl?.(),
    });
  });

  app.patch(`${prefix}/config/runtime`, (req, res) =>
    runClient(res, () => getClient().patchConfigRuntime(sanitizeRuntimeConfigPatch(req.body || {}))),
  );
  app.put(`${prefix}/policy`, (req, res) =>
    runClient(res, () => getClient().putPolicy(req.body || {})),
  );

  const rejectForbidden = (_req, res) => {
    res.status(404).json({
      ok: false,
      lane: 'NEW',
      code: 'companion_forbidden',
      message: 'Not in Companion API v1',
      forbidden: [...COMPANION_V1_FORBIDDEN],
    });
  };
  for (const verb of ['get', 'post', 'put', 'patch']) {
    app[verb](`${prefix}/arm`, rejectForbidden);
    app[verb](`${prefix}/disarm`, rejectForbidden);
    app[verb](`${prefix}/set-mode`, rejectForbidden);
    app[verb](`${prefix}/land`, rejectForbidden);
    app[verb](`${prefix}/command-long`, rejectForbidden);
    app[verb](`${prefix}/policy/apply`, rejectForbidden);
    app[verb](`${prefix}/config/apply`, rejectForbidden);
    app[verb](`${prefix}/config/restart`, rejectForbidden);
    app[verb](`${prefix}/config/runtime/apply`, rejectForbidden);
    app[verb](`${prefix}/config/runtime/restart`, rejectForbidden);
  }
}
