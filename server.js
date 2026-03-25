import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import os from 'os';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import multer from 'multer';
import { openDatabase, uploadsDir, projectRoot } from './lib/db.mjs';
import { getGeminiModelInfo } from './lib/gemini-model.mjs';
import { runAdvisor } from './lib/gemini-advisor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Why: load .env next to server.js regardless of process cwd (e.g. Cursor terminals). What: populates process.env before routes read GEMINI_API_KEY. */
dotenv.config({ path: path.join(__dirname, '.env') });

const db = openDatabase();

const app = express();
const PORT = Number(process.env.PORT) || 4010;
const APP_VERSION = '1.01.27';

const jetsonState = {
  online: false,
  lastSeen: null,
  cpuLoadPct: null,
  tempC: null,
  memPct: null,
  rebootRequests: 0,
  /** Why: track consecutive missed heartbeats for packet-loss estimate. What: incremented each 5 s tick, reset on heartbeat. */
  missedBeats: 0,
  totalBeats: 0,
};

/** Why: receive real-time vision output from companion (Jetson). What: stores latest frame metadata for UI display and advisor context. */
const visionState = {
  lateralOffsetM: null,
  headingErrorDeg: null,
  confidence: null,
  frameTimestamp: null,
  frameCount: 0,
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'upload').replace(/[^\w.\-]+/g, '_').slice(0, 120);
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
});

/** Why: parse JSON bodies for all API routes. What: runs before route handlers that read req.body. */
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    project: 'vision-landing-console',
    version: APP_VERSION,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: getGeminiModelInfo(),
    githubIngestConfigured: Boolean(process.env.GITHUB_INGEST_SECRET),
  });
});

function jetsonStatusHandler(_req, res) {
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
    packetLossPct,
    linkQualityPct,
  });
}

/** Why: track beat counts for packet-loss estimate; reset missedBeats on receipt. What: increments totalBeats, zeroes missedBeats. */
function jetsonHeartbeatHandler(req, res) {
  const { cpuLoadPct, tempC, memPct } = req.body || {};
  jetsonState.lastSeen = new Date().toISOString();
  jetsonState.online = true;
  jetsonState.totalBeats += 1;
  jetsonState.missedBeats = 0;
  if (Number.isFinite(cpuLoadPct)) jetsonState.cpuLoadPct = Number(cpuLoadPct);
  if (Number.isFinite(tempC)) jetsonState.tempC = Number(tempC);
  if (Number.isFinite(memPct)) jetsonState.memPct = Number(memPct);
  res.json({ ok: true });
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

app.get('/api/jetson/status', jetsonStatusHandler);
app.post('/api/jetson/heartbeat', jetsonHeartbeatHandler);
app.post('/api/jetson/reboot-request', jetsonRebootRequestHandler);

app.get('/api/rpi/status', jetsonStatusHandler);
app.post('/api/rpi/heartbeat', jetsonHeartbeatHandler);
app.post('/api/rpi/reboot-request', jetsonRebootRequestHandler);

/** Why: increment missedBeats when no heartbeat arrives within a 5 s window. What: runs server-side every 5 s; used to derive packet-loss % in jetsonStatusHandler. */
setInterval(() => {
  const last = jetsonState.lastSeen ? Date.parse(jetsonState.lastSeen) : 0;
  if (last > 0 && (Date.now() - last) > 5500) {
    jetsonState.missedBeats += 1;
  }
}, 5000);

/** Why: accept real-time vision output from Jetson companion over HTTP. What: stores latest lateral offset, heading error, and confidence for UI polling. */
app.post('/api/vision/frame', (req, res) => {
  const { lateralOffsetM, headingErrorDeg, confidence } = req.body || {};
  if (Number.isFinite(lateralOffsetM)) visionState.lateralOffsetM = Number(lateralOffsetM);
  if (Number.isFinite(headingErrorDeg)) visionState.headingErrorDeg = Number(headingErrorDeg);
  if (Number.isFinite(confidence)) visionState.confidence = Math.max(0, Math.min(1, Number(confidence)));
  visionState.frameTimestamp = new Date().toISOString();
  visionState.frameCount += 1;
  res.json({ ok: true, frameCount: visionState.frameCount });
});

/** Why: UI polls this to display live vision metrics. What: returns latest visionState with computed age. */
app.get('/api/vision/latest', (_req, res) => {
  const ageMs = visionState.frameTimestamp ? (Date.now() - Date.parse(visionState.frameTimestamp)) : null;
  res.json({ ok: true, ...visionState, ageMs });
});

/** Why: Visual SLAM / VIO companion sends its pose estimate so the UI can show GPS-free position and the advisor can reason about it. What: stores latest SLAM pose for display and future EKF injection. */
const slamState = {
  posX: null, posY: null, posZ: null,
  yawDeg: null,
  mapQuality: null,
  loopClosures: 0,
  frameTimestamp: null,
};

app.post('/api/vision/slam-pose', (req, res) => {
  const { posX, posY, posZ, yawDeg, mapQuality, loopClosures } = req.body || {};
  if (Number.isFinite(posX)) slamState.posX = Number(posX);
  if (Number.isFinite(posY)) slamState.posY = Number(posY);
  if (Number.isFinite(posZ)) slamState.posZ = Number(posZ);
  if (Number.isFinite(yawDeg)) slamState.yawDeg = Number(yawDeg);
  if (Number.isFinite(mapQuality)) slamState.mapQuality = Math.max(0, Math.min(1, Number(mapQuality)));
  if (Number.isFinite(loopClosures)) slamState.loopClosures = Number(loopClosures);
  slamState.frameTimestamp = new Date().toISOString();
  res.json({ ok: true });
});

app.get('/api/vision/slam-latest', (_req, res) => {
  const ageMs = slamState.frameTimestamp ? (Date.now() - Date.parse(slamState.frameTimestamp)) : null;
  res.json({ ok: true, ...slamState, ageMs });
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
  broadcastSse('telemetry', {
    jetson: { online: jetsonOnline, ageMs: jetsonAgeMs, cpuLoadPct: jetsonState.cpuLoadPct, tempC: jetsonState.tempC, memPct: jetsonState.memPct, linkQualityPct },
    vision: { ...visionState, ageMs: visionAgeMs },
    slam: { ...slamState, ageMs: slamAgeMs },
  });
}, 300);

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
    res.status(500).json({ ok: false, message: err?.message || 'upload failed' });
  }
});

/** Why: receive automatic code updates from GitHub Actions. What: validates token, stores digest row for Gemini context. */
app.post('/api/integrations/github/ingest', (req, res) => {
  const secret = process.env.GITHUB_INGEST_SECRET;
  const token = req.get('X-Ingest-Token');
  if (!secret || token !== secret) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  const body = req.body || {};
  const commit_sha = String(body.commit || body.commit_sha || '').trim() || null;
  const branch = String(body.branch || '').trim() || null;
  const files_changed_text = typeof body.filesChangedText === 'string'
    ? body.filesChangedText
    : (Array.isArray(body.filesChanged) ? body.filesChanged.join('\n') : JSON.stringify(body.files || []));
  const payload_json = JSON.stringify(body).slice(0, 100_000);

  db.prepare(
    `INSERT INTO code_digest (commit_sha, branch, files_changed_text, payload_json) VALUES (?,?,?,?)`,
  ).run(commit_sha, branch, files_changed_text?.slice(0, 50_000) || '', payload_json);

  res.json({ ok: true, message: 'digest stored' });
});

app.post('/api/advisor-chat', async (req, res) => {
  const question = String(req.body?.question || '');
  try {
    const flightId = req.body?.flightId != null ? Number(req.body.flightId) : null;
    const now = Date.now();
    const visionAgeMs = visionState.frameTimestamp ? (now - Date.parse(visionState.frameTimestamp)) : null;
    const jetsonLast = jetsonState.lastSeen ? Date.parse(jetsonState.lastSeen) : 0;
    const { reply, source } = await runAdvisor({
      question,
      params: req.body?.params || {},
      db,
      flightId: Number.isInteger(flightId) && flightId > 0 ? flightId : null,
      liveState: {
        vision: { ...visionState, ageMs: visionAgeMs, fresh: visionAgeMs != null && visionAgeMs < 5000 },
        jetson: { online: jetsonLast > 0 && (now - jetsonLast) < 15000, cpuLoadPct: jetsonState.cpuLoadPct, tempC: jetsonState.tempC },
        slam: { ...slamState, ageMs: slamState.frameTimestamp ? (now - Date.parse(slamState.frameTimestamp)) : null },
      },
    });
    res.json({ ok: true, reply, source });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'advisor failed' });
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
    return res.status(500).json({ ok: false, message: err?.message || 'apply failed' });
  }
});

/** Why: default ArduPilot target set for Vision Landing. What: cloned into mutable store so the UI can edit and persist via /api/vision/config. */
const ARDU_TARGET_DEFAULTS = {
  SERIAL2_PROTOCOL: 2, SERIAL2_BAUD: 921, SR2_EXT_STAT: 5, SR2_POSITION: 10, SR2_RC_CHAN: 5,
  SR2_EXTRA1: 10, SR2_EXTRA2: 10, EK3_ENABLE: 1, AHRS_EKF_TYPE: 3, EK3_GPS_TYPE: 0,
  EK3_ALT_SOURCE: 1, PLND_ENABLED: 1, PLND_TYPE: 1, PLND_BUS: 0, PLND_LAG: 0.02,
  PLND_XY_DIST_MAX: 5, PLND_STRICT: 0, LOG_DISARMED: 1, LOG_REPLAY: 1, LOG_BITMASK: 65535,
  LAND_SPEED: 50, LAND_SPEED_HIGH: 0, LAND_ALT_LOW: 1000, LAND_ABORT_PWM: 900,
  FS_THR_ENABLE: 1, FS_THR_VALUE: 975, ARMING_CHECK: 1,
};
/** Why: live target map for READ/diff/WRITE — same object shape as defaults, merged from client POST. What: single source for FC target until real MAVLink applies overrides. */
let arduTargetParams = { ...ARDU_TARGET_DEFAULTS };
/** Why: optional server-side copy of console slider profile (מרכז פרמטרים). What: GET returns for READ; POST from client WRITE merges here. */
let visionProfileStore = {};

/** Why: unified READ for the merged settings tab — profile sliders + ArduPilot target blob. What: JSON for client to hydrate UI. */
app.get('/api/vision/config', (_req, res) => {
  res.json({
    ok: true,
    profile: Object.keys(visionProfileStore).length ? visionProfileStore : null,
    arduTarget: { ...arduTargetParams },
  });
});

/** Why: unified WRITE — persist console profile and editable ArduPilot targets before hardware WRITE. What: shallow-merge body fields into server stores. */
app.post('/api/vision/config', (req, res) => {
  const body = req.body || {};
  if (body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)) {
    visionProfileStore = { ...visionProfileStore, ...body.profile };
  }
  if (body.arduTarget && typeof body.arduTarget === 'object' && !Array.isArray(body.arduTarget)) {
    for (const [k, v] of Object.entries(body.arduTarget)) {
      if (k in arduTargetParams) {
        const cur = arduTargetParams[k];
        arduTargetParams[k] = typeof cur === 'number' ? Number(v) : v;
      }
    }
  }
  res.json({ ok: true, profile: visionProfileStore, arduTarget: { ...arduTargetParams } });
});

let arduCurrentParams = null;

/** Why: READ needs current device state vs editable target. What: returns known state or disconnected flag and live arduTargetParams. */
app.get('/api/ardu/params', (_req, res) => {
  res.json({ ok: true, connected: arduCurrentParams != null, current: arduCurrentParams, target: { ...arduTargetParams } });
});

/** Why: WRITE applies current editable target set to simulated FC state. What: in real mode would use MAVProxy; for now copies arduTargetParams into arduCurrentParams. */
app.post('/api/ardu/params/write', (_req, res) => {
  arduCurrentParams = { ...arduTargetParams };
  const n = Object.keys(arduTargetParams).length;
  res.json({ ok: true, written: n, message: `WRITE SUCCESS — ${n} פרמטרים נכתבו` });
});

/** Why: terrain coverage map — stores GPS-referenced cells where enough visual data exists for image-based navigation. What: persisted in memory; Jetson POSTs cells after each SLAM frame. */
const terrainCoverage = [];

app.get('/api/terrain/coverage', (_req, res) => {
  res.json({ ok: true, cells: terrainCoverage, total: terrainCoverage.length });
});

app.post('/api/terrain/coverage', (req, res) => {
  const cells = req.body?.cells;
  if (Array.isArray(cells)) {
    cells.forEach((c) => {
      if (c.lat != null && c.lon != null) {
        terrainCoverage.push({
          ...c,
          altM: c.altM != null ? Number(c.altM) : (c.aglM != null ? Number(c.aglM) : undefined),
        });
      }
    });
  }
  res.json({ ok: true, total: terrainCoverage.length });
});

/** Why: pilot wants to see all logs ever uploaded without switching flight contexts. What: joins log_artifacts + flights so every log is visible in one place. */
app.get('/api/flights/all-logs', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT la.id, la.flight_id, la.source, la.original_name, la.mime, la.size_bytes, la.uploaded_at,
             f.title as flight_title
      FROM log_artifacts la JOIN flights f ON la.flight_id = f.id
      ORDER BY la.uploaded_at DESC LIMIT 200
    `).all();
    res.json({ ok: true, logs: rows });
  } catch {
    res.json({ ok: true, logs: [] });
  }
});

/** Why: serve the SPA only after API routes so /api/* is never shadowed by files under public/. What: static assets for the browser UI. */
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Vision Landing Console v${APP_VERSION}: http://localhost:${PORT}`);
});
