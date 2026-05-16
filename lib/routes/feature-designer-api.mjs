import { generateFeature, chatWithFeature } from '../feature-designer.mjs';
import {
  listFeatures,
  getFeature,
  createFeature,
  updateFeature,
  setFeatureStatus,
  deleteFeature,
  setCustomParamValue,
  getActiveCustomParams,
} from '../custom-param-store.mjs';
import { logger } from '../logger.mjs';

/**
 * Why: all Feature Designer HTTP routes live here so http-register.mjs stays thin
 * and param-kb / search injection can import custom-param-store independently.
 *
 * @param {import('express').Application} app
 * @param {{ db: import('better-sqlite3').Database }} ctx
 */
export function registerFeatureDesignerApi(app, ctx) {
  const { db } = ctx;

  // ── List ──────────────────────────────────────────────────────────────────

  app.get('/api/feature-designer', (_req, res) => {
    try {
      res.json({ ok: true, features: listFeatures(db) });
    } catch (err) {
      logger.error({ err }, 'GET /api/feature-designer failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── Active params (for smart-search / form injection from the client) ─────

  app.get('/api/feature-designer/active-params', (_req, res) => {
    try {
      res.json({ ok: true, params: getActiveCustomParams(db) });
    } catch (err) {
      logger.error({ err }, 'GET /api/feature-designer/active-params failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── Create (triggers AI generation) ──────────────────────────────────────

  app.post('/api/feature-designer/create', async (req, res) => {
    const description = String(req.body?.description ?? '').trim();
    if (!description) {
      return res.status(400).json({ ok: false, message: "חסר תיאור פיצ'ר" });
    }
    try {
      const generated = await generateFeature(description, []);
      const conversation = [
        { role: 'user', content: description },
        {
          role: 'assistant',
          content: `יצרתי את "${generated.feature_name}" עם ${generated.params.length} פרמטרים.`,
        },
      ];
      const featureId = createFeature(db, {
        name: generated.feature_name,
        description: generated.description || description,
        cpp_code: generated.cpp_code || '',
        params: generated.params,
        conversation,
      });
      const feature = getFeature(db, featureId);
      res.json({ ok: true, feature });
    } catch (err) {
      logger.error({ err }, 'POST /api/feature-designer/create failed');
      res.status(500).json({ ok: false, message: err.message || "שגיאה ביצירת פיצ'ר" });
    }
  });

  // ── Get one feature with code + params ───────────────────────────────────

  app.get('/api/feature-designer/:id', (req, res) => {
    try {
      const feature = getFeature(db, Number(req.params.id));
      if (!feature) return res.status(404).json({ ok: false, message: "פיצ'ר לא נמצא" });
      res.json({ ok: true, feature });
    } catch (err) {
      logger.error({ err }, 'GET /api/feature-designer/:id failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── Refine existing feature with feedback ─────────────────────────────────

  app.post('/api/feature-designer/:id/refine', async (req, res) => {
    const id = Number(req.params.id);
    const feedback = String(req.body?.feedback ?? '').trim();
    if (!feedback) return res.status(400).json({ ok: false, message: 'חסר פידבק' });

    try {
      const feature = getFeature(db, id);
      if (!feature) return res.status(404).json({ ok: false, message: "פיצ'ר לא נמצא" });

      const history = Array.isArray(feature.conversation) ? feature.conversation : [];

      // Provide the current code as the last assistant turn so Gemini has full context
      const fullHistory = [
        ...history,
        { role: 'assistant', content: feature.cpp_code || '' },
      ];

      const generated = await generateFeature(feedback, fullHistory);

      const newConversation = [
        ...history,
        { role: 'user', content: feedback },
        {
          role: 'assistant',
          content: `עדכנתי את "${generated.feature_name}" — ${generated.params.length} פרמטרים.`,
        },
      ];

      updateFeature(db, id, {
        name: generated.feature_name,
        description: generated.description || feature.description,
        cpp_code: generated.cpp_code || feature.cpp_code,
        params: generated.params,
        conversation: newConversation,
      });

      res.json({ ok: true, feature: getFeature(db, id) });
    } catch (err) {
      logger.error({ err }, 'POST /api/feature-designer/:id/refine failed');
      res.status(500).json({ ok: false, message: err.message || "שגיאה בעדכון פיצ'ר" });
    }
  });

  // ── Chat: natural language conversation about an existing feature ─────────

  app.post('/api/feature-designer/:id/chat', async (req, res) => {
    const id = Number(req.params.id);
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ ok: false, message: 'חסרה הודעה' });

    try {
      const feature = getFeature(db, id);
      if (!feature) return res.status(404).json({ ok: false, message: "פיצ'ר לא נמצא" });

      const history = Array.isArray(feature.conversation) ? feature.conversation : [];

      const aiResponse = await chatWithFeature(message, feature, history);

      const newConversation = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: aiResponse.message },
      ];

      if (aiResponse.type === 'update' && aiResponse.feature_name && Array.isArray(aiResponse.params)) {
        updateFeature(db, id, {
          name: aiResponse.feature_name,
          description: aiResponse.description || feature.description,
          cpp_code: aiResponse.cpp_code || feature.cpp_code,
          params: aiResponse.params,
          conversation: newConversation,
        });
        return res.json({
          ok: true,
          type: 'update',
          message: aiResponse.message,
          feature: getFeature(db, id),
        });
      }

      // Just a conversational reply — update conversation history only
      updateFeature(db, id, { conversation: newConversation });
      res.json({ ok: true, type: 'chat', message: aiResponse.message });
    } catch (err) {
      logger.error({ err }, 'POST /api/feature-designer/:id/chat failed');
      res.status(500).json({ ok: false, message: err.message || "שגיאה בצ'אט" });
    }
  });

  // ── Patch: change status or name ──────────────────────────────────────────

  app.patch('/api/feature-designer/:id', (req, res) => {
    const id = Number(req.params.id);
    const { status, name } = req.body || {};
    try {
      const feature = getFeature(db, id);
      if (!feature) return res.status(404).json({ ok: false, message: "פיצ'ר לא נמצא" });

      const VALID_STATUSES = ['draft', 'active', 'archived'];
      if (status && VALID_STATUSES.includes(status)) {
        setFeatureStatus(db, id, status);
      }
      if (name && typeof name === 'string' && name.trim()) {
        updateFeature(db, id, { name: name.trim() });
      }

      res.json({ ok: true, feature: getFeature(db, id) });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/feature-designer/:id failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  app.delete('/api/feature-designer/:id', (req, res) => {
    try {
      deleteFeature(db, Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'DELETE /api/feature-designer/:id failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── Set custom param value ────────────────────────────────────────────────

  app.post('/api/feature-designer/param-set', (req, res) => {
    const paramKey = String(req.body?.param ?? '').trim().toUpperCase();
    const rawValue = req.body?.value;
    if (!paramKey) return res.status(400).json({ ok: false, message: 'חסר שם פרמטר' });
    if (rawValue == null || rawValue === '') return res.status(400).json({ ok: false, message: 'חסר ערך' });
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return res.status(400).json({ ok: false, message: `ערך לא תקין: ${rawValue}` });
    }
    try {
      const updated = setCustomParamValue(db, paramKey, value);
      if (!updated) return res.status(404).json({ ok: false, message: 'פרמטר לא נמצא' });
      res.json({ ok: true, param: paramKey, value });
    } catch (err) {
      logger.error({ err }, 'POST /api/feature-designer/param-set failed');
      res.status(500).json({ ok: false, message: err.message });
    }
  });
}
