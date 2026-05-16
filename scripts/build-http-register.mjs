/**
 * One-shot: reads server.js (UTF-8), extracts the API route block, and writes lib/routes/http-register.mjs.
 * Run from repo root: node scripts/build-http-register.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const lines = src.split(/\r?\n/);
const staticIdx = lines.findIndex((l) => l.startsWith("app.use('/uploads'"));
if (staticIdx < 0) throw new Error('Could not find app.use upload line');
/** Lines 1-based: from app.get /api/meta through the last route before static. */
let body = lines.slice(134, staticIdx).join('\n');

body = body.replace(
  /app\.get\('\/api\/meta', \(_req, res\) => \{\n  res\.json\(\{ appVersion: readMonorepoAppVersion\(\) \}\);\n\}\);/,
  `app.get('/api/meta', (_req, res) => {
  res.json({ appVersion: APP_VERSION });
});`,
);

body = body.replace(
  /app\.get\('\/api\/jetson\/status', jetsonStatusHandler\);\napp\.post\('\/api\/jetson\/heartbeat', jetsonHeartbeatHandler\);\napp\.post\('\/api\/jetson\/reboot-request', jetsonRebootRequestHandler\);/,
  `for (const _jlBase of ['/api/jetson', '/api/rpi']) {
  app.get(\`\${_jlBase}/status\`, jetsonStatusHandler);
  app.post(\`\${_jlBase}/heartbeat\`, requireCompanionToken, jetsonHeartbeatHandler);
  app.post(\`\${_jlBase}/reboot-request\`, requireCompanionToken, jetsonRebootRequestHandler);
}`,
);

body = body.replace(
  /\napp\.get\('\/api\/rpi\/status', jetsonStatusHandler\);\napp\.post\('\/api\/rpi\/heartbeat', jetsonHeartbeatHandler\);\napp\.post\('\/api\/rpi\/reboot-request', jetsonRebootRequestHandler\);\n/,
  '\n',
);

body = body.replace("app.post('/api/vision/frame', (req, res) => {", "app.post('/api/vision/frame', requireCompanionToken, (req, res) => {");
body = body.replace("app.post('/api/vision/slam-pose', (req, res) => {", "app.post('/api/vision/slam-pose', requireCompanionToken, (req, res) => {");
body = body.replace(
  "app.post('/api/advisor-chat', async (req, res) => {",
  "app.post('/api/advisor-chat', advisorChatLimiter, async (req, res) => {",
);

body = body.replace(/_semverGte/g, 'semverGte');

const vi = body.indexOf("app.get('/api/vision/config'");
const ar = body.indexOf('const ARDU_TARGET_DEFAULTS');
if (ar >= 0 && vi > ar) body = body.slice(0, ar) + body.slice(vi);

body = body.replace(/^let arduCurrentParams = null;\n\n/m, '');

body = body.replace(
  /\nconst slamState = \{\n  posX: null, posY: null, posZ: null,\n  yawDeg: null,\n  mapQuality: null,\n  loopClosures: 0,\n  frameTimestamp: null,\n\};\n\napp\.post\('\/api\/vision\/slam-pose'/,
  "\n\napp.post('/api/vision/slam-pose'",
);

body = body.replace(
  /app\.post\('\/api\/advisor\/actions\/:id\/apply', async \(req, res\) => \{\n  try \{\n    const actionId = req\.params\.id;\n    const mavConn = getActiveConnection\?\.\(\);\n    const ctx = \{\n      mavConn,\n      appVersion: APP_VERSION,\n      fcFirmware: mavConn\?\.autopilotName \|\| null,\n    \};\n    const result = await applyAction\(db, actionId, ctx\);/,
  "app.post('/api/advisor/actions/:id/apply', async (req, res) => {\n  try {\n    const actionId = req.params.id;\n    const mavConn = getActiveConnection?.();\n    const applyCtx = {\n      mavConn,\n      appVersion: APP_VERSION,\n      fcFirmware: mavConn?.autopilotName || null,\n    };\n    const result = await applyAction(db, actionId, applyCtx);",
);

body = body.replace(
  /app\.post\('\/api\/advisor\/actions\/:id\/rollback', async \(req, res\) => \{\n  try \{\n    const actionId = req\.params\.id;\n    const mavConn = getActiveConnection\?\.\(\);\n    const ctx = \{ mavConn, appVersion: APP_VERSION \};\n    const result = await rollbackAction\(db, actionId, ctx\);/,
  "app.post('/api/advisor/actions/:id/rollback', async (req, res) => {\n  try {\n    const actionId = req.params.id;\n    const mavConn = getActiveConnection?.();\n    const applyCtx = { mavConn, appVersion: APP_VERSION };\n    const result = await rollbackAction(db, actionId, applyCtx);",
);

body = body.replace(/\bvisionProfileStore\b/g, 'ctx.visionProfileStore');
body = body.replace(/\barduTargetParams\b/g, 'ctx.arduTargetParams');
body = body.replace(/\barduCurrentParams\b/g, 'ctx.arduCurrentParams');

body = body.replace(
  /broadcastSse\('telemetry', \{\n( *)jetson:/,
  "broadcastSse('telemetry', {\n$1/** Why: client badge/title track running server. */\n$1appVersion: APP_VERSION,\n$1jetson:",
);

const header = `import path from 'path';
import os from 'os';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { getGeminiModelInfo } from '../gemini-model.mjs';
import { runAdvisor } from '../gemini-advisor.mjs';
import { DEFAULT_RELEASES, isKnownJetsonVersion } from '../jetson-releases.mjs';
import { readJetsonVersionState, writeJetsonVersionState } from '../jetson-version-store.mjs';
import { listIssues, getIssueMessages, markIssueResolved } from '../chat-memory.mjs';
import {
  applyAction,
  rollbackAction,
  getRecentAudit,
  getJetsonProfile,
} from '../advisor-apply.mjs';
import { describeAllowlists } from '../advisor-actions.mjs';
import {
  openSession, getActiveSession, closeSession,
  getPendingChangesSummary, revertAllChanges,
} from '../session-baseline.mjs';
import { logger } from '../logger.mjs';
import {
  activateConnection,
  deactivateConnection,
  getAllConnectionStatuses,
  getConnectionStatus,
  getConnectionParams,
  listSerialPorts,
  getActiveConnection,
} from '../mavlink-connection.mjs';
import { projectRoot } from '../db.mjs';
import { requireCompanionToken } from '../companion-auth.mjs';
import { COMPAT, semverGte } from '../compat-semver.mjs';

/** @param {import('express').Application} app @param {object} ctx */
export function registerHttpRoutes(app, ctx) {
  const {
    db,
    APP_VERSION,
    upload,
    jetsonState,
    visionState,
    slamState,
    visionNavModeState,
    JETSON_COMPANION_BASE_URL,
    advisorChatLimiter,
  } = ctx;

`;

const out = `${header}${body}\n}\n`;
fs.mkdirSync(path.join(root, 'lib', 'routes'), { recursive: true });
fs.writeFileSync(path.join(root, 'lib', 'routes', 'http-register.mjs'), out, 'utf8');
console.log('Wrote lib/routes/http-register.mjs');
