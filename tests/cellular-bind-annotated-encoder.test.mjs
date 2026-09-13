import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.mjs';
import { registerDualLinkApi } from '../lib/routes/dual-link-api.mjs';
import { resetDualLinkRuntimeForTests } from '../lib/dual-link-runtime.mjs';
import { deactivateConnectionsByRole } from '../lib/mavlink-connection.mjs';
import {
  ANNOTATED_VIDEO_REASON_HE,
  annotatedStreamPresent,
  annotatedVideoAvailability,
  isRealAnnotatedStreamUrl,
} from '../lib/dual-link.mjs';
import { buildFieldPreflight, FIELD_PREFLIGHT_IDS } from '../lib/field-preflight.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pack = path.join(repoRoot, 'scripts', 'jetson-cellular');
const companion = path.join(repoRoot, 'scripts', 'jetson-companion');

function lastJson(stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  expect(start, `JSON in stdout:\n${stdout}`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(text.slice(start, end + 1));
}

function runEndpoint(args, env = {}) {
  return spawnSync(path.join(pack, 'cellular-mavlink-endpoint.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: pack,
  });
}

function runEncoder(args, env = {}) {
  return spawnSync(path.join(pack, 'annotated-encoder-status.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: pack,
  });
}

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('cellular MAVLink optional bind honesty', () => {
  it('dry-run and --status never bind and stay modem_absent without a status file', () => {
    const missing = path.join(os.tmpdir(), `airvix-bind-missing-${Date.now()}.status`);
    const dry = runEndpoint(['--dry-run'], { AIRVIX_E3372_STATUS_FILE: missing });
    expect(dry.status, dry.stderr).toBe(0);
    const dryJson = lastJson(dry.stdout);
    expect(dryJson.bound).toBe(false);
    expect(dryJson.dryRun).toBe(true);
    expect(dryJson.bindRequested).toBe(false);
    expect(dryJson.port).toBe(14560);
    expect(dryJson.statusFileMissing).toBe(true);
    expect(dryJson.reason).toBe('modem_absent');
    expect(dryJson.companionHttpCommandPath).toBe(false);

    const status = runEndpoint(['--status'], { AIRVIX_E3372_STATUS_FILE: missing });
    expect(status.status, status.stderr).toBe(0);
    const st = lastJson(status.stdout);
    expect(st.bound).toBe(false);
    expect(st.dryRun).toBe(true);
    expect(st.statusFileMissing).toBe(true);
    expect(st.modemPresent).toBe(false);
    expect(st.reason).toBe('modem_absent');
  });

  it('refuses --bind when the modem is absent', () => {
    const missing = path.join(os.tmpdir(), `airvix-bind-refuse-${Date.now()}.status`);
    const refused = runEndpoint(['--bind', '--once'], {
      AIRVIX_E3372_STATUS_FILE: missing,
      AIRVIX_CELLULAR_MOCK: '',
      CELLULAR_MODEM_MOCK: '',
      AIRVIX_CELLULAR_BIND_FORCE: '',
    });
    expect(refused.status).toBe(1);
    const body = lastJson(refused.stdout);
    expect(body.ok).toBe(false);
    expect(body.bound).toBe(false);
    expect(body.bindRequested).toBe(true);
    expect(body.bindAllowed).toBe(false);
    expect(body.reason).toBe('modem_absent');
    expect(body.noteHe).toMatch(/מודם לא מחובר/);
    expect(body.companionHttpCommandPath).toBe(false);
    expect(body.flightCommands).toBe(false);
  });

  it('binds documented UDP once under FORCE mock, then unbinds', () => {
    const port = 24000 + (process.pid % 1000);
    const bound = runEndpoint(['--bind', '--once'], {
      AIRVIX_CELLULAR_BIND_FORCE: '1',
      AIRVIX_CELLULAR_MAVLINK_PORT: String(port),
      AIRVIX_E3372_STATUS_FILE: path.join(os.tmpdir(), `airvix-bind-force-${Date.now()}.status`),
    });
    expect(bound.status, bound.stderr).toBe(0);
    const body = lastJson(bound.stdout);
    expect(body.ok).toBe(true);
    expect(body.bound).toBe(true);
    expect(body.once).toBe(true);
    expect(body.port).toBe(port);
    expect(body.companionHttpCommandPath).toBe(false);
    expect(body.flightCommands).toBe(false);
  });
});

describe('annotated encoder cellular-only honesty', () => {
  it('reports modem_absent by default and never invents frames', () => {
    const missing = path.join(os.tmpdir(), `airvix-enc-missing-${Date.now()}.status`);
    const result = runEncoder(['--dry-run'], {
      AIRVIX_E3372_STATUS_FILE: missing,
      AIRVIX_ANNOTATED_STREAM_URL: '',
      AIRVIX_ANNOTATED_STREAM_FILE: path.join(os.tmpdir(), `airvix-stream-missing-${Date.now()}.status`),
      AIRVIX_CELLULAR_MOCK: '',
      CELLULAR_MODEM_MOCK: '',
    });
    expect(result.status, result.stderr).toBe(0);
    const body = lastJson(result.stdout);
    expect(body.available).toBe(false);
    expect(body.streamPresent).toBe(false);
    expect(body.frames).toBe(false);
    expect(body.inventedFrames).toBe(false);
    expect(body.neverRadio).toBe(true);
    expect(body.radioSatisfies).toBe(false);
    expect(body.path).toBe('cellular');
    expect(body.reason).toBe('modem_absent');
    expect(body.annotated_pipeline).toBe('none');
    expect(body.annotated_fps).toBeNull();
  });

  it('reports stream_absent when a mock modem is present but no stream URL exists', () => {
    const result = runEncoder(['--status'], {
      AIRVIX_CELLULAR_MOCK: 'present',
      AIRVIX_ANNOTATED_STREAM_URL: '',
      AIRVIX_ANNOTATED_STREAM_FILE: path.join(os.tmpdir(), `airvix-stream-none-${Date.now()}.status`),
    });
    expect(result.status, result.stderr).toBe(0);
    const body = lastJson(result.stdout);
    expect(body.modemPresent).toBe(true);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('stream_absent');
    expect(body.streamPresent).toBe(false);
    expect(body.frames).toBe(false);
  });

  it('marks available only when a real stream URL exists', () => {
    const py = spawnSync('python3', [path.join(companion, 'annotated_encoder.py'), '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIRVIX_CELLULAR_MOCK: 'present',
        AIRVIX_ANNOTATED_STREAM_URL: 'rtsp://127.0.0.1:8554/annotated',
        AIRVIX_E3372_STATUS_FILE: path.join(os.tmpdir(), `airvix-enc-url-${Date.now()}.status`),
      },
      cwd: companion,
    });
    expect(py.status, py.stderr).toBe(0);
    const body = JSON.parse(py.stdout);
    expect(body.available).toBe(true);
    expect(body.streamPresent).toBe(true);
    expect(body.streamUrl).toBe('rtsp://127.0.0.1:8554/annotated');
    expect(body.frames).toBe(false);
    expect(body.inventedFrames).toBe(false);
    expect(body.neverRadio).toBe(true);
    expect(body.annotated_pipeline).toBe('none');
    expect(isRealAnnotatedStreamUrl('rtsp://127.0.0.1:8554/annotated')).toBe(true);
    expect(isRealAnnotatedStreamUrl('none')).toBe(false);
    expect(annotatedStreamPresent({
      video: { annotated_stream_url: 'rtsp://127.0.0.1:8554/annotated' },
    })).toBe(true);
    expect(annotatedStreamPresent({
      video: { annotated_pipeline: 'none', annotated_fps: null },
    })).toBe(false);
  });

  it('keeps radio from unlocking console annotated video', () => {
    const radioUp = annotatedVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      streamPresent: true,
    });
    expect(radioUp.available).toBe(false);
    expect(radioUp.neverRadio).toBe(true);
    expect(radioUp.reason).toBe('cellular_disconnected');
    const noModem = annotatedVideoAvailability({
      cellular: 'connected',
      modemPresent: false,
      streamPresent: true,
    });
    expect(noModem.available).toBe(false);
    expect(noModem.reason).toBe('modem_absent');
  });
});

describe('field-preflight annotated video row', () => {
  it('adds an honest annotated_video row that stays cellular-only', () => {
    expect(FIELD_PREFLIGHT_IDS).toContain('annotated_video');
    const empty = buildFieldPreflight({});
    const row = rowById(empty, 'annotated_video');
    expect(row).toBeTruthy();
    expect(row.available).toBe(false);
    expect(row.path).toBe('cellular');
    expect(row.neverRadio).toBe(true);
    expect(row.reason).toBe('modem_absent');
    expect(row.requiredForExperiment1).toBe(false);
    expect(row.nameHe).toBe('ראייה מסומנת');
    const streamed = buildFieldPreflight({
      modemPresent: true,
      cellular: 'connected',
      streamPresent: true,
    });
    expect(rowById(streamed, 'annotated_video').available).toBe(true);
    expect(rowById(streamed, 'annotated_video').reason).toBe('cellular_connected');
    const radioOnly = buildFieldPreflight({
      modemPresent: true,
      radio: 'connected',
      cellular: 'disconnected',
      streamPresent: true,
    });
    expect(rowById(radioOnly, 'annotated_video').available).toBe(false);
    expect(rowById(radioOnly, 'annotated_video').reason).toBe('cellular_disconnected');
  });
});

describe('GET /api/links/annotated-video stays honest with encoder stub fields', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-ann-enc-${Date.now()}.sqlite`);
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ann-enc-'));
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  beforeAll(async () => {
    resetDualLinkRuntimeForTests();
    db = openDatabase(tmpPath);
    const app = express();
    app.use(express.json());
    registerDualLinkApi(app, { db, dataDir: tmpData, env: {} });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    deactivateConnectionsByRole('radio');
    deactivateConnectionsByRole('cellular');
    resetDualLinkRuntimeForTests();
    if (server) await new Promise((resolve) => server.close(resolve));
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* ignore */ }
  });

  it('does not report available:true and keeps encoder frames false', async () => {
    const radio = await fetch(`${base}/api/links/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'radio',
        type: 'udp',
        host: '127.0.0.1',
        port: 14821 + (process.pid % 40),
      }),
    });
    expect(radio.status).toBe(200);
    const video = await fetch(`${base}/api/links/annotated-video`);
    const body = await video.json();
    expect(video.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.path).toBe('cellular');
    expect(body.neverRadio).toBe(true);
    expect(body.radioSatisfies).toBe(false);
    expect(body.streamPresent).toBe(false);
    expect(body.reason).toBe('modem_absent');
    expect(body.reasonHe).toBe(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    expect(body.encoder.observeOnly).toBe(true);
    expect(body.encoder.frames).toBe(false);
    expect(body.encoder.inventedFrames).toBe(false);
    await fetch(`${base}/api/links/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'radio' }),
    });
  });
});
