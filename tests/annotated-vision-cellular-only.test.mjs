import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
  ANNOTATED_VIDEO_PATH,
  ANNOTATED_VIDEO_REASON_HE,
  annotatedVideoAvailability,
  summarizeDualLink,
} from '../lib/dual-link.mjs';
import {
  buildVisionLandingReadiness,
  resolveAnnotatedVideoHonesty,
} from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('P3.2 annotated vision cellular-only honesty gate', () => {
  it('pins APP_VERSION at 1.02.308', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.308'");
    expect(pkg.version).toBe('1.02.308');
  });

  it('modem_absent makes annotated video unavailable on the cellular path', () => {
    const gate = annotatedVideoAvailability({
      cellular: 'connected',
      modemPresent: false,
      streamPresent: true,
    });
    expect(gate.available).toBe(false);
    expect(gate.path).toBe('cellular');
    expect(gate.reason).toBe('modem_absent');
    expect(gate.neverRadio).toBe(true);
    expect(gate.radioSatisfies).toBe(false);
    expect(gate.streamPresent).toBe(false);
    expect(gate.reasonHe).toBe(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    const snap = summarizeDualLink({
      radio: 'connected',
      cellular: 'connected',
      modemPresent: false,
      streamPresent: true,
    });
    expect(snap.video.available).toBe(false);
    expect(snap.video.reason).toBe('modem_absent');
    expect(snap.cellular).toBe('modem_absent');
  });

  it('radio cannot satisfy annotated video even when radio is up', () => {
    const radioOnly = annotatedVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      streamPresent: false,
    });
    expect(radioOnly.available).toBe(false);
    expect(radioOnly.path).toBe(ANNOTATED_VIDEO_PATH);
    expect(radioOnly.path).not.toBe('radio');
    expect(radioOnly.neverRadio).toBe(true);
    expect(radioOnly.radioSatisfies).toBe(false);
    expect(radioOnly.reason).toBe('cellular_disconnected');
    expect(radioOnly.reasonHe).toMatch(/לא עוברת ברדיו/);
    const readiness = buildVisionLandingReadiness({
      video: { available: true, path: 'radio' },
      cellular: 'disconnected',
      modemPresent: true,
    });
    const row = rowById(readiness, 'annotated_video');
    expect(row.available).toBe(false);
    expect(row.path).toBe('cellular');
    expect(row.radioSatisfies).toBe(false);
    expect(row.neverRadio).toBe(true);
    expect(row.reason).toBe('cellular_disconnected');
    expect(readiness.annotatedVideo.available).toBe(false);
    expect(resolveAnnotatedVideoHonesty({
      video: { available: true, path: 'radio' },
      cellular: 'disconnected',
      modemPresent: true,
    }).available).toBe(false);
  });

  it('does not invent available:true from cellular MAVLink or overlay.available', () => {
    const cellUp = annotatedVideoAvailability({
      cellular: 'connected',
      modemPresent: true,
    });
    expect(cellUp.available).toBe(false);
    expect(cellUp.reason).toBe('stream_absent');
    expect(cellUp.streamPresent).toBe(false);
    expect(cellUp.reasonHe).toBe(ANNOTATED_VIDEO_REASON_HE.stream_absent);
    const invented = resolveAnnotatedVideoHonesty({
      video: { available: true, path: 'cellular', reason: 'cellular_connected' },
      cellular: 'connected',
      modemPresent: true,
    });
    expect(invented.available).toBe(false);
    expect(invented.reason).toBe('stream_absent');
    const explicit = annotatedVideoAvailability({
      cellular: 'connected',
      modemPresent: true,
      streamPresent: true,
    });
    expect(explicit.available).toBe(true);
    expect(explicit.reason).toBe('cellular_connected');
    expect(explicit.path).toBe('cellular');
  });

  it('keeps Connect / Readiness / Mission empty states on the #110 reasons plus stream_absent', () => {
    expect(html).toMatch(/id="annotatedVideoConnectStatus"[^>]*data-reason="modem_absent"/);
    expect(html).toMatch(/id="annotatedVideoConnectStatus"[^>]*data-path="cellular"/);
    expect(html).toMatch(/id="annotatedVisionPanel"[^>]*data-path="cellular"/);
    expect(html).toMatch(/id="annotatedVisionPanel"[^>]*data-reason="modem_absent"/);
    expect(html).toMatch(/רק סלולר ממחשב משימה\. לא ברדיו/);
    expect(html).toContain(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    expect(js).toContain('ANNOTATED_VISION_REASON_HE');
    expect(js).toContain(ANNOTATED_VIDEO_REASON_HE.stream_absent);
    expect(js).toContain(ANNOTATED_VIDEO_REASON_HE.cellular_disconnected);
    expect(js).toMatch(/function annotatedVisionIsLive/);
    expect(js).toMatch(/video\?\.path === 'cellular'/);
    expect(js).toContain("getElementById('annotatedVideoConnectStatus')");
    expect(css).toMatch(/\.mission-annotated-vision\[data-state="stream_absent"\]/);
    expect(css).toMatch(/\.conn-annotated-status/);
    expect(css).toMatch(/\.vlr-row\[data-id="annotated_video"\]\[data-reason="stream_absent"\]/);
  });
});

describe('P3.2 annotated-video HTTP gate', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-annvid-${Date.now()}.sqlite`);
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-annvid-data-'));
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

  it('stays unavailable when radio is connected and never reports a fake live stream', async () => {
    const radio = await fetch(`${base}/api/links/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'radio',
        type: 'udp',
        host: '127.0.0.1',
        port: 14721 + (process.pid % 40),
      }),
    });
    const connected = await radio.json();
    expect(radio.status).toBe(200);
    expect(connected.ok).toBe(true);
    expect(connected.role).toBe('radio');
    const video = await fetch(`${base}/api/links/annotated-video`);
    const body = await video.json();
    expect(video.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.available).toBe(false);
    expect(body.path).toBe('cellular');
    expect(body.neverRadio).toBe(true);
    expect(body.radioSatisfies).toBe(false);
    expect(body.streamPresent).toBe(false);
    expect(body.reason).toBe('modem_absent');
    expect(body.reasonHe).toBe(ANNOTATED_VIDEO_REASON_HE.modem_absent);
    const links = await fetch(`${base}/api/links`);
    const snap = await links.json();
    expect(snap.links.radio === 'listening' || snap.links.radio === 'connected').toBe(true);
    expect(snap.links.video.available).toBe(false);
    expect(snap.links.video.reason).toBe('modem_absent');
    await fetch(`${base}/api/links/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'radio' }),
    });
  });
});

describe('P3.2 annotated-video stays absent when modem is mocked and radio is up', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-annvid-mock-${Date.now()}.sqlite`);
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-annvid-mock-'));
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
    registerDualLinkApi(app, {
      db,
      dataDir: tmpData,
      env: { CELLULAR_MODEM_MOCK: 'present' },
    });
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

  it('does not report available:true just because a modem mock and radio exist', async () => {
    const radio = await fetch(`${base}/api/links/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'radio',
        type: 'udp',
        host: '127.0.0.1',
        port: 14761 + (process.pid % 40),
      }),
    });
    expect(radio.status).toBe(200);
    const video = await fetch(`${base}/api/links/annotated-video`);
    const body = await video.json();
    expect(body.available).toBe(false);
    expect(body.path).toBe('cellular');
    expect(body.neverRadio).toBe(true);
    expect(body.radioSatisfies).toBe(false);
    expect(body.streamPresent).toBe(false);
    expect(body.reason).toBe('cellular_disconnected');
    expect(body.reasonHe).toBe(ANNOTATED_VIDEO_REASON_HE.cellular_disconnected);
    await fetch(`${base}/api/links/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'radio' }),
    });
  });
});
