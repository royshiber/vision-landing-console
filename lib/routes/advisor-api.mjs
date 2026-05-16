import { runAdvisor } from '../gemini-advisor.mjs';
import { readJetsonVersionState } from '../jetson-version-store.mjs';
import { listIssues, getIssueMessages, markIssueResolved, deleteIssue, markMessageResolved } from '../chat-memory.mjs';
import {
  getRecentAudit,
  getJetsonProfile,
  isFcArmed,
} from '../advisor-apply.mjs';
import { describeAllowlists } from '../advisor-actions.mjs';
import {
  openSession,
  getActiveSession,
  closeSession,
  getPendingChangesSummary,
  revertAllChanges,
} from '../session-baseline.mjs';
import { logger } from '../logger.mjs';
import { getActiveConnection } from '../mavlink-connection.mjs';
import { buildFlightContext } from '../flight-intelligence-core.mjs';
import { composeHudTelemetryFields } from '../mavlink-hud-fields.mjs';
import { applySharedAction, previewSharedAction, rollbackSharedAction } from '../flight-actions-service.mjs';

/**
 * Advisor: chat, issues CRUD, apply/rollback, session, profile, audit, allowlists.
 * @param {import('express').Application} app
 * @param {object} ctx
 */
export function registerAdvisorApi(app, ctx) {
  const {
    db,
    APP_VERSION,
    jetsonState,
    visionState,
    slamState,
    advisorChatLimiter,
  } = ctx;

  app.post('/api/advisor-chat', advisorChatLimiter, async (req, res) => {
    const question = String(req.body?.question || '');
    try {
      const flightId = req.body?.flightId != null ? Number(req.body.flightId) : null;
      const now = Date.now();
      const visionAgeMs = visionState.frameTimestamp ? (now - Date.parse(visionState.frameTimestamp)) : null;
      const jetsonLast = jetsonState.lastSeen ? Date.parse(jetsonState.lastSeen) : 0;
      const jv = readJetsonVersionState();
      const mavConnForVersion = getActiveConnection?.();
      const fcFromMavlink =
        mavConnForVersion?.connected && mavConnForVersion?.autopilotName
          ? [mavConnForVersion.autopilotName, mavConnForVersion.vehicleType].filter(Boolean).join(' · ')
          : null;
      const versions = {
        app: APP_VERSION,
        agent: jetsonState.agentVersion || jv.installedVersion || null,
        internalFw: jetsonState.internalFwVersion || null,
        fc: jetsonState.fcFirmwareVersion || fcFromMavlink || null,
      };
      const rawAttachment = req.body?.attachment || null;
      const attachment = rawAttachment?.dataBase64 && rawAttachment?.mimeType
        ? { dataBase64: String(rawAttachment.dataBase64), mimeType: String(rawAttachment.mimeType), name: String(rawAttachment.name || '') }
        : null;

      const sharedContext = buildFlightContext({
        db,
        text: question,
        mode: 'advisor',
        sessionId: Number.isInteger(Number(req.body?.issueId)) && Number(req.body.issueId) > 0 ? `advisor-issue-${Number(req.body.issueId)}` : 'advisor',
        versions,
        liveContext: (() => {
          const mavConn = getActiveConnection?.();
          const connected = !!mavConn?.connected;
          const hudLive = composeHudTelemetryFields(mavConn);
          return {
            telemetry: connected ? {
              connected: true,
              armed: isFcArmed(mavConn),
              flightMode: mavConn.lastCustomMode ?? null,
              airspeed: hudLive.airspeed,
              groundspeed: hudLive.groundspeed,
              altitude: hudLive.altitude,
              heading: hudLive.heading,
              airspeedIsGroundspeedProxy: !!hudLive.airspeedIsGroundspeedProxy,
              hudTimeSkewWarn: !!hudLive.hudTimeSkewWarn,
              hudTimeSkewMs: hudLive.hudTimeSkewMs,
              rollDeg: mavConn.lastAttitude?.rollDeg ?? null,
              pitchDeg: mavConn.lastAttitude?.pitchDeg ?? null,
              batteryV: mavConn.lastBattery?.voltage_V ?? null,
              batteryPct: mavConn.lastBattery?.remaining_pct ?? null,
              gpsFixType: mavConn.lastGpsRaw?.fixType ?? null,
              gpsSats: mavConn.lastGpsRaw?.satellites ?? null,
            } : null,
            fcParams: connected && mavConn.params && Object.keys(mavConn.params).length > 0 ? mavConn.params : null,
            jetson: { ...jetsonState },
            vision: { ...visionState },
            slam: { ...slamState },
          };
        })(),
      });
      const augmentedQuestion = `${question}\n\n[MODE POLICY]\n${sharedContext.modeInstruction}\n\n${sharedContext.memory.unifiedMemoryBlock}`;

      const { reply, source, issueId, userMessageId, advisorMessageId, similarIssueIds, options, rejectedOptionsCount } = await runAdvisor({
        question: augmentedQuestion,
        params: req.body?.params || {},
        db,
        issueId: Number.isInteger(Number(req.body?.issueId)) && Number(req.body.issueId) > 0 ? Number(req.body.issueId) : null,
        flightId: Number.isInteger(flightId) && flightId > 0 ? flightId : null,
        attachment,
        versions,
        liveState: {
          vision: { ...visionState, ageMs: visionAgeMs, fresh: visionAgeMs != null && visionAgeMs < 5000 },
          jetson: { online: jetsonLast > 0 && (now - jetsonLast) < 15000, cpuLoadPct: jetsonState.cpuLoadPct, tempC: jetsonState.tempC, agentVersion: jetsonState.agentVersion || null, lastSeen: jetsonState.lastSeen || null },
          slam: { ...slamState, ageMs: slamState.frameTimestamp ? (now - Date.parse(slamState.frameTimestamp)) : null },
        },
      });
      res.json({
        ok: true,
        reply,
        source,
        issueId,
        userMessageId,
        advisorMessageId,
        similarIssueIds,
        versions,
        options: options || [],
        rejectedOptionsCount: rejectedOptionsCount || 0,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor-chat failed');
      res.status(500).json({ ok: false, message: err?.message || 'advisor failed' });
    }
  });

  app.get('/api/advisor/issues', (req, res) => {
    try {
      const status = req.query?.status ? String(req.query.status) : null;
      const limit = req.query?.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;
      const issues = listIssues(db, { status, limit });
      res.json({ ok: true, issues });
    } catch (err) {
      logger.error({ err }, 'GET /api/advisor/issues failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.get('/api/advisor/issues/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const messages = getIssueMessages(db, id);
      const header = db.prepare(`SELECT * FROM chat_issues WHERE id = ?`).get(id);
      if (!header) return res.status(404).json({ ok: false, message: 'not found' });
      res.json({ ok: true, issue: header, messages });
    } catch (err) {
      logger.error({ err }, 'GET /api/advisor/issues/:id failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.post('/api/advisor/issues/:id/resolve', (req, res) => {
    try {
      const id = Number(req.params.id);
      const resolution = req.body?.resolution != null ? String(req.body.resolution) : null;
      const st = String(req.body?.status || 'resolved');
      const status = ['resolved', 'open', 'wont_fix'].includes(st) ? st : 'resolved';
      const ok = markIssueResolved(db, id, { resolution, status });
      if (!ok) return res.status(404).json({ ok: false, message: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor/issues/:id/resolve failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.post('/api/advisor/messages/:id/resolve', (req, res) => {
    try {
      const id = Number(req.params.id);
      const resolved = req.body?.resolved !== false;
      const ok = markMessageResolved(db, id, { resolved });
      if (!ok) return res.status(404).json({ ok: false, message: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor/messages/:id/resolve failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.delete('/api/advisor/issues/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const ok = deleteIssue(db, id);
      if (!ok) return res.status(404).json({ ok: false, message: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'DELETE /api/advisor/issues/:id failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.get('/api/advisor/actions/:id/preview', (req, res) => {
    try {
      const mavConn = getActiveConnection?.();
      const valueTo = req.query?.valueTo != null && String(req.query.valueTo).length
        ? req.query.valueTo
        : undefined;
      const out = previewSharedAction(db, req.params.id, mavConn, valueTo);
      res.json(out);
    } catch (err) {
      logger.error({ err, actionId: req.params.id }, 'GET /api/advisor/actions/:id/preview failed');
      res.status(500).json({ ok: false, code: 'error', message: err?.message });
    }
  });

  app.post('/api/advisor/actions/:id/apply', async (req, res) => {
    try {
      const actionId = req.params.id;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const reason = String(body.inflightOverrideReason || '').trim();
      const inflightFcOverride = body.acknowledgeInflightRisk === true && reason.length >= 15;
      const mavConn = getActiveConnection?.();
      const applyCtx = {
        mavConn,
        appVersion: APP_VERSION,
        fcFirmware: mavConn?.autopilotName || null,
        inflightFcOverride,
        inflightOverrideReason: reason,
      };
      const valueTo = body.valueTo;
      const result = await applySharedAction(db, actionId, applyCtx, { valueTo });
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err, actionId: req.params.id }, 'POST /api/advisor/actions/:id/apply failed');
      res.status(err?.status || 500).json({ ok: false, code: err?.code || 'error', message: err?.message });
    }
  });

  app.post('/api/advisor/actions/:id/rollback', async (req, res) => {
    try {
      const actionId = req.params.id;
      const mavConn = getActiveConnection?.();
      const applyCtx = { mavConn, appVersion: APP_VERSION };
      const result = await rollbackSharedAction(db, actionId, applyCtx);
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err, actionId: req.params.id }, 'POST /api/advisor/actions/:id/rollback failed');
      res.status(err?.status || 500).json({ ok: false, code: err?.code || 'error', message: err?.message });
    }
  });

  app.post('/api/advisor/session/open', (req, res) => {
    try {
      const jp = getJetsonProfile(db);
      const mavConn = getActiveConnection?.();
      const fcParams = mavConn?.params || {};
      const result = openSession(db, { jetsonProfile: jp.profile, fcParams, reason: 'manual' });
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor/session/open failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.post('/api/advisor/session/close', (req, res) => {
    try {
      const session = getActiveSession(db);
      if (!session) return res.json({ ok: true, message: 'no active session' });
      closeSession(db, session.id);
      res.json({ ok: true, sessionId: session.id });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor/session/close failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.get('/api/advisor/session/pending', (req, res) => {
    try {
      const jp = getJetsonProfile(db);
      const summary = getPendingChangesSummary(db, { jetsonProfile: jp.profile });
      res.json({ ok: true, ...summary });
    } catch (err) {
      logger.error({ err }, 'GET /api/advisor/session/pending failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.post('/api/advisor/session/revert-all', async (req, res) => {
    try {
      const session = getActiveSession(db);
      if (!session) return res.json({ ok: true, reverted: [], errors: [], message: 'no active session' });
      const mavConn = getActiveConnection?.();
      const { reverted, errors } = await revertAllChanges(db, session.id, { mavConn, appVersion: APP_VERSION });
      res.json({ ok: true, reverted, errors });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor/session/revert-all failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.get('/api/advisor/profile', (req, res) => {
    try {
      const jp = getJetsonProfile(db);
      res.json({ ok: true, profile: jp.profile });
    } catch (err) {
      logger.error({ err }, 'GET /api/advisor/profile failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.post('/api/advisor/profile', (req, res) => {
    try {
      const incoming = req.body?.profile;
      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ ok: false, message: 'missing profile object' });
      }
      const allowed = describeAllowlists().jetson.map((r) => r.param);
      let count = 0;
      for (const [param, val] of Object.entries(incoming)) {
        if (!allowed.includes(param)) continue;
        const v = Number(val);
        if (!Number.isFinite(v)) continue;
        db.prepare(
          `INSERT INTO jetson_profile (param, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(param) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(param, v);
        count++;
      }
      res.json({ ok: true, saved: count });
    } catch (err) {
      logger.error({ err }, 'POST /api/advisor/profile failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.get('/api/advisor/audit', (req, res) => {
    try {
      const days = Math.min(Number(req.query.days) || 60, 365);
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const rows = getRecentAudit(db, { days, limit });
      res.json({ ok: true, entries: rows });
    } catch (err) {
      logger.error({ err }, 'GET /api/advisor/audit failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });

  app.get('/api/advisor/allowlists', (req, res) => {
    try {
      res.json({ ok: true, ...describeAllowlists() });
    } catch (err) {
      logger.error({ err }, 'GET /api/advisor/allowlists failed');
      res.status(500).json({ ok: false, message: err?.message });
    }
  });
}
