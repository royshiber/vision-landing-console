/**
 * Rebuilds lib/routes/core-api.mjs from `git show master:server.js` (route block only, no advisor-chat).
 * Run: node scripts/pack-core-api.mjs
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const src = execSync('git show master:server.js', { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
const lines = src.split(/\r?\n/);
const uIdx = lines.findIndex((l) => l.trim().startsWith("app.use('/uploads'"));
const hIdx = lines.findIndex((l) => l.includes("app.get('/api/health'"));
if (uIdx < 0 || hIdx < 0) throw new Error(`anchors: uploads=${uIdx} health=${hIdx}`);

let body = lines.slice(hIdx, uIdx).join('\n');

body = body.replace(
  /app\.post\('\/api\/advisor-chat',[\s\S]*?\n\}\);\n/,
  '',
);

 body = body.replace(/_semverGte/g, 'semverGte');

 const vi = body.indexOf("app.get('/api/vision/config'");
 const ar = body.indexOf('const ARDU_TARGET_DEFAULTS');
 if (ar >= 0 && vi > ar) body = body.slice(0, ar) + body.slice(vi);
 body = body.replace(/^let arduCurrentParams = null;\n\n/m, '');

 body = body.replace(/\bvisionProfileStore\b/g, 'ctx.visionProfileStore');
 body = body.replace(/\barduTargetParams\b/g, 'ctx.arduTargetParams');
 body = body.replace(/\barduCurrentParams\b/g, 'ctx.arduCurrentParams');

 body = body.replace(
   /\nconst slamState = \{\n  posX: null, posY: null, posZ: null,\n  yawDeg: null,\n  mapQuality: null,\n  loopClosures: 0,\n  frameTimestamp: null,\n\};\n\napp\.post\('\/api\/vision\/slam-pose'/,
   "\n\napp.post('/api/vision/slam-pose'",
 );

const header = `import path from 'path';
import os from 'os';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { getGeminiModelInfo } from '../gemini-model.mjs';
import { readJetsonVersionState } from '../jetson-version-store.mjs';
import { logger } from '../logger.mjs';
import {
  activateConnection,
  deactivateConnection,
  getAllConnectionStatuses,
  getConnectionStatus,
  getConnectionParams,
  listSerialPorts,
} from '../mavlink-connection.mjs';
import { requireCompanionToken } from '../companion-auth.mjs';
import { COMPAT, semverGte } from '../compat-semver.mjs';
import { projectRoot } from '../db.mjs';

/**
 * @param {import('express').Application} app
 * @param {object} ctx
 */
export function registerCoreApi(app, ctx) {
  const {
    db,
    APP_VERSION,
    upload,
    jetsonState,
    visionState,
    slamState,
    visionNavModeState,
  } = ctx;

  app.get('/api/meta', (_req, res) => {
    res.json({ appVersion: APP_VERSION });
  });

`;

const footer = `}\n`;

/* Jetson + RPI + companion: replace the three static jetson + three rpi lines. */
const jl = `for (const _jlBase of ['/api/jetson', '/api/rpi']) {
  app.get(\`\${_jlBase}/status\`, jetsonStatusHandler);
  app.post(\`\${_jlBase}/heartbeat\`, requireCompanionToken, jetsonHeartbeatHandler);
  app.post(\`\${_jlBase}/reboot-request\`, requireCompanionToken, jetsonRebootRequestHandler);
}`;

if (!body.includes("for (const _jlBase of ['/api/jetson'") && !body.includes('`${_jlBase}/status`')) {
  body = body.replace(
    /app\.get\('\/api\/jetson\/status', jetsonStatusHandler\);\napp\.post\('\/api\/jetson\/heartbeat', jetsonHeartbeatHandler\);\napp\.post\('\/api\/jetson\/reboot-request', jetsonRebootRequestHandler\);\n\n/,
    `${jl}\n\n`,
  );
  body = body.replace(
    /\napp\.get\('\/api\/rpi\/status', jetsonStatusHandler\);\napp\.post\('\/api\/rpi\/heartbeat', jetsonHeartbeatHandler\);\napp\.post\('\/api\/rpi\/reboot-request', jetsonRebootRequestHandler\);\n/,
    '\n',
  );
}

body = body.replace("app.post('/api/vision/frame', (req, res) => {", "app.post('/api/vision/frame', requireCompanionToken, (req, res) => {");
body = body.replace("app.post('/api/vision/slam-pose', (req, res) => {", "app.post('/api/vision/slam-pose', requireCompanionToken, (req, res) => {");

/* Rich telemetry: mavlink + appVersion + visionNav; Jetson version store. */
const telemRe =
  /setInterval\(\(\) => \{\n  if \(sseClients\.size === 0\) return;\n  const now = Date\.now\(\);\n  const jetsonLast = jetsonState\.lastSeen \? Date\.parse\(jetsonState\.lastSeen\) : 0;\n  const jetsonOnline = jetsonLast > 0 && \(now - jetsonLast\) < 15000;\n  const jetsonAgeMs = jetsonLast \? \(now - jetsonLast\) : null;\n  const total = jetsonState\.totalBeats \+ jetsonState\.missedBeats;\n  const linkQualityPct = total > 0 \? Math\.max\(0, 100 - Math\.round\(\(jetsonState\.missedBeats \/ total\) \* 100\)\) : null;\n  const visionAgeMs = visionState\.frameTimestamp \? \(now - Date\.parse\(visionState\.frameTimestamp\)\) : null;\n  const slamAgeMs = slamState\.frameTimestamp \? \(now - Date\.parse\(slamState\.frameTimestamp\)\) : null;\n  broadcastSse\('telemetry', \{\n    jetson: \{ online: jetsonOnline, ageMs: jetsonAgeMs, cpuLoadPct: jetsonState\.cpuLoadPct, tempC: jetsonState\.tempC, memPct: jetsonState\.memPct, linkQualityPct \},\n    vision: \{ \.\.\.visionState, ageMs: visionAgeMs \},\n    slam: \{ \.\.\.slamState, ageMs: slamAgeMs \},\n    mavlinkConnections: getAllConnectionStatuses\(\),\n  \}\);\n\}, 300\);/;

const telemRepl = `setInterval(() => {
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
  const mav = getAllConnectionStatuses().find((s) => s?.connected) || null;
  const mavlink = mav
    ? {
        connected: true,
        armed: null,
        armedKnown: false,
        autopilotName: mav.autopilotName || null,
        vehicleType: mav.vehicleType || null,
      }
    : {
        connected: false,
        armed: null,
        armedKnown: false,
        autopilotName: null,
        vehicleType: null,
      };
  broadcastSse('telemetry', {
    appVersion: APP_VERSION,
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
}, 300);`;

if (telemRe.test(body)) {
  body = body.replace(telemRe, telemRepl);
} else {
  body = body.replace(
    /broadcastSse\('telemetry', \{\n    jetson:/,
    "broadcastSse('telemetry', {\n    appVersion: APP_VERSION,\n    jetson:",
  );
}

const out = header + body + footer;
const outPath = path.join(root, 'lib', 'routes', 'core-api.mjs');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out, 'utf8');
console.log('Wrote', outPath, 'len', out.length);
