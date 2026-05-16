/**
 * Flight Engineer API routes.
 *
 * POST /api/flight-engineer/chat               — pilot voice turn → AI reply
 * POST /api/flight-engineer/tts                — TTS stream (ElevenLabs) or 204 if not configured
 * GET  /api/flight-engineer/voices             — ElevenLabs voice list (+ optional env presets), cached ~60s
 * GET  /api/flight-engineer/elevenlabs-voices  — same as /voices
 * GET  /api/flight-engineer/notes/:sid    — get all notes for a session
 * POST /api/flight-engineer/notes/:sid    — manually save a note
 * DELETE /api/flight-engineer/notes/:sid       — clear all notes
 * DELETE /api/flight-engineer/notes/:sid/:nid  — delete one note
 */

import {
  engineerChat,
  streamTts,
  detectLang,
  pendingParamChanges,
  getElevenLabsTtsPlaybackConfig,
  normalizeElevenLabsVoiceId,
} from '../flight-engineer.mjs';
import {
  mergeElevenLabsVoiceLists,
  parseElevenLabsVoicePresets,
} from '../elevenlabs-voice-list.mjs';
import { getFlightEngineerGeminiModelChain } from '../gemini-model.mjs';
import { getNotes, saveNote, deleteNote, clearNotes } from '../flight-notes.mjs';
import { createSessionDebrief } from '../engineer-memory.mjs';
import { buildFlightContext } from '../flight-intelligence-core.mjs';
import { applyEngineerApprovedParam } from '../flight-actions-service.mjs';
import { logger } from '../logger.mjs';
import {
  getActiveConnection,
} from '../mavlink-connection.mjs';
import { composeHudTelemetryFields } from '../mavlink-hud-fields.mjs';
import { isFcArmed, isInflightFcOverrideConfigured } from '../advisor-apply.mjs';

/** In-process cache for ElevenLabs GET /v1/voices (TTL milliseconds). */
let elevenLabsVoicesCache = { ts: 0, upstreamOk: false, apiVoices: [] };
const ELEVENLABS_VOICES_TTL_MS = 60_000;

export function registerFlightEngineerApi(app, ctx) {
  const { db, APP_VERSION, jetsonState, visionState, slamState } = ctx;

  // ── Build live telemetry + FC params snapshot ────────────────────────────
  function getFullContext() {
    const mavConn = getActiveConnection?.();
    const connected = !!mavConn?.connected;
    const hudLive = composeHudTelemetryFields(mavConn);
    const telemetry = connected ? {
      vlcAppVersion: APP_VERSION,
      connected:     true,
      armed:         isFcArmed(mavConn),
      flightMode:    mavConn.lastCustomMode ?? null,
      airspeed:      hudLive.airspeed,
      groundspeed:   hudLive.groundspeed,
      altitude:      hudLive.altitude,
      heading:       hudLive.heading,
      airspeedIsGroundspeedProxy: !!hudLive.airspeedIsGroundspeedProxy,
      hudTimeSkewWarn: !!hudLive.hudTimeSkewWarn,
      hudTimeSkewMs: hudLive.hudTimeSkewMs,
      rollDeg:       mavConn.lastAttitude?.rollDeg ?? null,
      pitchDeg:      mavConn.lastAttitude?.pitchDeg ?? null,
      batteryV:      mavConn.lastBattery?.voltage_V ?? null,
      batteryPct:    mavConn.lastBattery?.remaining_pct ?? null,
      gpsFixType:    mavConn.lastGpsRaw?.fixType ?? null,
      gpsSats:       mavConn.lastGpsRaw?.satellites ?? null,
    } : {
      vlcAppVersion: APP_VERSION,
      connected: false,
    };
    // FC params: full live dictionary (loaded via PARAM_REQUEST_LIST at connect)
    const fcParams = connected && mavConn.params && Object.keys(mavConn.params).length > 0
      ? mavConn.params
      : null;
    return {
      telemetry,
      fcParams,
      jetson: jetsonState ?? null,
      vision: visionState ?? null,
      slam: slamState ?? null,
    };
  }

  // ── POST /api/flight-engineer/chat ────────────────────────────────────────
  app.post('/api/flight-engineer/chat', async (req, res) => {
    const { text, sessionId, history, flightId } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, message: 'text required' });
    }
    if (!sessionId) {
      return res.status(400).json({ ok: false, message: 'sessionId required' });
    }

    try {
      const fullContext = getFullContext();
      const shared = buildFlightContext({
        db,
        text: text.trim(),
        sessionId,
        mode: 'engineer',
        liveContext: fullContext,
      });
      const rawFid = flightId != null && flightId !== '' ? Number(flightId) : null;
      const resolvedFlightId = Number.isFinite(rawFid) && rawFid > 0 ? rawFid : null;
      const result = await engineerChat(db, {
        text: text.trim(),
        sessionId,
        telemetry: fullContext.telemetry,
        fcParams: fullContext.fcParams,
        jetson:  fullContext.jetson,
        vision:  fullContext.vision,
        slam:    fullContext.slam,
        memory: shared.memory.unifiedMemoryBlock,
        modeInstruction: shared.modeInstruction,
        history: Array.isArray(history) ? history : [],
        flightId: resolvedFlightId,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, '[flight-engineer] chat route error');
      res.status(500).json({ ok: false, message: 'שגיאת שרת' });
    }
  });

  // ── GET /api/flight-engineer/voices — GET /api/flight-engineer/elevenlabs-voices
  //     Cached ~60s; merges ELEVENLABS_VOICE_PRESETS (JSON) with ElevenLabs API list.
  async function serveElevenLabsVoiceList(_req, res) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    /** Presets apply only when an API key exists (TTS still requires the key). */
    const presets = apiKey ? parseElevenLabsVoicePresets(process.env.ELEVENLABS_VOICE_PRESETS) : [];

    if (!apiKey) {
      return res.json({
        ok:          true,
        voices:      [],
        configured:  false,
        upstreamOk:  null,
      });
    }

    const now = Date.now();
    let upstreamOk = false;
    let apiVoices = [];

    if (now - elevenLabsVoicesCache.ts < ELEVENLABS_VOICES_TTL_MS && elevenLabsVoicesCache.ts > 0) {
      upstreamOk = elevenLabsVoicesCache.upstreamOk;
      apiVoices = Array.isArray(elevenLabsVoicesCache.apiVoices) ? elevenLabsVoicesCache.apiVoices : [];
    } else {
      try {
        const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': apiKey },
        });
        if (resp.ok) {
          const data = await resp.json();
          apiVoices = (data.voices || []).map((v) => ({
            voice_id: v.voice_id,
            name:     v.name || v.voice_id,
          }));
          upstreamOk = true;
        } else {
          logger.warn({ status: resp.status }, '[flight-engineer] ElevenLabs voices list HTTP error');
          upstreamOk = false;
          apiVoices = [];
        }
      } catch (err) {
        logger.error({ err }, '[flight-engineer] voices route error');
        upstreamOk = false;
        apiVoices = [];
      }
      elevenLabsVoicesCache = { ts: now, upstreamOk, apiVoices };
    }

    const merged = mergeElevenLabsVoiceLists(presets, upstreamOk ? apiVoices : []);
    const ok = upstreamOk === true || merged.length > 0;
    res.json({
      ok,
      voices: merged,
      configured: true,
      upstreamOk,
    });
  }

  app.get('/api/flight-engineer/voices', serveElevenLabsVoiceList);
  app.get('/api/flight-engineer/elevenlabs-voices', serveElevenLabsVoiceList);

  // ── POST /api/flight-engineer/tts ─────────────────────────────────────────
  app.post('/api/flight-engineer/tts', async (req, res) => {
    const { text, voiceId: rawVoiceId } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, message: 'text required' });
    }
    if (!process.env.ELEVENLABS_API_KEY) {
      // No key configured — client will use Web Speech API fallback
      return res.status(204).end();
    }
    const voiceId = normalizeElevenLabsVoiceId(rawVoiceId);
    if (rawVoiceId != null && rawVoiceId !== '' && !voiceId) {
      return res.status(400).json({ ok: false, message: 'invalid voiceId' });
    }
    try {
      const lang   = detectLang(text);
      const stream = await streamTts(text, lang, voiceId ? { voiceId } : {});
      if (!stream) return res.status(503).json({ ok: false, message: 'TTS unavailable' });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Transfer-Encoding', 'chunked');
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, '[flight-engineer] tts route error');
      res.status(503).json({ ok: false, message: 'TTS error' });
    }
  });

  // ── GET /api/flight-engineer/notes/:sid ──────────────────────────────────
  app.get('/api/flight-engineer/notes/:sid', (req, res) => {
    const notes = getNotes(db, req.params.sid);
    res.json({ ok: true, notes });
  });

  // ── POST /api/flight-engineer/notes/:sid ─────────────────────────────────
  app.post('/api/flight-engineer/notes/:sid', (req, res) => {
    const { content, category } = req.body || {};
    if (!content) return res.status(400).json({ ok: false, message: 'content required' });
    const id = saveNote(db, req.params.sid, content, category ?? 'general');
    res.json({ ok: true, id });
  });

  // ── DELETE /api/flight-engineer/notes/:sid ────────────────────────────────
  app.delete('/api/flight-engineer/notes/:sid', (req, res) => {
    clearNotes(db, req.params.sid);
    res.json({ ok: true });
  });

  // ── DELETE /api/flight-engineer/notes/:sid/:nid ───────────────────────────
  app.delete('/api/flight-engineer/notes/:sid/:nid', (req, res) => {
    deleteNote(db, Number(req.params.nid));
    res.json({ ok: true });
  });

  // ── POST /api/flight-engineer/apply-param ────────────────────────────────
  // Validates the approval token, then writes the param to the FC (or notes offline).
  app.post('/api/flight-engineer/apply-param', async (req, res) => {
    const { sessionId, token } = req.body || {};
    if (!sessionId || !token) {
      return res.status(400).json({ ok: false, message: 'sessionId and token required' });
    }

    const pending = pendingParamChanges.get(sessionId);
    if (!pending) {
      return res.status(404).json({ ok: false, message: 'אין הצעת פרמטר ממתינה לאישור' });
    }
    if (pending.token !== token) {
      return res.status(403).json({ ok: false, message: 'token לא תקין' });
    }
    if (pending.expiresAt < Date.now()) {
      pendingParamChanges.delete(sessionId);
      return res.status(410).json({ ok: false, message: 'תוקף ההצעה פג — בקש המלצה חדשה' });
    }

    const { key, value } = pending;
    pendingParamChanges.delete(sessionId);

    try {
      const mavConn = getActiveConnection?.();
      const reason = String(req.body?.inflightOverrideReason || '').trim();
      const applyResult = await applyEngineerApprovedParam(db, {
        sessionId,
        key,
        value,
        mavConn,
        appVersion: APP_VERSION || null,
        fcFirmware: mavConn?.autopilotName || null,
        inflightFcOverride: req.body?.acknowledgeInflightRisk === true && reason.length >= 15,
        inflightOverrideReason: reason,
      });
      return res.json(applyResult);
    } catch (err) {
      logger.error({ err, key, value }, '[flight-engineer] param apply failed');
      const status = err?.status || 500;
      return res.status(status).json({ ok: false, code: err?.code || 'error', message: `שגיאה בהחלת הפרמטר: ${err?.message ?? err}` });
    }
  });

  // ── POST /api/flight-engineer/debrief ────────────────────────────────────
  app.post('/api/flight-engineer/debrief', (req, res) => {
    const { sessionId, history } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, message: 'sessionId required' });
    try {
      const fullContext = getFullContext();
      const notes = getNotes(db, sessionId);
      const debrief = createSessionDebrief(
        db,
        sessionId,
        Array.isArray(history) ? history : [],
        notes,
        fullContext,
      );
      res.json({ ok: true, debrief });
    } catch (err) {
      logger.error({ err, sessionId }, '[flight-engineer] debrief failed');
      res.status(500).json({ ok: false, message: 'שמירת סיכום נכשלה' });
    }
  });

  // ── GET /api/flight-engineer/status ─────────────────────────────────────
  app.get('/api/flight-engineer/status', (_req, res) => {
    let eleven = null;
    if (process.env.ELEVENLABS_API_KEY) {
      const t = getElevenLabsTtsPlaybackConfig();
      eleven = {
        model:            t.modelId,
        tier:             t.tierHint,
        optimizeLatency:  t.optimizeLatency,
        speakerBoost:     t.voiceSettings.use_speaker_boost,
      };
    }
    res.json({
      ok: true,
      gemini:          !!process.env.GEMINI_API_KEY,
      engineerGeminiModel: getFlightEngineerGeminiModelChain()[0],
      elevenlabs:      !!process.env.ELEVENLABS_API_KEY,
      voiceId:         process.env.ELEVENLABS_VOICE_ID || null,
      defaultVoiceId:  process.env.ELEVENLABS_VOICE_ID || null,
      elevenlabsTts:   eleven,
      rcApprovalChannel: parseInt(process.env.FE_APPROVAL_RC_CHANNEL || '7', 10),
      feSttLang:       String(process.env.FE_STT_LANG || 'auto').trim() || 'auto',
      fcInflightOverrideConfigured: isInflightFcOverrideConfigured(),
    });
  });
}
