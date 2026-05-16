import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { readFileSync, statSync } from 'fs';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { openDatabase, uploadsDir } from './lib/db.mjs';
import { logger } from './lib/logger.mjs';
import { buildArduTargetDefaults } from './lib/param-schema.mjs';
import { registerHttpRoutes } from './lib/routes/http-register.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Why: load .env next to server.js regardless of process cwd (e.g. Cursor terminals). What: populates process.env before routes read secrets. */
dotenv.config({ path: path.join(__dirname, '.env') });

/**
 * Why: UI badge + index.html must match the app actually running.
 * What: prefer `version.js` next to this `server.js` (standalone Vision Landing Console).
 *       Only if missing/unreadable, fall back to monorepo `client/src/version.js`.
 *       Previous order (monorepo first) caused wrong versions when an unrelated/old file
 *       existed at ../../client/src/version.js on disk.
 */
function readMonorepoAppVersion() {
  const candidates = [
    path.join(__dirname, 'version.js'),
    path.join(__dirname, '../../client/src/version.js'),
  ];
  for (const versionPath of candidates) {
    try {
      const text = readFileSync(versionPath, 'utf8');
      const m = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

let db;
try {
  db = openDatabase();
} catch (err) {
  logger.fatal({ err }, 'Cannot open database — exiting');
  process.exit(1);
}

export const app = express();
const PORT = Number(process.env.PORT) || 4010;
/** Why: default bind to loopback; set HOST=0.0.0.0 in .env to expose on LAN (use COMPANION_SHARED_SECRET for push APIs). */
const HOST = (process.env.HOST || '127.0.0.1').trim();
const APP_VERSION = readMonorepoAppVersion();
function getAppVersion() {
  return readMonorepoAppVersion();
}

const jetsonState = {
  online: false,
  lastSeen: null,
  cpuLoadPct: null,
  tempC: null,
  memPct: null,
  rebootRequests: 0,
  missedBeats: 0,
  totalBeats: 0,
  agentVersion: null,
  internalFwVersion: null,
  fcFirmwareVersion: null,
};

const JETSON_COMPANION_BASE_URL = (process.env.JETSON_COMPANION_BASE_URL || '').trim();

const visionNavModeState = { mode: 'prior_mission_map' };

const visionState = {
  lateralOffsetM: null,
  headingErrorDeg: null,
  confidence: null,
  frameTimestamp: null,
  frameCount: 0,
  /** Optional WGS84 from companion (optical / VIO fused to lat-lon for map). */
  navLat: null,
  navLon: null,
};

const slamState = {
  posX: null,
  posY: null,
  posZ: null,
  yawDeg: null,
  mapQuality: null,
  loopClosures: 0,
  frameTimestamp: null,
};

/** Why: default ArduPilot target set for Vision Landing. What: merged into mutable map for READ/diff/WRITE. */
const ARDU_TARGET_DEFAULTS = buildArduTargetDefaults();

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

/** Why: limit LLM cost / abuse on open networks. What: only /api/advisor-chat (UI still works; 429 if exceeded). */
const advisorChatLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: '12mb' }));

/** Why: one mutable bag for Ardu/vision config so ctx.arduCurrentParams assignments in routes update this object. */
const routeCtx = {
  db,
  APP_VERSION,
  getAppVersion,
  upload,
  jetsonState,
  visionState,
  slamState,
  visionNavModeState,
  JETSON_COMPANION_BASE_URL,
  advisorChatLimiter,
  arduTargetParams: { ...ARDU_TARGET_DEFAULTS },
  visionProfileStore: {},
  arduCurrentParams: null,
};

registerHttpRoutes(app, routeCtx);

/** Why: serve the SPA only after API routes so /api/* is never shadowed by files under public/. What: static assets for the browser UI. */
app.use('/uploads', express.static(uploadsDir));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

/** Why: index.html contains __APP_VERSION__ placeholders (badge label + script cache-bust).
 *  What: render index on request with the current APP_VERSION injected, so the UI always
 *        reflects the backend version without editing the HTML. Cached in memory for speed. */
const _indexHtmlPath = path.join(__dirname, 'public', 'index.html');
let _indexHtmlCache = null;
function renderIndexHtml() {
  const runtimeVersion = getAppVersion();
  try {
    const mtimeMs = statSync(_indexHtmlPath).mtimeMs;
    if (_indexHtmlCache && _indexHtmlCache.v === runtimeVersion && _indexHtmlCache.mtimeMs === mtimeMs) {
      return _indexHtmlCache.html;
    }
    const raw = readFileSync(_indexHtmlPath, 'utf8');
    const html = raw.replace(/__APP_VERSION__/g, runtimeVersion);
    _indexHtmlCache = { v: runtimeVersion, mtimeMs, html };
    return html;
  } catch (err) {
    logger.error({ err }, 'Failed to render index.html');
    return `<h1>Vision Landing Console</h1><p>Cannot load index.html: ${err.message}</p>`;
  }
}
app.get(['/', '/index.html'], (_req, res) => {
  res.type('html').set('Cache-Control', 'no-cache').send(renderIndexHtml());
});

app.use(express.static(path.join(__dirname, 'public')));

/** Why: catch any unhandled errors thrown in route handlers. What: logs the error and returns a safe 500 JSON response. */
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled route error');
  const status = typeof err.status === 'number' ? err.status : 500;
  res.status(status).json({ ok: false, message: err?.message || 'Internal server error' });
});

/** Why: only listen when run directly (not when imported for tests). What: allows test files to import app without binding to a port.
 *  Edge case: PM2 fork mode loads via dynamic import() so process.argv[1] points to PM2's container script — detect via PM2_HOME env. */
const _isMain = process.argv[1] === fileURLToPath(import.meta.url) || !!process.env.PM2_HOME;
if (_isMain) {
  const server = app.listen(PORT, HOST, () => {
    logger.info({ port: PORT, host: HOST, version: APP_VERSION }, `Vision Landing Console started`);
    const hostLabel = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Vision Landing Console v${APP_VERSION}: http://${hostLabel}:${PORT}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal({ port: PORT }, `Port ${PORT} is already in use. Stop the other process or set PORT=4011 and restart.`);
    } else {
      logger.fatal({ err }, 'Server listen error');
    }
    process.exit(1);
  });
}
