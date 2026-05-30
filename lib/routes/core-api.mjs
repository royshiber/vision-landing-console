import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { getGeminiModelInfo } from '../gemini-model.mjs';
import { searchCustomParams } from '../custom-param-store.mjs';
import { readJetsonVersionState, writeJetsonVersionState } from '../jetson-version-store.mjs';
import { logger } from '../logger.mjs';
import {
  buildArduTargetDefaults,
  coerceArduTargetPatch,
  coerceProfilePatch,
  getParamCenterSchemaPayload,
  normalizeCompanionLink,
} from '../param-schema.mjs';
import { runParamSmartSearch } from '../param-smart-search.mjs';
import { runParamSmartSearchV2 } from '../param-smart-search-v2.mjs';
import {
  activateConnection,
  deactivateConnection,
  getAllConnectionStatuses,
  getConnectionStatus,
  getConnectionParams,
  getMavlinkConnection,
  listSerialPorts,
  getActiveConnection,
} from '../mavlink-connection.mjs';
import { isFcArmed } from '../advisor-apply.mjs';
import { requireCompanionToken } from '../companion-auth.mjs';
import { COMPAT, semverGte } from '../compat-semver.mjs';
import { projectRoot } from '../db.mjs';
import { buildAutoConfigRecipe, listComponentTypes } from '../auto-config-recipes.mjs';
import {
  FLIGHT_HUD_CATALOG,
  resolveHudParamLocally,
  buildHudGeminiPrompt,
  parseHudGeminiResolution,
} from '../flight-hud-resolve.mjs';
import {
  loadParamIconCache,
  invalidateParamIconCache,
  resolveSvgForKey,
  getParamIconManifest,
  generateAndCacheParamIcon,
  ARDU_PARAMS_PATH,
} from '../param-icon-engine.mjs';
import { translateStatustextLines } from '../statustext-translate.mjs';
import { DEFAULT_RELEASES } from '../jetson-releases.mjs';
import {
  AUTO_CONNECT_BAUD_ORDER,
  scoreUsbFcHint,
  classifySerialAccessError,
  buildAutoConnectFailureSuggestion,
} from '../auto-connect-utils.mjs';
import { sseFiniteNumber, composeHudTelemetryFields } from '../mavlink-hud-fields.mjs';
import { runSmartConnect, clientIpFromRequest, getAutoConnectProgress } from '../smart-connect.mjs';
import {
  getCompanionBaseUrl,
  listCompanionLogs,
  downloadCompanionLog,
  saveLogArtifactBuffer,
  deployCompanionAgent,
  readCompanionAgentScript,
} from '../jetson-companion-proxy.mjs';

/**
 * @param {import('express').Application} app
 * @param {object} ctx
 */
export function registerCoreApi(app, ctx) {
  const {
    db,
    APP_VERSION,
    getAppVersion,
    upload,
    jetsonState,
    visionState,
    slamState,
    visionNavModeState,
  } = ctx;

  app.get('/api/meta', (_req, res) => {
    const appVersion = typeof getAppVersion === 'function' ? getAppVersion() : APP_VERSION;
    res.json({
      appVersion,
      /** Why: lets the UI detect an outdated Node process (404 HTML on quick-connect). What: present only on builds that register these routes. */
      features: {
        mavlinkQuickConnect: true,
        mavlinkAutoConnect: true,
        mavlinkDisconnectAll: true,
      },
    });
  });

app.get('/api/health', (_req, res) => {
  const appVersion = typeof getAppVersion === 'function' ? getAppVersion() : APP_VERSION;
  res.json({
    ok: true,
    project: 'vision-landing-console',
    version: appVersion,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: getGeminiModelInfo(),
    githubIngestConfigured: Boolean(process.env.GITHUB_INGEST_SECRET),
  });
});

app.get('/api/param-center/schema', (_req, res) => {
  res.json({ ok: true, schema: getParamCenterSchemaPayload() });
});

/** Why: free-text (Hebrew/English) → whitelist FC param names for the parameter center UI. */
app.post('/api/param-center/smart-search', async (req, res) => {
  const q = String(req.body?.q ?? '').trim();
  if (!q) return res.status(400).json({ ok: false, message: 'חסרה מחרוזת חיפוש' });
  try {
    const useV2 = String(process.env.SMART_SEARCH_V2 || '1') !== '0';
    const liveParams = getActiveConnection?.()?.params || null;
    const out = useV2
      ? await runParamSmartSearchV2(q, { liveParams, maxResults: 5 })
      : await runParamSmartSearch(q);
    if (useV2 && String(process.env.SMART_SEARCH_V2_SHADOW || '0') === '1') {
      runParamSmartSearch(q)
        .then((legacy) => {
          logger.info(
            {
              q,
              v2Keys: Array.isArray(out.keys) ? out.keys : [],
              v1Keys: Array.isArray(legacy?.keys) ? legacy.keys : [],
            },
            'smart-search shadow compare',
          );
        })
        .catch(() => {});
    }
    // Append any matching active custom params (Feature Designer) to the results.
    const customMatches = searchCustomParams(db, q);
    if (customMatches.length > 0) {
      out.custom_matches = customMatches;
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err }, 'POST /api/param-center/smart-search failed');
    res.status(500).json({ ok: false, message: err?.message || 'smart-search failed' });
  }
});

/**
 * Why: smart-search finds params that are outside the UI's editable set;
 *      this endpoint lets the pilot write any single ArduPilot param directly —
 *      via MAVLink when connected, or into the in-memory target when offline.
 * What: POST { param, value } → writes one param, returns { ok, verified, value }.
 */
app.post('/api/param-center/param-set', async (req, res) => {
  const param = String(req.body?.param ?? '').trim().toUpperCase();
  const rawValue = req.body?.value;
  if (!param) return res.status(400).json({ ok: false, message: 'חסר שם פרמטר' });
  if (rawValue == null || rawValue === '') return res.status(400).json({ ok: false, message: 'חסר ערך' });
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return res.status(400).json({ ok: false, message: `ערך לא תקין: ${rawValue}` });

  logger.info({ corrId: req.correlationId, param, value }, 'param-set HTTP received');

  if (rejectWhenArmedForFcWrite(res, 'param_set')) return;

  const mavConn = getActiveConnection?.();

  // Live MAVLink path — preferred
  if (mavConn?.connected && typeof mavConn.setParam === 'function') {
    try {
      const result = await mavConn.setParam(param, value, { timeoutMs: 4000 });
      if (!result?.ok) {
        return res.status(500).json({ ok: false, message: result?.error || 'הרחפן לא אישר את הכתיבה' });
      }
      // Sync into in-memory target so the rest of the UI stays consistent.
      if (ctx.arduTargetParams && param in ctx.arduTargetParams) {
        ctx.arduTargetParams[param] = value;
      }
      logger.info({ corrId: req.correlationId, param, value, verified: result.value }, 'param-set via MAVLink');
      return res.json({ ok: true, via: 'mavlink', verified: true, value: result.value ?? value, param });
    } catch (err) {
      logger.warn({ corrId: req.correlationId, param, value, err: err?.message }, 'param-set MAVLink failed');
      return res.status(500).json({ ok: false, message: err?.message || 'שגיאת MAVLink' });
    }
  }

  // Offline path — store in memory only (no FC verification)
  if (!mavConn?.connected) {
    if (ctx.arduTargetParams) ctx.arduTargetParams[param] = value;
    logger.info({ corrId: req.correlationId, param, value }, 'param-set offline (no MAVLink)');
    return res.json({
      ok: true,
      via: 'offline',
      verified: false,
      value,
      param,
      warning: 'MAVLink לא מחובר — הערך נשמר זמנית בשרת בלבד. חבר ל-FC ובצע WRITE כדי לשלוח לרחפן.',
    });
  }

  return res.status(503).json({ ok: false, message: 'מצב לא ידוע — נסה שוב' });
});

function getArmedGateStatus() {
  const mavConn = getActiveConnection?.();
  const armed = isFcArmed(mavConn);
  const mavlinkConnected = !!mavConn?.connected;
  return { armed, mavlinkConnected };
}

function rejectWhenArmedForFcWrite(res, reason = 'fc_write') {
  const { armed, mavlinkConnected } = getArmedGateStatus();
  if (armed === true) {
    res.status(409).json({
      ok: false,
      code: 'armed',
      message: 'המטוס במצב ARMED — כתיבת פרמטרי FC נחסמה. בצע Disarm ונסה שוב.',
      reason,
      armed,
      mavlinkConnected,
    });
    return true;
  }
  if (armed == null) {
    res.status(409).json({
      ok: false,
      code: 'armed_unknown',
      message: 'מצב ARMED לא ידוע — כתיבת פרמטרי FC נחסמה עד heartbeat תקין.',
      reason,
      armed: null,
      mavlinkConnected,
    });
    return true;
  }
  return false;
}

function jetsonStatusHandler(_req, res) {
  const vs = readJetsonVersionState();
  const now = Date.now();
  const last = jetsonState.lastSeen ? Date.parse(jetsonState.lastSeen) : 0;
  const online = Number.isFinite(last) && last > 0 && (now - last) < 15000;
  const heartbeatAgeMs = last ? (now - last) : null;
  const total = jetsonState.totalBeats + jetsonState.missedBeats;
  const packetLossPct = total > 0 ? Math.round((jetsonState.missedBeats / total) * 100) : null;
  const linkQualityPct = packetLossPct != null ? Math.max(0, 100 - packetLossPct) : null;
  res.json({
    ...jetsonState,
    online,
    heartbeatAgeMs,
    ageMs: heartbeatAgeMs,
    packetLossPct,
    linkQualityPct,
    installedVersion: vs.installedVersion,
    installState: vs.installState,
    lastAction: vs.lastAction,
    history: vs.history,
  });
}

/** Why: track beat counts for packet-loss estimate; reset missedBeats on receipt. What: increments totalBeats, zeroes missedBeats. Also records version fields for compatibility checks. */
function jetsonHeartbeatHandler(req, res) {
  const {
    cpuLoadPct,
    tempC,
    memPct,
    agentVersion,
    internalFwVersion,
    fcFirmwareVersion,
    relayPort,
    companionHttpPort,
    companionHttpUrl,
    fcLinked,
    fcHeartbeat,
  } = req.body || {};
  jetsonState.lastSeen = new Date().toISOString();
  jetsonState.online = true;
  jetsonState.totalBeats += 1;
  jetsonState.missedBeats = 0;
  jetsonState.peerIp = clientIpFromRequest(req) || jetsonState.peerIp;
  if (Number.isFinite(cpuLoadPct)) jetsonState.cpuLoadPct = Number(cpuLoadPct);
  if (Number.isFinite(tempC)) jetsonState.tempC = Number(tempC);
  if (Number.isFinite(memPct)) jetsonState.memPct = Number(memPct);
  if (agentVersion) jetsonState.agentVersion = String(agentVersion);
  if (internalFwVersion) jetsonState.internalFwVersion = String(internalFwVersion);
  if (fcFirmwareVersion) jetsonState.fcFirmwareVersion = String(fcFirmwareVersion);
  if (Number.isFinite(Number(relayPort))) jetsonState.relayPort = Number(relayPort);
  if (Number.isFinite(Number(companionHttpPort))) jetsonState.companionHttpPort = Number(companionHttpPort);
  if (companionHttpUrl) jetsonState.companionHttpUrl = String(companionHttpUrl).trim();
  if (fcLinked != null) jetsonState.fcLinked = !!fcLinked;
  if (fcHeartbeat != null) jetsonState.fcHeartbeat = !!fcHeartbeat;
  res.json({ ok: true, peerIp: jetsonState.peerIp });
}

function jetsonRebootRequestHandler(_req, res) {
  jetsonState.rebootRequests += 1;
  res.json({
    ok: true,
    message: 'Reboot request queued (safe mode; host does not reboot from console).',
    rebootRequests: jetsonState.rebootRequests,
    nextStep: 'Jetson agent can poll this flag and perform a controlled reboot.',
  });
}

for (const _jlBase of ['/api/jetson', '/api/rpi']) {
  app.get(`${_jlBase}/status`, jetsonStatusHandler);
  app.post(`${_jlBase}/heartbeat`, requireCompanionToken, jetsonHeartbeatHandler);
  app.post(`${_jlBase}/reboot-request`, requireCompanionToken, jetsonRebootRequestHandler);
}

app.post('/api/jetson/install', async (req, res) => {
  try {
    const version = String(req.body?.version || '').trim() || readJetsonVersionState().installedVersion;
    const state = readJetsonVersionState();
    writeJetsonVersionState({
      ...state,
      installState: 'installing',
      lastAction: `מתקין ${version}…`,
    });
    const base = getCompanionBaseUrl(jetsonState, process.env.JETSON_COMPANION_BASE_URL || '');
    let remoteNote = '';
    if (base) {
      try {
        const script = await readCompanionAgentScript();
        await deployCompanionAgent(base, script, version);
        remoteNote = ` — נשלח ל-Jetson (${base})`;
      } catch (err) {
        logger.warn({ err: err?.message, base }, 'jetson remote install failed');
        remoteNote = ` — Jetson לא הגיב (${err?.message || err})`;
      }
    } else {
      remoteNote = ' — Jetson offline; עודכן מצב מקומי בלבד';
    }
    writeJetsonVersionState({
      ...readJetsonVersionState(),
      installedVersion: version,
      installState: 'idle',
      lastAction: `הותקן ${version}${remoteNote}`,
      history: [
        { at: new Date().toISOString(), version, action: 'install', note: remoteNote.trim() },
        ...(state.history || []),
      ].slice(0, 20),
    });
    res.json({ ok: true, version, lastAction: readJetsonVersionState().lastAction });
  } catch (err) {
    logger.error({ err }, 'POST /api/jetson/install failed');
    writeJetsonVersionState({ ...readJetsonVersionState(), installState: 'idle' });
    res.status(500).json({ ok: false, error: err?.message || 'install failed' });
  }
});

app.post('/api/jetson/pull-logs', async (req, res) => {
  try {
    const base = getCompanionBaseUrl(jetsonState, process.env.JETSON_COMPANION_BASE_URL || '');
    if (!base) {
      return res.status(422).json({
        ok: false,
        message: 'Jetson לא מחובר — אין כתובת companion (heartbeat / JETSON_COMPANION_BASE_URL)',
      });
    }
    let flightId = Number(req.body?.flightId);
    if (!Number.isFinite(flightId) || flightId < 1) {
      const title = `Jetson logs ${new Date().toISOString().slice(0, 10)}`;
      const ins = db.prepare(`INSERT INTO flights (title) VALUES (?)`).run(title);
      flightId = Number(ins.lastInsertRowid);
    }
    const files = await listCompanionLogs(base);
    if (!files.length) {
      return res.json({ ok: true, flightId, imported: 0, message: 'אין קבצי לוג ב-Jetson' });
    }
    /** @type {object[]} */
    const imported = [];
    for (const f of files.slice(0, 40)) {
      const name = f.name || f.path || f.filename;
      if (!name) continue;
      try {
        const { buf, mime } = await downloadCompanionLog(base, name);
        const row = await saveLogArtifactBuffer(db, {
          flightId,
          source: 'jetson',
          originalName: name,
          buf,
          mime,
        });
        imported.push({ name, id: row.id });
      } catch (err) {
        logger.warn({ name, err: err?.message }, 'jetson log import skip');
      }
    }
    res.json({ ok: true, flightId, imported: imported.length, files: imported });
  } catch (err) {
    logger.error({ err }, 'POST /api/jetson/pull-logs failed');
    res.status(500).json({ ok: false, message: err?.message || 'pull failed' });
  }
});

app.get('/api/jetson/companion-script', async (_req, res) => {
  try {
    const script = await readCompanionAgentScript();
    res.type('text/plain').send(script);
  } catch (err) {
    res.status(404).json({ ok: false, message: err?.message || 'script missing' });
  }
});


/** Why: increment missedBeats when no heartbeat arrives within a 5 s window. What: runs server-side every 5 s; used to derive packet-loss % in jetsonStatusHandler. */
setInterval(() => {
  const last = jetsonState.lastSeen ? Date.parse(jetsonState.lastSeen) : 0;
  if (last > 0 && (Date.now() - last) > 5500) {
    jetsonState.missedBeats += 1;
  }
}, 5000);

/** Why: accept real-time vision output from Jetson companion over HTTP. What: stores latest lateral offset, heading error, and confidence for UI polling. */
app.post('/api/vision/frame', requireCompanionToken, (req, res) => {
  const { lateralOffsetM, headingErrorDeg, confidence, navLat, navLon } = req.body || {};
  if (Number.isFinite(lateralOffsetM)) visionState.lateralOffsetM = Number(lateralOffsetM);
  if (Number.isFinite(headingErrorDeg)) visionState.headingErrorDeg = Number(headingErrorDeg);
  if (Number.isFinite(confidence)) visionState.confidence = Math.max(0, Math.min(1, Number(confidence)));
  if (Number.isFinite(navLat)) visionState.navLat = Number(navLat);
  if (Number.isFinite(navLon)) visionState.navLon = Number(navLon);
  visionState.frameTimestamp = new Date().toISOString();
  visionState.frameCount += 1;
  res.json({ ok: true, frameCount: visionState.frameCount });
});

/** Why: UI polls this to display live vision metrics. What: returns latest visionState with computed age. */
app.get('/api/vision/latest', (_req, res) => {
  const ageMs = visionState.frameTimestamp ? (Date.now() - Date.parse(visionState.frameTimestamp)) : null;
  res.json({ ok: true, ...visionState, ageMs });
});

/** Why: CAM1 (forward, -10° pitch) sends VIO position estimates so the UI can show navigation status and EKF3 can fuse them. What: stores latest VIO pose; replaces old SLAM approach. */
app.post('/api/vision/vio-pose', requireCompanionToken, (req, res) => {
  const { posX, posY, posZ, yawDeg, confidence, fps, cam } = req.body || {};
  if (Number.isFinite(posX)) slamState.posX = Number(posX);
  if (Number.isFinite(posY)) slamState.posY = Number(posY);
  if (Number.isFinite(posZ)) slamState.posZ = Number(posZ);
  if (Number.isFinite(yawDeg)) slamState.yawDeg = Number(yawDeg);
  if (Number.isFinite(confidence)) slamState.mapQuality = Math.max(0, Math.min(1, Number(confidence)));
  if (fps != null) slamState.cam1Fps = Number(fps);
  slamState.frameTimestamp = new Date().toISOString();
  res.json({ ok: true });
});

/** Why: CAM2 (downward, -75° pitch) sends optical flow data for position/velocity hold. What: stores latest flow metrics for UI display. */
app.post('/api/vision/flow', requireCompanionToken, (req, res) => {
  const { flowX, flowY, quality, fps, cam } = req.body || {};
  if (Number.isFinite(flowX)) slamState.flowX = Number(flowX);
  if (Number.isFinite(flowY)) slamState.flowY = Number(flowY);
  if (quality != null) slamState.flowQuality = Number(quality);
  if (fps != null) slamState.cam2Fps = Number(fps);
  slamState.flowTimestamp = new Date().toISOString();
  res.json({ ok: true });
});

/** Backward-compat alias for old SLAM pose endpoint — redirects to vio-pose handler. */
app.post('/api/vision/slam-pose', requireCompanionToken, (req, res) => {
  const { posX, posY, posZ, yawDeg, mapQuality } = req.body || {};
  if (Number.isFinite(posX)) slamState.posX = Number(posX);
  if (Number.isFinite(posY)) slamState.posY = Number(posY);
  if (Number.isFinite(posZ)) slamState.posZ = Number(posZ);
  if (Number.isFinite(yawDeg)) slamState.yawDeg = Number(yawDeg);
  if (Number.isFinite(mapQuality)) slamState.mapQuality = Number(mapQuality);
  slamState.frameTimestamp = new Date().toISOString();
  res.json({ ok: true });
});

app.get('/api/vision/slam-latest', (_req, res) => {
  const ageMs = slamState.frameTimestamp ? (Date.now() - Date.parse(slamState.frameTimestamp)) : null;
  res.json({ ok: true, ...slamState, ageMs });
});

const VISION_NAV_MODES = new Set(['satellite_match', 'prior_mission_map']);

app.get('/api/vision/nav-mode', (_req, res) => {
  res.json({ ok: true, mode: visionNavModeState.mode });
});

app.post('/api/vision/nav-mode', (req, res) => {
  const mode = String(req.body?.mode ?? '').trim();
  if (!VISION_NAV_MODES.has(mode)) {
    return res.status(400).json({ ok: false, message: 'mode חייב להיות satellite_match או prior_mission_map' });
  }
  visionNavModeState.mode = mode;
  res.json({ ok: true, mode: visionNavModeState.mode });
});

app.get('/api/jetson/releases', (_req, res) => {
  res.json({ ok: true, releases: DEFAULT_RELEASES });
});

/** Why: SSE push eliminates client-side polling intervals (500ms vision, 5s jetson). What: single persistent connection that the server pushes every 300ms with live telemetry snapshot. */
const sseClients = new Set();
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

setInterval(() => {
  if (sseClients.size === 0) return;
  const now = Date.now();
  const jetsonLast = jetsonState.lastSeen ? Date.parse(jetsonState.lastSeen) : 0;
  const jetsonOnline = jetsonLast > 0 && (now - jetsonLast) < 15000;
  const jetsonAgeMs = jetsonLast ? (now - jetsonLast) : null;
  const total = jetsonState.totalBeats + jetsonState.missedBeats;
  const linkQualityPct = total > 0 ? Math.max(0, 100 - Math.round((jetsonState.missedBeats / total) * 100)) : null;
  const visionAgeMs = visionState.frameTimestamp ? (now - Date.parse(visionState.frameTimestamp)) : null;
  const slamAgeMs = slamState.frameTimestamp ? (now - Date.parse(slamState.frameTimestamp)) : null;
  const jv = readJetsonVersionState();
  const mavConn = getActiveConnection?.();
  const mapTelemetry = mavConn && typeof mavConn.getMapTelemetrySnapshot === 'function'
    ? mavConn.getMapTelemetrySnapshot()
    : null;
  const hud = composeHudTelemetryFields(mavConn);
  const mavlink = mavConn
    ? {
        connected: !!mavConn.connected,
        armed: isFcArmed(mavConn),
        armedKnown: typeof mavConn.lastBaseMode === 'number',
        autopilotName: mavConn.autopilotName || null,
        vehicleType: mavConn.vehicleType || null,
        flightMode: sseFiniteNumber(mavConn.lastCustomMode),
        airspeed: hud.airspeed,
        groundspeed: hud.groundspeed,
        altitude: hud.altitude,
        heading: hud.heading,
        airspeedIsGroundspeedProxy: !!hud.airspeedIsGroundspeedProxy,
        hudTimeSkewMs: hud.hudTimeSkewMs,
        hudTimeSkewWarn: !!hud.hudTimeSkewWarn,
        rollDeg: sseFiniteNumber(mavConn.lastAttitude?.rollDeg),
        pitchDeg: sseFiniteNumber(mavConn.lastAttitude?.pitchDeg),
        batteryV: sseFiniteNumber(mavConn.lastBattery?.voltage_V),
        batteryPct: sseFiniteNumber(mavConn.lastBattery?.remaining_pct),
        gpsFixType: sseFiniteNumber(mavConn.lastGpsRaw?.fixType),
        gpsSats: sseFiniteNumber(mavConn.lastGpsRaw?.satellites),
        rcChannels:  mavConn.lastRcChannels ?? null,
        map: mapTelemetry,
        recentStatusTexts: Array.isArray(mavConn.statusTexts)
          ? mavConn.statusTexts.slice(0, 28).map((st) => ({
              severity: st.severity,
              text: st.text,
              receivedAt: st.receivedAt || null,
            }))
          : [],
      }
    : {
        connected: false,
        armed: null,
        armedKnown: false,
        autopilotName: null,
        vehicleType: null,
        flightMode: null,
        airspeed: null,
        groundspeed: null,
        altitude: null,
        heading: null,
        airspeedIsGroundspeedProxy: false,
        hudTimeSkewMs: null,
        hudTimeSkewWarn: false,
        rollDeg: null,
        pitchDeg: null,
        batteryV: null,
        batteryPct: null,
        gpsFixType: null,
        gpsSats: null,
        rcChannels: null,
        map: null,
        recentStatusTexts: [],
      };
  const liveAppVersion = typeof getAppVersion === 'function' ? getAppVersion() : APP_VERSION;
  broadcastSse('telemetry', {
    appVersion: liveAppVersion,
    mavlink,
    jetson: {
      online: jetsonOnline,
      ageMs: jetsonAgeMs,
      cpuLoadPct: jetsonState.cpuLoadPct,
      tempC: jetsonState.tempC,
      memPct: jetsonState.memPct,
      linkQualityPct,
      agentVersion: jetsonState.agentVersion || null,
      installedVersion: jv.installedVersion,
      installState: jv.installState,
      lastAction: jv.lastAction,
    },
    vision: { ...visionState, ageMs: visionAgeMs },
    slam: { ...slamState, ageMs: slamAgeMs },
    visionNav: { mode: visionNavModeState.mode },
  });
}, 300);

// ── STATUSTEXT → Hebrew (HUD message strip) ───────────────────────────────────
app.post('/api/mavlink/statustext-translate', async (req, res) => {
  const texts = req.body?.texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ ok: false, message: 'texts[] required' });
  }
  const slice = texts.slice(0, 40).map((t) => String(t ?? '').trim().slice(0, 220));
  try {
    const he = await translateStatustextLines(slice);
    res.json({ ok: true, he });
  } catch (err) {
    logger.warn({ err: err.message }, 'statustext-translate');
    res.status(503).json({ ok: false, message: 'תרגום לא זמין' });
  }
});

// ── Param icons (Gemini SVG cache) ───────────────────────────────────────────
app.get('/api/param-icons', async (_req, res) => {
  try {
    const cache = await loadParamIconCache();
    res.json({ ok: true, manifest: getParamIconManifest(cache), count: Object.keys(cache.icons || {}).length });
  } catch (err) {
    logger.error({ err }, 'GET /api/param-icons');
    res.status(500).json({ ok: false, message: err?.message || 'failed' });
  }
});

app.get('/api/param-icons/:key', async (req, res) => {
  const key = String(req.params.key || '').trim().toUpperCase();
  if (!key || !/^[A-Z0-9_]+$/.test(key)) return res.status(400).end();
  try {
    const cache = await loadParamIconCache();
    const svg = resolveSvgForKey(key, cache);
    const custom = Boolean(cache.icons?.[key]?.svg);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', custom ? 'public, max-age=604800' : 'public, max-age=3600');
    res.setHeader('X-Param-Icon-Custom', custom ? '1' : '0');
    res.send(svg);
  } catch (err) {
    logger.error({ err, key }, 'GET /api/param-icons/:key');
    res.status(500).end();
  }
});

app.post('/api/param-icons/generate', async (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase();
  if (!key || !/^[A-Z0-9_]+$/.test(key)) {
    return res.status(400).json({ ok: false, message: 'invalid key' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ ok: false, message: 'GEMINI_API_KEY not set' });
  try {
    let label = String(req.body?.label || key);
    let desc = String(req.body?.description || '');
    if (existsSync(ARDU_PARAMS_PATH)) {
      const db = JSON.parse(await readFile(ARDU_PARAMS_PATH, 'utf8'));
      const info = db?.params?.[key];
      if (info) {
        label = info.display_name || label;
        desc = info.description || desc;
      }
    }
    const entry = await generateAndCacheParamIcon(apiKey, key, label, desc);
    invalidateParamIconCache();
    res.json({ ok: true, key, custom: true, built_at: entry.built_at });
  } catch (err) {
    logger.error({ err, key }, 'POST /api/param-icons/generate');
    res.status(500).json({ ok: false, message: err?.message || 'generate failed' });
  }
});

// ── Flight HUD — full catalog (so client can show "show all") ─────────────────
app.get('/api/flight-hud/catalog', (_req, res) => {
  res.json({ ok: true, catalog: FLIGHT_HUD_CATALOG });
});

// ── Flight HUD — custom param resolver ────────────────────────────────────────
app.post('/api/flight-hud/resolve-param', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ ok: false, message: 'missing text' });

  const local = resolveHudParamLocally(text);
  if (local.kind === 'ambiguous') {
    return res.json({
      ok: false,
      ambiguous: true,
      hint: local.hint,
      options: local.options.map((e) => ({ key: e.key, label: e.label, unit: e.unit })),
    });
  }
  if (local.kind === 'match') {
    return res.json({ ok: true, key: local.key, label: local.label, unit: local.unit });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      message: 'לא הצלחתי לפצח מקומית — הגדירו GEMINI_API_KEY או נסחו מדויק יותר (למשל «מהירות אוויר» / «מהירות קרקעית»).',
    });
  }
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const { resolveGeminiModelName } = await import('../gemini-model.mjs');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: resolveGeminiModelName(),
      generationConfig: { responseMimeType: 'application/json', temperature: 0.15, maxOutputTokens: 256 },
    });
    const prompt = buildHudGeminiPrompt(text);
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const g = parseHudGeminiResolution(raw);
    if (g.kind === 'match') {
      return res.json({ ok: true, key: g.key, label: g.label, unit: g.unit });
    }
    if (g.kind === 'ambiguous') {
      return res.json({
        ok: false,
        ambiguous: true,
        hint: g.hint,
        options: g.options.map((e) => ({ key: e.key, label: e.label, unit: e.unit })),
      });
    }
    return res.status(422).json({ ok: false, message: g.message });
  } catch (err) {
    logger.warn({ err: err.message }, 'flight-hud resolve-param error');
    return res.status(503).json({ ok: false, message: 'שגיאה בזיהוי הפרמטר' });
  }
});

// ── Fly-to command ─────────────────────────────────────────────────────────────
app.post('/api/mavlink/fly-to', (req, res) => {
  const { lat, lon, alt } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ ok: false, message: 'lat/lon נדרשים' });
  }
  const altM = typeof alt === 'number' ? alt : 60; // default 60m AGL if not specified
  const conn = getActiveConnection?.();
  if (!conn || !conn.connected) {
    return res.status(503).json({ ok: false, message: 'אין חיבור פעיל ל-FC' });
  }
  try {
    conn.flyTo(lat, lon, altM);
    res.json({ ok: true, lat, lon, altM });
  } catch (err) {
    logger.warn({ err: err.message }, 'fly-to error');
    res.status(503).json({ ok: false, message: err.message });
  }
});

app.get('/api/flights', (_req, res) => {
  const rows = db.prepare(`SELECT id, title, created_at FROM flights ORDER BY id DESC`).all();
  res.json({ ok: true, flights: rows });
});

app.post('/api/flights', (req, res) => {
  const title = String(req.body?.title || '').trim() || `טיסה ${new Date().toISOString().slice(0, 10)}`;
  const r = db.prepare(`INSERT INTO flights (title) VALUES (?)`).run(title);
  res.json({ ok: true, flight: { id: r.lastInsertRowid, title } });
});

app.post('/api/flights/:id/notes', (req, res) => {
  const flightId = Number(req.params.id);
  const body = String(req.body?.body || '').trim();
  if (!Number.isInteger(flightId) || flightId < 1) return res.status(400).json({ ok: false, message: 'bad flight id' });
  if (!body) return res.status(400).json({ ok: false, message: 'empty body' });
  const exists = db.prepare(`SELECT id FROM flights WHERE id = ?`).get(flightId);
  if (!exists) return res.status(404).json({ ok: false, message: 'flight not found' });
  db.prepare(`INSERT INTO flight_notes (flight_id, body) VALUES (?, ?)`).run(flightId, body);
  res.json({ ok: true });
});

app.get('/api/flights/:id/logs', (req, res) => {
  const flightId = Number(req.params.id);
  const rows = db.prepare(
    `SELECT id, source, original_name, mime, size_bytes, text_excerpt, created_at FROM log_artifacts WHERE flight_id = ? ORDER BY id DESC`,
  ).all(flightId);
  res.json({ ok: true, logs: rows });
});

/** Why: store uploaded ArduPilot / Jetson logs and optional text preview for RAG. What: writes disk + SQLite row. */
app.post('/api/flights/:id/logs', upload.single('file'), async (req, res) => {
  try {
    const flightId = Number(req.params.id);
    if (!Number.isInteger(flightId) || flightId < 1) {
      return res.status(400).json({ ok: false, message: 'bad flight id' });
    }
    const source = String(req.body?.source || 'ardupilot').toLowerCase();
    if (!['ardupilot', 'jetson'].includes(source)) {
      return res.status(400).json({ ok: false, message: 'source must be ardupilot or jetson' });
    }
    const exists = db.prepare(`SELECT id FROM flights WHERE id = ?`).get(flightId);
    if (!exists) return res.status(404).json({ ok: false, message: 'flight not found' });
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, message: 'missing file field "file"' });

    const mime = f.mimetype || 'application/octet-stream';
    let textExcerpt = '';
    if (mime.startsWith('text/') || mime === 'application/json' || f.originalname?.endsWith('.log') || f.originalname?.endsWith('.csv')) {
      try {
        const raw = await readFile(f.path);
        textExcerpt = raw.toString('utf8').slice(0, 120_000);
      } catch {
        textExcerpt = '(לא ניתן לקרוא כטקסט)';
      }
    } else {
      textExcerpt = `(קובץ בינארי — ${f.originalname}; ייתכן שדרוש mavlogdump בעתיד)`;
    }

    // Auto-classify source if not explicitly set — ArduPilot: .bin/.tlog or CTUN/IMU in text; Jetson: jetson/vision/csv keywords
    let autoSource = source;
    if (autoSource === 'auto' || !['ardupilot', 'jetson'].includes(autoSource)) {
      const fname = (f.originalname || '').toLowerCase();
      if (fname.endsWith('.bin') || fname.endsWith('.tlog') || textExcerpt.includes('CTUN') || textExcerpt.includes('IMU,') || textExcerpt.includes('GPS,')) {
        autoSource = 'ardupilot';
      } else if (fname.includes('jetson') || fname.includes('vision') || fname.endsWith('.csv')) {
        autoSource = 'jetson';
      } else {
        autoSource = source;
      }
    }

    // Auto-generate a smart title for the flight if it has a generic one
    // Extract GPS coords from text log (format: GPS, lat, lon or similar)
    let autoLabel = '';
    const gpsMatch = textExcerpt.match(/GPS[,\s]+[\d.]+[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (gpsMatch) autoLabel = ` (GPS: ${parseFloat(gpsMatch[1]).toFixed(4)}, ${parseFloat(gpsMatch[2]).toFixed(4)})`;
    // Detect if it's ground-only (no altitude > 5m in CTUN)
    const isGroundOnly = textExcerpt.includes('CTUN') && !textExcerpt.match(/CTUN.*?[,\s]([5-9]\d|\d{3,})[,\s]/);
    const groundTag = isGroundOnly ? ' — לא טיסה, זמן על הקרקע' : '';

    const rel = path.relative(projectRoot, f.path).split(path.sep).join('/');
    db.prepare(
      `INSERT INTO log_artifacts (flight_id, source, original_name, stored_path, mime, size_bytes, text_excerpt) VALUES (?,?,?,?,?,?,?)`,
    ).run(flightId, autoSource, (f.originalname || f.filename) + groundTag + autoLabel, rel, mime, f.size, textExcerpt);

    res.json({ ok: true, stored: f.filename, excerptLen: textExcerpt.length, autoSource, groundTag: groundTag || null });
  } catch (err) {
    logger.error({ err }, 'POST /api/flights/:id/logs failed');
    res.status(500).json({ ok: false, message: err?.message || 'upload failed' });
  }
});

/** Why: receive automatic code updates from GitHub Actions. What: validates token, stores digest row for Gemini context. */
app.post('/api/integrations/github/ingest', (req, res) => {
  const secret = process.env.GITHUB_INGEST_SECRET;
  const token = req.get('X-Ingest-Token');
  if (!secret || token !== secret) {
    logger.warn({ ip: req.ip }, 'Unauthorized ingest attempt');
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, message: 'body must be a JSON object' });
  }
  const commit_sha = String(body.commit || body.commit_sha || '').trim() || null;
  const branch = String(body.branch || '').trim() || null;
  const files_changed_text = typeof body.filesChangedText === 'string'
    ? body.filesChangedText
    : (Array.isArray(body.filesChanged) ? body.filesChanged.join('\n') : JSON.stringify(body.files || []));
  const payload_json = JSON.stringify(body).slice(0, 100_000);

  try {
    db.prepare(
      `INSERT INTO code_digest (commit_sha, branch, files_changed_text, payload_json) VALUES (?,?,?,?)`,
    ).run(commit_sha, branch, files_changed_text?.slice(0, 50_000) || '', payload_json);
    logger.info({ commit_sha, branch }, 'Code digest ingested from GitHub');
    res.json({ ok: true, message: 'digest stored' });
  } catch (err) {
    logger.error({ err }, 'Failed to store code digest');
    res.status(500).json({ ok: false, message: 'Failed to store digest' });
  }
});


app.post('/api/mission-planner/apply', async (req, res) => {
  try {
    const text = String(req.body?.configText || '').trim();
    if (!text) return res.status(400).json({ ok: false, message: 'Missing configText' });
    const tmpFile = path.join(os.tmpdir(), `vision-landing-${Date.now()}.param`);
    await writeFile(tmpFile, text, 'utf8');
    const missionPlannerPath = 'C:\\Program Files (x86)\\Mission Planner\\MissionPlanner.exe';
    exec(`"${missionPlannerPath}"`, () => {});
    return res.json({
      ok: true,
      message: 'Parameter file prepared and Mission Planner launch attempted.',
      paramFile: tmpFile,
      note: 'If Mission Planner did not open, launch it manually and load this param file.',
    });
  } catch (err) {
    logger.error({ err }, 'POST /api/mission-planner/apply failed');
    return res.status(500).json({ ok: false, message: err?.message || 'apply failed' });
  }
});

/** Why: default ArduPilot target set for Vision Landing. What: cloned into mutable store so the UI can edit and persist via /api/vision/config. */
app.get('/api/vision/config', (_req, res) => {
  const companion = normalizeCompanionLink(ctx.visionProfileStore || {});
  res.json({
    ok: true,
    profile: Object.keys(ctx.visionProfileStore).length
      ? { ...ctx.visionProfileStore, ...companion }
      : { ...companion },
    arduTarget: { ...ctx.arduTargetParams },
  });
});

/** Why: unified WRITE — persist console profile and editable ArduPilot targets before hardware WRITE. What: shallow-merge body fields into server stores. */
app.post('/api/vision/config', (req, res) => {
  const body = req.body || {};
  const rejected = {};

  if (body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)) {
    const { accepted, rejected: rejectedProfile } = coerceProfilePatch(body.profile);
    ctx.visionProfileStore = { ...ctx.visionProfileStore, ...accepted };
    if (Object.keys(rejectedProfile).length) rejected.profile = rejectedProfile;
  }

  const companion = normalizeCompanionLink(ctx.visionProfileStore || {});
  const defaultsFromCompanion = buildArduTargetDefaults(companion);
  for (const [k, v] of Object.entries(defaultsFromCompanion)) {
    if (!(k in ctx.arduTargetParams)) ctx.arduTargetParams[k] = v;
  }

  if (body.arduTarget && typeof body.arduTarget === 'object' && !Array.isArray(body.arduTarget)) {
    const { accepted, rejected: rejectedArdu } = coerceArduTargetPatch(body.arduTarget, ctx.arduTargetParams);
    Object.assign(ctx.arduTargetParams, accepted);
    if (Object.keys(rejectedArdu).length) rejected.arduTarget = rejectedArdu;
  }

  res.json({
    ok: true,
    profile: { ...ctx.visionProfileStore, ...companion },
    arduTarget: { ...ctx.arduTargetParams },
    rejected,
  });
});

/** Why: READ needs current device state vs editable target. What: returns known state or disconnected flag and live ctx.arduTargetParams. */
app.get('/api/ardu/params', (_req, res) => {
  const { armed, mavlinkConnected } = getArmedGateStatus();
  const mavConn = getActiveConnection?.();
  const liveParams = mavConn && mavlinkConnected ? getConnectionParams(mavConn.id) : null;
  const liveDict = liveParams && typeof liveParams === 'object' ? liveParams : null;
  const liveCount = liveDict ? Object.keys(liveDict).length : 0;

  let current = null;
  let connected = false;
  if (mavlinkConnected && liveDict && liveCount > 0) {
    current = liveDict;
    connected = true;
  } else if (ctx.arduCurrentParams != null && typeof ctx.arduCurrentParams === 'object') {
    current = ctx.arduCurrentParams;
    connected = true;
  }

  res.json({
    ok: true,
    connected,
    mavlinkConnected,
    armed,
    paramCount: current ? Object.keys(current).length : liveCount,
    current,
    target: { ...ctx.arduTargetParams },
  });
});

/** Why: WRITE applies current editable target set to simulated FC state. What: in real mode would use MAVProxy; for now copies ctx.arduTargetParams into ctx.arduCurrentParams. */
app.post('/api/ardu/params/write', (_req, res) => {
  if (rejectWhenArmedForFcWrite(res, 'manual_fc_write')) return;
  const normalized = coerceArduTargetPatch(ctx.arduTargetParams, ctx.arduTargetParams);
  Object.assign(ctx.arduTargetParams, normalized.accepted);
  ctx.arduCurrentParams = { ...ctx.arduTargetParams };
  const n = Object.keys(ctx.arduTargetParams).length;
  res.json({
    ok: true,
    written: n,
    rejected: normalized.rejected,
    message: `WRITE SUCCESS — ${n} פרמטרים נכתבו`,
  });
});

/** Why: terrain coverage was replaced by dual-camera VIO. These stubs keep old Jetson agents from crashing. */
app.get('/api/terrain/coverage', (_req, res) => res.json({ ok: true, cells: [], total: 0, deprecated: true }));
app.post('/api/terrain/coverage', (_req, res) => res.json({ ok: true, total: 0, deprecated: true }));

/** Delete a single log artifact (DB row + file from disk). */
app.delete('/api/flights/log/:logId', async (req, res) => {
  const logId = Number(req.params.logId);
  if (!Number.isFinite(logId) || logId < 1) {
    return res.status(400).json({ ok: false, message: 'bad log id' });
  }
  try {
    const row = db.prepare('SELECT id, stored_path FROM log_artifacts WHERE id = ?').get(logId);
    if (!row) return res.status(404).json({ ok: false, message: 'log not found' });
    db.prepare('DELETE FROM log_artifacts WHERE id = ?').run(logId);
    if (row.stored_path) {
      const abs = path.resolve(row.stored_path);
      try {
        const { unlink } = await import('fs/promises');
        await unlink(abs);
      } catch {
        /* file may already be gone — ignore */
      }
    }
    res.json({ ok: true, deleted: logId });
  } catch (err) {
    logger.error({ err }, 'DELETE /api/flights/log/:logId failed');
    res.status(500).json({ ok: false, message: err?.message || 'delete failed' });
  }
});

/** Delete a flight and all its logs + notes (CASCADE in schema handles child rows).
 *  Also removes physical log files from disk. */
app.delete('/api/flights/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, message: 'bad flight id' });
  }
  try {
    const flight = db.prepare('SELECT id FROM flights WHERE id = ?').get(id);
    if (!flight) return res.status(404).json({ ok: false, message: 'flight not found' });
    const logRows = db.prepare('SELECT stored_path FROM log_artifacts WHERE flight_id = ?').all(id);
    db.prepare('DELETE FROM flights WHERE id = ?').run(id);
    const { unlink } = await import('fs/promises');
    for (const r of logRows) {
      if (r.stored_path) {
        try { await unlink(path.resolve(r.stored_path)); } catch { /* ignore */ }
      }
    }
    res.json({ ok: true, deleted: id });
  } catch (err) {
    logger.error({ err }, 'DELETE /api/flights/:id failed');
    res.status(500).json({ ok: false, message: err?.message || 'delete failed' });
  }
});

/** Why: pilot wants to see all logs ever uploaded without switching flight contexts. What: joins log_artifacts + flights so every log is visible in one place. */
app.get('/api/flights/all-logs', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT la.id, la.flight_id, la.source, la.original_name, la.stored_path, la.mime, la.size_bytes, la.created_at AS uploaded_at,
             f.title as flight_title
      FROM log_artifacts la JOIN flights f ON la.flight_id = f.id
      ORDER BY la.created_at DESC LIMIT 200
    `).all();
    const logs = rows.map((row) => {
      const rel = String(row.stored_path || '').replace(/\\/g, '/');
      const fileName = rel.split('/').pop();
      return {
        ...row,
        downloadUrl: fileName ? `/uploads/${encodeURIComponent(fileName)}` : null,
      };
    });
    res.json({ ok: true, logs });
  } catch (err) {
    logger.error({ err }, 'GET /api/flights/all-logs failed');
    res.json({ ok: true, logs: [] });
  }
});

/** Why: single endpoint for the UI to know if all components are compatible. What: returns status per component + overall flag. */
app.get('/api/health/compatibility', (_req, res) => {
  const appVersion = typeof getAppVersion === 'function' ? getAppVersion() : APP_VERSION;
  const components = {};

  components.server = { label: 'קונסולה', version: appVersion, status: 'ok', message: null };

  const nodeMajor = Number(process.version.replace('v', '').split('.')[0]);
  components.nodejs = {
    label: 'Node.js',
    version: process.version,
    status: nodeMajor >= COMPAT.nodejsMinMajor ? 'ok' : 'error',
    message: nodeMajor < COMPAT.nodejsMinMajor ? `נדרש Node.js v${COMPAT.nodejsMinMajor}+` : null,
  };

  const { effective: geminiModel } = getGeminiModelInfo();
  components.gemini = {
    label: 'Gemini AI',
    version: geminiModel,
    status: process.env.GEMINI_API_KEY ? 'ok' : 'warn',
    message: !process.env.GEMINI_API_KEY ? 'אין מפתח API — רק מענה מקומי' : null,
  };

  if (jetsonState.agentVersion) {
    const ok = semverGte(jetsonState.agentVersion, COMPAT.agentMinVersion);
    const fresh = semverGte(jetsonState.agentVersion, COMPAT.agentWarnVersion);
    components.jetsonAgent = {
      label: 'Jetson Agent',
      version: jetsonState.agentVersion,
      status: !ok ? 'error' : !fresh ? 'warn' : 'ok',
      message: !ok ? `נדרש גרסה ${COMPAT.agentMinVersion}+` : !fresh ? `מומלץ לעדכן ל-${COMPAT.agentWarnVersion}+` : null,
    };
  } else {
    components.jetsonAgent = { label: 'Jetson Agent', version: null, status: 'unknown', message: 'גרסה לא דווחה עדיין ב-heartbeat' };
  }

  if (jetsonState.internalFwVersion) {
    components.jetsonInternal = { label: 'Jetson FW פנימי', version: jetsonState.internalFwVersion, status: 'ok', message: null };
  }

  if (jetsonState.fcFirmwareVersion) {
    const m = String(jetsonState.fcFirmwareVersion).match(/(\d+)\.(\d+)/);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    const ok = major > COMPAT.ardupilotMinMajor || (major === COMPAT.ardupilotMinMajor && minor >= COMPAT.ardupilotMinMinor);
    components.ardupilot = {
      label: 'ArduPilot FC',
      version: jetsonState.fcFirmwareVersion,
      status: ok ? 'ok' : 'error',
      message: !ok ? `נדרש ArduCopter ${COMPAT.ardupilotMinMajor}.${COMPAT.ardupilotMinMinor}+` : null,
    };
  } else {
    components.ardupilot = { label: 'ArduPilot FC', version: null, status: 'unknown', message: 'לא דווחה גרסת קושחה' };
  }

  const hasError = Object.values(components).some((c) => c.status === 'error');
  const hasWarn = Object.values(components).some((c) => c.status === 'warn');
  res.json({
    ok: !hasError,
    overallStatus: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    components,
    checkedAt: new Date().toISOString(),
  });
});

// ── Connection profiles CRUD ──────────────────────────────────────────────────

app.get('/api/connections', (_req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM connections ORDER BY active DESC, id DESC`).all();
    const live = getAllConnectionStatuses();
    const merged = rows.map((r) => {
      const ls = live.find((s) => s.id === r.id);
      return { ...r, liveStatus: ls || null };
    });
    res.json({ ok: true, connections: merged });
  } catch (err) {
    logger.error({ err }, 'GET /api/connections failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/connections', (req, res) => {
  try {
    const { name, type, host, port, serialPort, baudRate } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, message: 'name required' });
    const validTypes = ['http', 'serial', 'udp', 'tcp', 'telemetry'];
    if (!type || !validTypes.includes(type)) return res.status(400).json({ ok: false, message: `type must be one of: ${validTypes.join(', ')}` });
    const r = db.prepare(
      `INSERT INTO connections (name, type, host, port, serial_port, baud_rate) VALUES (?,?,?,?,?,?)`,
    ).run(String(name).trim(), type, host || null, port ? Number(port) : null, serialPort || null, baudRate ? Number(baudRate) : 57600);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (err) {
    logger.error({ err }, 'POST /api/connections failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

/** Why: Mission Planner-style «disconnect link». What: tears down every live MAVLink socket and clears DB active flags. */
app.post('/api/connections/disconnect-all', (_req, res) => {
  try {
    const live = getAllConnectionStatuses();
    for (const s of live) deactivateConnection(s.id);
    db.prepare(`UPDATE connections SET active = 0`).run();
    res.json({ ok: true, disconnected: live.length });
  } catch (err) {
    logger.error({ err }, 'POST /api/connections/disconnect-all failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

async function waitForFirstHeartbeat(connId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getConnectionStatus(connId);
    if (s && Number(s.heartbeatCount) > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Why: one-click connect from the topbar without pre-saving a profile; mirrors Mission Planner quick-connect. */
app.post('/api/connections/quick-connect', async (req, res) => {
  try {
    const { type, baudRate, serialPort, host, port } = req.body || {};
    const br = Number(baudRate) || 57600;

    const live = getAllConnectionStatuses();
    for (const s of live) deactivateConnection(s.id);
    db.prepare(`UPDATE connections SET active = 0`).run();

    let name;
    let rowHost = host != null && host !== '' ? String(host).trim() : null;
    let rowPort = port != null && port !== '' ? Number(port) : null;
    const rowSerial = serialPort != null && String(serialPort).trim() ? String(serialPort).trim() : null;

    if (type === 'serial') {
      if (!rowSerial) return res.status(400).json({ ok: false, message: 'חסר serialPort (COM)' });
      name = `Serial ${rowSerial}`;
    } else if (type === 'udp') {
      if (!Number.isFinite(rowPort)) rowPort = 14550;
      name = `UDP :${rowPort}`;
      rowHost = rowHost || '0.0.0.0';
    } else if (type === 'tcp') {
      if (!rowHost || !Number.isFinite(rowPort)) {
        return res.status(400).json({ ok: false, message: 'חסר host או port ל-TCP' });
      }
      name = `TCP ${rowHost}:${rowPort}`;
    } else {
      return res.status(400).json({ ok: false, message: 'סוג חיבור לא נתמך (udp/tcp/serial)' });
    }

    const ins = db.prepare(
      `INSERT INTO connections (name, type, host, port, serial_port, baud_rate) VALUES (?,?,?,?,?,?)`,
    ).run(name, type, rowHost, rowPort, rowSerial, br);
    const id = Number(ins.lastInsertRowid);
    try {
      await activateConnection({
        id,
        name,
        type,
        host: rowHost || '0.0.0.0',
        port: Number.isFinite(rowPort) ? rowPort : 14550,
        serialPort: rowSerial || undefined,
        baudRate: br,
      });
    } catch (err) {
      try { db.prepare(`DELETE FROM connections WHERE id = ?`).run(id); } catch { /* ignore */ }
      logger.warn({ err: err?.message, id }, '[connections] quick-connect activate failed');
      return res.status(500).json({ ok: false, message: err?.message || 'הפעלת חיבור נכשלה' });
    }
    db.prepare(`UPDATE connections SET active = 1, last_connected = datetime('now') WHERE id = ?`).run(id);
    res.json({ ok: true, id, status: getConnectionStatus(id) });
  } catch (err) {
    logger.error({ err }, 'POST /api/connections/quick-connect failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

/** Live progress for smart auto-connect (poll while POST is in flight). */
app.get('/api/connections/auto-connect/progress', (_req, res) => {
  res.json(getAutoConnectProgress());
});

/**
 * Smart connect — USB FC → Jetson MAVLink relay → local SITL. Ignores UI connection type.
 */
app.post('/api/connections/auto-connect', async (req, res) => {
  try {
    const preferredPath = String(req.body?.serialPort || '').trim() || undefined;
    const result = await runSmartConnect({
      db,
      jetsonState,
      env: process.env,
      preferredSerialPort: preferredPath,
      waitForFirstHeartbeat,
    });
    if (result.ok) {
      return res.json({
        ok: true,
        id: result.id,
        serialPort: result.serialPort ?? null,
        baudRate: result.baudRate ?? null,
        host: result.host ?? null,
        port: result.port ?? null,
        connectionType: result.connectionType ?? null,
        connectPath: result.connectPath ?? null,
        manufacturer: null,
        status: result.status,
        winner: result.winner,
        attempts: result.attempts,
        phases: result.phases,
        suggestion: null,
      });
    }
    return res.status(422).json({
      ok: false,
      message: result.message,
      attempts: result.attempts,
      phases: result.phases,
      suggestion: result.suggestion,
    });
  } catch (err) {
    logger.error({ err }, 'POST /api/connections/auto-connect failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.patch('/api/connections/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, message: 'bad id' });
    if (!db.prepare(`SELECT id FROM connections WHERE id = ?`).get(id)) return res.status(404).json({ ok: false, message: 'not found' });
    const { name, type, host, port, serialPort, baudRate } = req.body || {};
    db.prepare(`UPDATE connections SET
      name       = COALESCE(?, name),
      type       = COALESCE(?, type),
      host       = COALESCE(?, host),
      port       = COALESCE(?, port),
      serial_port= COALESCE(?, serial_port),
      baud_rate  = COALESCE(?, baud_rate)
      WHERE id = ?`).run(
      name ? String(name).trim() : null, type || null, host || null,
      port != null ? Number(port) : null, serialPort || null,
      baudRate != null ? Number(baudRate) : null, id,
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'PATCH /api/connections/:id failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.delete('/api/connections/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    deactivateConnection(id);
    db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'DELETE /api/connections/:id failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

/** Why: activate establishes live MAVLink over UDP / TCP / Serial (serialport). What: connects, stores status, SSE broadcast. */
app.post('/api/connections/:id/activate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ ok: false, message: 'not found' });
    await activateConnection({ id: row.id, name: row.name, type: row.type, host: row.host, port: row.port, serialPort: row.serial_port, baudRate: row.baud_rate });
    db.prepare(`UPDATE connections SET active = 1, last_connected = datetime('now') WHERE id = ?`).run(id);
    res.json({ ok: true, status: getConnectionStatus(id) });
  } catch (err) {
    logger.error({ err }, 'POST /api/connections/:id/activate failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/connections/:id/deactivate', (req, res) => {
  try {
    const id = Number(req.params.id);
    deactivateConnection(id);
    db.prepare(`UPDATE connections SET active = 0 WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'POST /api/connections/:id/deactivate failed');
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/connections/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const live = getConnectionStatus(id);
  const row = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ ok: false, message: 'not found' });
  res.json({ ok: true, connection: { ...row, liveStatus: live } });
});

/** Why: expose FC parameters received via MAVLink PARAM_VALUE messages. */
app.get('/api/connections/:id/params', (req, res) => {
  const id = Number(req.params.id);
  const params = getConnectionParams(id);
  if (params === null) return res.status(404).json({ ok: false, message: 'connection not active or not found' });
  res.json({ ok: true, params, count: Object.keys(params).length });
});

/** Why: re-request parameters from FC on demand (e.g. after a write). */
app.post('/api/connections/:id/request-params', (req, res) => {
  const id = Number(req.params.id);
  const mav = getMavlinkConnection(id);
  if (!mav) return res.status(404).json({ ok: false, message: 'connection not active or not found' });
  if (!mav.connected) return res.status(422).json({ ok: false, message: 'not connected' });
  try {
    mav.requestParams();
    res.json({ ok: true, message: 'PARAM_REQUEST_LIST sent — פרמטרים יגיעו תוך שניות' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/** Why: terrain map shows FC mission path; what: triggers MAVLink mission download on the active connection. */
app.post('/api/mavlink/mission-refresh', (_req, res) => {
  const conn = getActiveConnection();
  if (!conn?.connected) return res.status(422).json({ ok: false, message: 'אין חיבור MAVLink פעיל' });
  conn.refreshMissionToCache()
    .then((r) => res.json({ ok: true, ...r }))
    .catch((err) => {
      logger.warn({ err: err?.message }, 'mission-refresh failed');
      res.status(500).json({ ok: false, message: err?.message || 'mission refresh failed' });
    });
});

/** Why: list available serial ports so user doesn't need to guess COM port names. */
app.get('/api/connections/ports/list', async (_req, res) => {
  const ports = await listSerialPorts();
  res.json({ ok: true, ports: ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || null, serialNumber: p.serialNumber || null })) });
});

// ---------------------------------------------------------------------------
// Auto-Config: recommendation-only endpoints (no FC writes happen here)
// ---------------------------------------------------------------------------

/** Return supported component types for the wizard dropdown. */
app.get('/api/auto-config/components', (_req, res) => {
  res.json({ ok: true, components: listComponentTypes() });
});

/**
 * Build a configuration recipe.
 * Body: { componentType, port?, symptoms, liveParams? }
 * Returns: { ok, recipe: { summary, checks, param_changes, warnings } }
 * SAFETY: this endpoint is read-only / recommendation-only. It never writes to the FC.
 */
app.post('/api/auto-config/plan', async (req, res) => {
  const { componentType, port, symptoms, liveParams, telemetrySnapshot } = req.body || {};
  if (!componentType || !symptoms) {
    return res.status(400).json({ ok: false, message: 'componentType ו-symptoms נדרשים' });
  }
  // Enrich liveParams with current FC params if a connection is active.
  let resolvedLive = liveParams || null;
  try {
    const conn = getActiveConnection?.();
    if (conn?.connected) {
      const fcParams = getConnectionParams(conn.id) || {};
      resolvedLive = { ...fcParams, ...resolvedLive };
    }
  } catch { /* best-effort */ }

  const result = await buildAutoConfigRecipe({
    componentType,
    port: port || null,
    symptoms,
    liveParams: resolvedLive,
    telemetrySnapshot: telemetrySnapshot || null,
  });
  res.json(result);
});

/** Why: serve the SPA only after API routes so /api/* is never shadowed by files under public/. What: static assets for the browser UI. */}
