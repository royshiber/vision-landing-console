import { logger } from '../logger.mjs';
import { createDevelopChatEngine } from '../develop-chat.mjs';
import { createFeature } from '../custom-param-store.mjs';
import { resolveDevelopmentRuntime } from '../development-runtime.mjs';

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

async function safePrepareAndStart(agentService, worktreeManager, taskId) {
  if (!taskId) {
    return { started: false, available: false, reason: 'Development agent unavailable' };
  }
  try {
    if (worktreeManager && typeof worktreeManager.create === 'function') {
      const status = typeof worktreeManager.status === 'function' ? worktreeManager.status(taskId) : null;
      if (!status?.exists) worktreeManager.create(taskId);
    }
  } catch (err) {
    return { started: false, available: false, reason: String(err?.message || 'worktree unavailable') };
  }
  if (!agentService || typeof agentService.startTaskAgent !== 'function') {
    return { started: false, available: false, reason: 'Development agent unavailable' };
  }
  try {
    const result = await agentService.startTaskAgent(taskId);
    return { started: true, available: true, reason: null, result };
  } catch (err) {
    const msg = String(err?.message || 'Development agent unavailable');
    return { started: false, available: false, reason: msg };
  }
}

/**
 * Develop Concept B chat API. Builds on the existing isolated-branch agent
 * when present; stubs cleanly otherwise. Human Gates never apply.
 */
export function registerDevelopChatApi(app, ctx = {}) {
  const engine = ctx.developChatEngine || createDevelopChatEngine();
  const runtime = ctx.skipRuntime ? null : resolveDevelopmentRuntime(ctx);
  const store = ctx.developmentTaskStore || runtime?.store || null;
  const agentService = ctx.developmentAgentService || runtime?.agentService || null;
  const worktreeManager = ctx.worktreeManager || runtime?.worktreeManager || null;

  app.post('/api/develop/chat', (req, res) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      const choiceId = String(req.body?.choiceId ?? '').trim();
      const sessionId = String(req.body?.sessionId ?? req.body?.id ?? '').trim();
      if (!text && !choiceId) return jsonError(res, 400, 'חסרה הודעה');
      const session = engine.turn(sessionId || null, { text, choiceId });
      res.json({ ok: true, session });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg === 'חסרה הודעה' || msg === 'בחירה לא מוכרת') return jsonError(res, 400, msg);
      if (msg === 'שיחה לא נמצאה') return jsonError(res, 404, msg);
      logger.error({ err }, 'POST /api/develop/chat failed');
      res.status(500).json({ ok: false, message: msg || 'שגיאת שיחה' });
    }
  });

  app.get('/api/develop/chat/:id', (req, res) => {
    const session = engine.get(req.params.id);
    if (!session) return jsonError(res, 404, 'שיחה לא נמצאה');
    res.json({ ok: true, session });
  });

  app.post('/api/develop/chat/:id/build', async (req, res) => {
    try {
      const existing = engine.get(req.params.id);
      if (!existing) return jsonError(res, 404, 'שיחה לא נמצאה');
      if (existing.phase === 'clarify' || existing.phase === 'idle') {
        return jsonError(res, 409, 'עדיין חסרות תשובות');
      }

      engine.markBuilding(req.params.id);

      let task = null;
      if (store && typeof store.create === 'function') {
        task = store.create({
          title: existing.title || 'יכולת חדשה',
          description: existing.description || existing.title,
          taxonomy: existing.taxonomy || 'FEATURE',
          target_area: existing.target_area || 'OTHER',
          priority: existing.priority || 'HIGH',
          notes: 'Develop Concept B',
        });
      }

      const agent = await safePrepareAndStart(agentService, worktreeManager, task?.id);

      let featureId = null;
      const params = existing.params?.length ? existing.params : undefined;
      if (ctx.db && typeof createFeature === 'function') {
        try {
          featureId = createFeature(ctx.db, {
            name: existing.title || 'Develop capability',
            description: existing.description || existing.title || '',
            cpp_code: '// preview stub — isolated branch owns the real change',
            params: params || [
              {
                key: 'CAP_ENABLE',
                type: 'INT8',
                default_value: 0,
                description: 'Enable the new capability',
                description_he: 'הפעלת היכולת החדשה',
                units: 'bool',
                min_val: 0,
                max_val: 1,
              },
            ],
            conversation: existing.messages,
          });
        } catch (err) {
          logger.warn({ err }, 'develop-chat: custom param hook skipped');
        }
      }

      const session = engine.markReady(req.params.id, {
        taskId: task?.id || null,
        featureId,
        agent,
        landed: Boolean(task?.id || featureId),
      });
      res.json({
        ok: true,
        session,
        task: task || null,
        applied: false,
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg === 'שיחה לא נמצאה') return jsonError(res, 404, msg);
      logger.error({ err }, 'POST /api/develop/chat/:id/build failed');
      res.status(500).json({ ok: false, message: msg || 'בנייה נכשלה' });
    }
  });

  app.post('/api/develop/chat/:id/gate', (req, res) => {
    try {
      const gateId = String(req.body?.gateId ?? '').trim();
      if (!gateId) return jsonError(res, 400, 'חסר שער');
      const session = engine.approveGate(req.params.id, gateId);
      res.json({
        ok: true,
        session,
        applied: false,
        autoApply: false,
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg === 'שיחה לא נמצאה') return jsonError(res, 404, msg);
      if (msg === 'שער לא מוכר' || msg === 'השער עדיין כבוי') return jsonError(res, 409, msg);
      logger.error({ err }, 'POST /api/develop/chat/:id/gate failed');
      res.status(500).json({ ok: false, message: msg || 'שער נכשל' });
    }
  });
}
