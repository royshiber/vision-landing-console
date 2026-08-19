/**
 * NEW thin proxy: browser → localhost:4010 /api/jetson/v1/* → Companion API v1.
 * Does not expose ARM / DISARM / SET_MODE / LAND / UART / systemd / GStreamer / policy apply.
 */

import { CompanionApiError } from '../companion-api-client.mjs';
import { COMPANION_PROXY_PREFIX, COMPANION_V1_FORBIDDEN } from '../companion-v1-paths.mjs';

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
  app.get(`${prefix}/status/mavlink`, (_req, res) => runClient(res, () => getClient().getStatusMavlink()));
  app.get(`${prefix}/status/channels`, (_req, res) => runClient(res, () => getClient().getStatusChannels()));
  app.get(`${prefix}/status/vision`, (_req, res) => runClient(res, () => getClient().getStatusVision()));
  app.get(`${prefix}/vision/result`, (_req, res) => runClient(res, () => getClient().getVisionResult()));
  app.get(`${prefix}/status/navigation`, (_req, res) => runClient(res, () => getClient().getStatusNavigation()));
  app.get(`${prefix}/navigation/estimate`, (_req, res) => runClient(res, () => getClient().getNavigationEstimate()));
  app.get(`${prefix}/status/landing`, (_req, res) => runClient(res, () => getClient().getStatusLanding()));
  app.get(`${prefix}/status/video`, (_req, res) => runClient(res, () => getClient().getStatusVideo()));
  app.get(`${prefix}/diagnostics`, (_req, res) => runClient(res, () => getClient().getDiagnostics()));
  app.get(`${prefix}/maintenance`, (_req, res) => runClient(res, () => getClient().getMaintenance()));
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
    runClient(res, () => getClient().patchConfigRuntime(req.body || {})),
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
  }
}
