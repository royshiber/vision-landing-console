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
    expect(j.links.cellular === 'listening' || j.links.cellular === 'connected').toBe(true);
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
    expect(j.reasonHe).toMatch(/מחשב משימה|סלולר/);
  });

  it('GET /api/telemetry-archive describes the dedicated store and downlink stub', async () => {
    const r = await fetch(`${base}/api/telemetry-archive`);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.relativePath).toBe('data/flights/archive');
    expect(j.schema.table).toBe('telemetry_archive');
    expect(j.downlink.stub).toBe(true);
    expect(j.priority.flight).toBe(0);
    const dl = await fetch(`${base}/api/telemetry-archive/downlink`, { method: 'POST' });
    const body = await dl.json();
    expect(body.stub).toBe(true);
    expect(body.modemPresent).toBe(false);
  });
});
