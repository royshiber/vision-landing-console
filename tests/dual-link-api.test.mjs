import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import { registerDualLinkApi } from '../lib/routes/dual-link-api.mjs';
import { resetDualLinkRuntimeForTests } from '../lib/dual-link-runtime.mjs';
import { deactivateConnectionsByRole } from '../lib/mavlink-connection.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('dual-link HTTP API', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-duallink-${Date.now()}.sqlite`);
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-duallink-data-'));
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
      env: {},
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

  it('GET /api/links reports both roles disconnected and modem absent', async () => {
    const r = await fetch(`${base}/api/links`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.links.radio).toBe('disconnected');
    expect(j.links.cellular).toBe('modem_absent');
    expect(j.links.modemPresent).toBe(false);
    expect(j.links.canSelectActive).toBe(false);
    expect(j.links.video.path).toBe('cellular');
    expect(j.links.video.available).toBe(false);
    expect(j.links.video.reason).toBe('modem_absent');
    expect(j.links.cellularStatusHe).toMatch(/מודם לא מחובר/);
    expect(j.links.pillLabelHe).toBe('מנותק');
  });

  it('refuses a remote cellular connect while the modem is unplugged', async () => {
    const r = await fetch(`${base}/api/links/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'cellular', type: 'udp', host: '8.8.8.8', port: 14550 }),
    });
    const j = await r.json();
    expect(r.status).toBe(422);
    expect(j.ok).toBe(false);
    expect(j.state).toBe('modem_absent');
  });

  it('opens a loopback cellular MAVLink listener as software mock', async () => {
    const r = await fetch(`${base}/api/links/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'cellular', type: 'udp', host: '127.0.0.1', port: 14591 + (process.pid % 50) }),
    });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.role).toBe('cellular');
    expect(j.mode).toBe('loopback_mock');
    expect(j.links.cellular).toBe('modem_absent');
    expect(j.links.modemPresent).toBe(false);
    expect(j.links.video.available).toBe(false);
    expect(j.links.video.reason).toBe('modem_absent');
    expect(j.links.commandLinkId == null || j.links.radioConnection?.id === j.links.commandLinkId).toBe(true);
    const cut = await fetch(`${base}/api/links/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'cellular' }),
    });
    expect(cut.status).toBe(200);
    expect((await cut.json()).ok).toBe(true);
  });

  it('GET /api/links/annotated-video stays cellular-only and honest when disconnected', async () => {
    const r = await fetch(`${base}/api/links/annotated-video`);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.neverRadio).toBe(true);
    expect(j.path).toBe('cellular');
    expect(j.available).toBe(false);
    expect(j.reason).toBe('modem_absent');
    expect(j.cellular).toBe('modem_absent');
    expect(j.modem.present).toBe(false);
    expect(j.reasonHe).toMatch(/מודם סלולר לא מחובר/);
  });

  it('GET /api/telemetry-archive describes the dedicated store and downlink stub', async () => {
    const r = await fetch(`${base}/api/telemetry-archive`);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.relativePath).toBe('data/flights/archive');
    expect(j.schema.table).toBe('telemetry_archive');
    expect(j.downlink.stub).toBe(true);
    expect(j.priority.flight).toBe(0);
    expect(j.recording.armed).toBe(false);
    expect(j.recording.session).toBeNull();
    const dl = await fetch(`${base}/api/telemetry-archive/downlink`, { method: 'POST' });
    const body = await dl.json();
    expect(body.stub).toBe(true);
    expect(body.modemPresent).toBe(false);
  });

  it('does not arm recording or open a session file on mere connect', async () => {
    const before = await fetch(`${base}/api/telemetry-archive`);
    const beforeJson = await before.json();
    expect(beforeJson.recording.armed).toBe(false);
    const r = await fetch(`${base}/api/links/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'cellular', type: 'udp', host: '127.0.0.1', port: 14611 + (process.pid % 40) }),
    });
    const connected = await r.json();
    expect(r.status).toBe(200);
    expect(connected.ok).toBe(true);
    const mid = await fetch(`${base}/api/telemetry-archive`);
    const midJson = await mid.json();
    expect(midJson.recording.armed).toBe(false);
    expect(midJson.recording.session).toBeNull();
    const archiveDir = path.join(tmpData, 'flights', 'archive');
    const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
    expect(files.filter((n) => n.endsWith('.tlog'))).toEqual([]);
    await fetch(`${base}/api/links/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'cellular' }),
    });
  });

  it('Start then Stop gates the archive via HTTP', async () => {
    const start = await fetch(`${base}/api/telemetry-archive/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkRole: 'radio' }),
    });
    const started = await start.json();
    expect(start.status).toBe(200);
    expect(started.ok).toBe(true);
    expect(started.recording.armed).toBe(true);
    expect(started.recording.session.storedPath).toMatch(/\.tlog$/);
    const getArmed = await fetch(`${base}/api/telemetry-archive`);
    const armedJson = await getArmed.json();
    expect(armedJson.recording.armed).toBe(true);
    expect(armedJson.recording.session).toBeTruthy();
    const stop = await fetch(`${base}/api/telemetry-archive/stop`, { method: 'POST' });
    const stopped = await stop.json();
    expect(stop.status).toBe(200);
    expect(stopped.ok).toBe(true);
    expect(stopped.recording.armed).toBe(false);
    expect(stopped.closed.storedPath).toBe(started.recording.session.storedPath);
    expect(stopped.closed.bytes).toBe(0);
    const getIdle = await fetch(`${base}/api/telemetry-archive`);
    const idleJson = await getIdle.json();
    expect(idleJson.recording.armed).toBe(false);
    expect(idleJson.recording.session).toBeNull();
  });
});
