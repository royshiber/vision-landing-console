import { createCompanionApiClient, CompanionApiError } from '../companion-api-client.mjs';
import {
  COMPANION_HE,
  buildPublicCompanionConnectionStatus,
  companionEnvForService,
  hebrewCompanionError,
  readStoredCompanionConnection,
  secretsFromCompanionConnection,
  snapshotCompanionEnv,
  validateCompanionBaseUrl,
  writeStoredCompanionConnection,
} from '../companion-connection.mjs';
import { payloadContainsSecret } from '../coding-agent-connection.mjs';
import { logger } from '../logger.mjs';

function publicStatus(ctx) {
  return buildPublicCompanionConnectionStatus({
    service: ctx.companionService,
    db: ctx.db || null,
    env: ctx.companionEnv || snapshotCompanionEnv(process.env),
  });
}

function failBody(statusHe, extra = {}) {
  return {
    ok: false,
    mode: extra.mode || 'off',
    connected: false,
    reachable: false,
    status_he: statusHe,
    reason_he: extra.reason_he || statusHe,
    token_hint: null,
    base_url: extra.base_url || null,
    connect_available: true,
    disconnect_available: false,
    live_applied: true,
    error: extra.error || 'connect_failed',
    hint_he: COMPANION_HE.hint,
    path_hint: '/api/v1/*',
  };
}

function applyLiveEnv(ctx, stored) {
  const env = companionEnvForService(ctx, stored);
  const service = ctx.companionService;
  if (service && typeof service.applyEnv === 'function') {
    return service.applyEnv(env);
  }
  return undefined;
}

async function startLive(ctx) {
  const service = ctx.companionService;
  if (service && typeof service.start === 'function') {
    await service.start();
  }
}

function logSafe(fields, message) {
  logger.info({
    mode: fields?.mode || null,
    connected: fields?.connected === true,
    persisted: fields?.persisted === true,
    live_applied: fields?.live_applied === true,
  }, message);
}

export function registerCompanionConnectionApi(app, ctx = {}) {
  if (!ctx.companionEnv) ctx.companionEnv = snapshotCompanionEnv(process.env);

  app.get('/api/companion/connection', (_req, res) => {
    try {
      res.json(publicStatus(ctx));
    } catch (err) {
      logger.error({ err: { message: String(err?.message || 'status failed') } }, 'GET /api/companion/connection failed');
      res.status(500).json(failBody(COMPANION_HE.connectFailed, { error: 'status_failed' }));
    }
  });

  app.post('/api/companion/connection/connect', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const validated = validateCompanionBaseUrl(body.base_url || body.baseUrl || body.url || '');
    if (!validated.ok) {
      return res.status(400).json(failBody(validated.status_he, { error: validated.error }));
    }
    const token = String(body.token || body.companion_token || '').trim();
    const secrets = secretsFromCompanionConnection({
      env: ctx.companionEnv,
      token,
    });
    const probeEnv = {
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: validated.url,
      ...(token
        ? {
            JETSON_COMPANION_TOKEN: token,
            COMPANION_SHARED_SECRET: token,
          }
        : {}),
    };
    try {
      ctx.ignoreEnvCompanionReal = false;
      const client = createCompanionApiClient({
        baseUrl: validated.url,
        env: probeEnv,
        fetchImpl: ctx.companionFetchImpl,
        timeoutMs: ctx.companionTimeoutMs,
      });
      await client.getHealth();
      const persist = writeStoredCompanionConnection(ctx.db || null, {
        connected: true,
        mode: 'real',
        baseUrl: validated.url,
        token,
      });
      const stored = readStoredCompanionConnection(ctx.db || null);
      if (!ctx.db) {
        stored.connected = true;
        stored.mode = 'real';
        stored.baseUrl = validated.url;
        stored.token = token || null;
      }
      await applyLiveEnv(ctx, stored);
      await startLive(ctx);
      const status = publicStatus(ctx);
      if (status.mode !== 'real') {
        writeStoredCompanionConnection(ctx.db || null, { connected: false, baseUrl: validated.url, token: null });
        ctx.ignoreEnvCompanionReal = true;
        await applyLiveEnv(ctx, readStoredCompanionConnection(ctx.db || null));
        logSafe({ mode: 'off', live_applied: true }, 'companion connect rejected by BOTH gate');
        return res.status(400).json(failBody(COMPANION_HE.connectFailed, { error: 'both_gate', base_url: validated.url }));
      }
      const payload = { ...status, persisted: persist.persisted, live_applied: true };
      if (payloadContainsSecret(payload, secrets)) {
        payload.token_hint = maskSafeHint(payload.token_hint);
      }
      logSafe({ ...payload, persisted: persist.persisted }, 'companion connected');
      res.json(payload);
    } catch (err) {
      const statusHe = hebrewCompanionError(err);
      const errorCode = err instanceof CompanionApiError
        ? (err.kind === 'http' && err.status === 401 ? 'unauthorized' : err.kind)
        : 'connect_failed';
      const httpStatus = err instanceof CompanionApiError && err.kind === 'http' && err.status === 401
        ? 401
        : err instanceof CompanionApiError && err.kind === 'timeout'
          ? 504
          : 400;
      logger.warn({ kind: err?.kind || null, status: err?.status || null }, 'POST /api/companion/connection/connect failed');
      res.status(httpStatus).json(failBody(statusHe, {
        error: errorCode,
        base_url: validated.url,
      }));
    }
  });

  app.post('/api/companion/connection/disconnect', async (_req, res) => {
    try {
      const previous = readStoredCompanionConnection(ctx.db || null);
      writeStoredCompanionConnection(ctx.db || null, {
        connected: false,
        mode: 'off',
        baseUrl: previous.baseUrl,
        token: null,
      });
      ctx.ignoreEnvCompanionReal = true;
      await applyLiveEnv(ctx, readStoredCompanionConnection(ctx.db || null));
      await startLive(ctx);
      const status = publicStatus(ctx);
      logSafe({ mode: status.mode, live_applied: true }, 'companion disconnected');
      res.json({
        ...status,
        connected: false,
        disconnect_available: false,
        connect_available: true,
        token_hint: null,
        status_he: status.mode === 'mock' ? COMPANION_HE.mock : COMPANION_HE.disconnected,
        live_applied: true,
      });
    } catch (err) {
      logger.error({ err: { message: String(err?.message || 'disconnect failed') } }, 'POST /api/companion/connection/disconnect failed');
      res.status(500).json(failBody(COMPANION_HE.connectFailed, { error: 'disconnect_failed' }));
    }
  });
}

function maskSafeHint(hint) {
  const s = String(hint || '').trim();
  return s ? '••••' : null;
}
