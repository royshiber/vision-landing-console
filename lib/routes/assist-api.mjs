import { createAssistService } from '../assist/assist-service.mjs';
import { ASSIST_INTENTS, ASSIST_ACTION_TYPES, ASSIST_PROHIBITED_ACTIONS } from '../assist/assist-types.mjs';
import { ASSIST_ROUTES } from '../assist/assist-routes.mjs';
import { ASSIST_HE } from '../assist/assist-hebrew.mjs';
import { resolveDevelopmentRuntime, rebuildDevelopmentAgentProvider, agentEnvForStatus } from '../development-runtime.mjs';
import {
  buildPublicAgentConnectionStatus,
  readStoredConnection,
  secretsFromConnection,
  validateConnectionKey,
  writeStoredConnection,
} from '../coding-agent-connection.mjs';
import { logger } from '../logger.mjs';

async function publicStatus(ctx, runtime) {
  return buildPublicAgentConnectionStatus({
    provider: runtime.provider,
    db: ctx.db || null,
    env: agentEnvForStatus(ctx),
  });
}

function logAgentEvent(fields, message) {
  logger.info({
    runtime: fields?.runtime || null,
    connected: fields?.connected === true,
    persisted: fields?.persisted === true,
    live_applied: fields?.live_applied === true,
  }, message);
}

export function registerAssistApi(app, ctx = {}) {
  if (!ctx.repoRoot) ctx.repoRoot = process.cwd();
  const runtime = resolveDevelopmentRuntime(ctx);
  const assist = ctx.assistService || createAssistService({
    repoRoot: runtime.repoRoot,
    developmentTaskStore: runtime.store,
    codingAgentProvider: runtime.provider,
    worktreeManager: runtime.worktreeManager,
    developmentAgentService: runtime.agentService,
    persistence: ctx.assistPersistence || null,
  });

  app.get('/api/assist/meta', (_req, res) => {
    res.json({
      ok: true,
      intents: ASSIST_INTENTS,
      actions: ASSIST_ACTION_TYPES,
      prohibited: ASSIST_PROHIBITED_ACTIONS,
      routes: ASSIST_ROUTES.map((r) => ({
        id: r.id,
        workspace: r.workspace,
        capability: r.capability,
        tab: r.tab,
        subtab: r.subtab || null,
        description: r.description,
      })),
      channels: ['text', 'voice'],
      note: 'Voice channel accepted on the same pipeline; STT not implemented in C10.2.',
    });
  });

  app.get('/api/assist/session', (_req, res) => {
    res.json({ ok: true, session: assist.getSession() });
  });

  app.delete('/api/assist/session', (_req, res) => {
    assist.clearSession();
    res.json({ ok: true });
  });

  app.get('/api/assist/agent', async (_req, res) => {
    try {
      res.json(await publicStatus(ctx, runtime));
    } catch (err) {
      logger.error({ err: { message: String(err?.message || 'agent status failed') } }, 'GET /api/assist/agent failed');
      res.status(500).json({
        ok: false,
        runtime: 'UNAVAILABLE',
        connected: false,
        status_he: ASSIST_HE.agentUnavailable,
        connect_available: true,
        disconnect_available: false,
      });
    }
  });

  app.post('/api/assist/agent/connect', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const submitted = body.key || body.connection_key || body.apiKey || '';
    const validated = validateConnectionKey(submitted);
    if (!validated.ok) {
      return res.status(400).json({
        ok: false,
        error: validated.error,
        runtime: 'UNAVAILABLE',
        connected: false,
        status_he: validated.status_he,
        reason_he: validated.status_he,
        key_hint: null,
        connect_available: true,
        disconnect_available: false,
        live_applied: true,
      });
    }

    const env = agentEnvForStatus(ctx);
    const secrets = secretsFromConnection({ env, key: validated.key });
    try {
      runtime.ignoreEnvConnection = false;
      const persist = writeStoredConnection(ctx.db || null, validated.key);
      const stored = readStoredConnection(ctx.db || null);
      if (!ctx.db) {
        stored.connected = true;
        stored.apiKey = validated.key;
      }
      rebuildDevelopmentAgentProvider(ctx, stored);
      const status = await publicStatus(ctx, runtime);
      if (status.runtime !== 'READY') {
        writeStoredConnection(ctx.db || null, null);
        rebuildDevelopmentAgentProvider(ctx, readStoredConnection(ctx.db || null));
        const rolled = await publicStatus(ctx, runtime);
        logAgentEvent({ runtime: 'UNAVAILABLE', live_applied: true }, 'assist agent connect failed');
        return res.status(400).json({
          ...rolled,
          ok: false,
          error: 'connect_failed',
          status_he: ASSIST_HE.agentConnectFailed,
          reason_he: rolled.reason_he || ASSIST_HE.agentConnectFailed,
          connect_available: true,
          disconnect_available: false,
        });
      }
      logAgentEvent({ ...status, persisted: persist.persisted }, 'assist agent connected');
      res.json({
        ...status,
        persisted: persist.persisted,
        live_applied: true,
      });
    } catch (err) {
      logger.error({ err: { message: String(err?.message || 'connect failed') } }, 'POST /api/assist/agent/connect failed');
      if (secrets.some((s) => String(err?.message || '').includes(s))) {
        return res.status(500).json({
          ok: false,
          error: 'connect_failed',
          runtime: 'UNAVAILABLE',
          connected: false,
          status_he: ASSIST_HE.agentConnectFailed,
          reason_he: ASSIST_HE.agentConnectFailed,
          connect_available: true,
          disconnect_available: false,
        });
      }
      res.status(500).json({
        ok: false,
        error: 'connect_failed',
        runtime: 'UNAVAILABLE',
        connected: false,
        status_he: ASSIST_HE.agentConnectFailed,
        reason_he: ASSIST_HE.agentConnectFailed,
        connect_available: true,
        disconnect_available: false,
      });
    }
  });

  app.post('/api/assist/agent/disconnect', async (_req, res) => {
    try {
      writeStoredConnection(ctx.db || null, null);
      runtime.ignoreEnvConnection = true;
      rebuildDevelopmentAgentProvider(ctx, { connected: false, apiKey: null });
      const status = await publicStatus(ctx, runtime);
      logAgentEvent({ runtime: 'UNAVAILABLE', live_applied: true }, 'assist agent disconnected');
      res.json({
        ...status,
        runtime: 'UNAVAILABLE',
        connected: false,
        status_he: ASSIST_HE.agentDisconnected,
        reason_he: ASSIST_HE.agentDisconnected,
        key_hint: null,
        connect_available: true,
        disconnect_available: false,
        live_applied: true,
      });
    } catch (err) {
      logger.error({ err: { message: String(err?.message || 'disconnect failed') } }, 'POST /api/assist/agent/disconnect failed');
      res.status(500).json({
        ok: false,
        runtime: 'UNAVAILABLE',
        connected: false,
        status_he: ASSIST_HE.agentConnectFailed,
        connect_available: true,
        disconnect_available: false,
      });
    }
  });

  app.get('/api/assist/tasks/:id', async (req, res) => {
    try {
      const result = await assist.getTaskRunStatus(req.params.id);
      if (!result.ok && result.error === 'task_not_found') {
        return res.status(404).json(result);
      }
      if (!result.ok) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'GET /api/assist/tasks/:id failed');
      res.status(500).json({ ok: false, message: String(err?.message || 'assist status failed') });
    }
  });

  app.post('/api/assist/message', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const text = String(body.text || body.message || '').trim();
      if (!text) {
        return res.status(400).json({ ok: false, message: 'text required' });
      }
      const channel = body.channel === 'voice' ? 'voice' : 'text';
      const context_snapshot = body.context && typeof body.context === 'object' ? body.context : {};
      const response = await assist.processInput({ text, channel, context_snapshot });
      res.json({ ok: true, response });
    } catch (err) {
      logger.error({ err }, 'POST /api/assist/message failed');
      res.status(500).json({ ok: false, message: String(err?.message || 'assist failed') });
    }
  });

  app.post('/api/assist/confirm', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const proposal_id = String(body.proposal_id || body.proposalId || '').trim();
      if (!proposal_id) {
        return res.status(400).json({ ok: false, message: 'proposal_id required' });
      }
      const confirm = body.confirm !== false && body.cancel !== true;
      const result = await assist.confirmProposal({ proposal_id, confirm });
      if (!result.ok && result.error === 'proposal_not_found_or_expired') {
        return res.status(404).json(result);
      }
      if (!result.ok) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'POST /api/assist/confirm failed');
      res.status(500).json({ ok: false, message: String(err?.message || 'confirm failed') });
    }
  });
}
