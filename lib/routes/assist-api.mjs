import { createAssistService } from '../assist/assist-service.mjs';
import { ASSIST_INTENTS, ASSIST_ACTION_TYPES, ASSIST_PROHIBITED_ACTIONS } from '../assist/assist-types.mjs';
import { ASSIST_ROUTES } from '../assist/assist-routes.mjs';
import { resolveDevelopmentRuntime } from '../development-runtime.mjs';
import { logger } from '../logger.mjs';

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
