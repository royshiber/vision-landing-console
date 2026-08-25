import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('connections profile CRUD API', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-connections-${Date.now()}.sqlite`);
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;
  const intervalIds = [];
  const origSetInterval = globalThis.setInterval;

  beforeAll(async () => {
    globalThis.setInterval = function patchedSetInterval(...args) {
      const id = origSetInterval.apply(this, args);
      intervalIds.push(id);
      return id;
    };
    try {
      db = openDatabase(tmpPath);
      const { registerCoreApi } = await import('../lib/routes/core-api.mjs');
      const app = express();
      app.use(express.json());
      registerCoreApi(app, {
        db,
        APP_VERSION: '0.0.0-test',
        getAppVersion: () => '0.0.0-test',
        upload: { single: () => (_req, _res, next) => next() },
        jetsonState: { lastSeen: null, missedBeats: 0, totalBeats: 0 },
        visionState: {},
        slamState: {},
        visionNavModeState: { mode: 'prior_mission_map' },
        companionService: null,
      });
      server = await listen(app);
      const addr = server.address();
      base = `http://127.0.0.1:${addr.port}`;
    } finally {
      globalThis.setInterval = origSetInterval;
    }
  });

  afterAll(async () => {
    for (const id of intervalIds) clearInterval(id);
    if (server) await new Promise((resolve) => server.close(resolve));
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* wal cleanup */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* shm cleanup */ }
  });

  it('GET /api/connections is empty on a fresh database', async () => {
    const r = await fetch(`${base}/api/connections`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j).toEqual({ ok: true, connections: [] });
  });

  it('POST /api/connections persists a profile that GET returns', async () => {
    const created = await fetch(`${base}/api/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SITL UDP', type: 'udp', host: '127.0.0.1', port: 14550 }),
    });
    const createdBody = await created.json();
    expect(created.status).toBe(200);
    expect(createdBody.ok).toBe(true);
    expect(Number(createdBody.id)).toBeGreaterThan(0);

    const listed = await fetch(`${base}/api/connections`);
    const listedBody = await listed.json();
    expect(listed.status).toBe(200);
    expect(listedBody.ok).toBe(true);
    const row = listedBody.connections.find((c) => Number(c.id) === Number(createdBody.id));
    expect(row).toMatchObject({
      name: 'SITL UDP',
      type: 'udp',
      host: '127.0.0.1',
      port: 14550,
    });
  });

  it('PATCH and DELETE operate on the same table', async () => {
    const created = await fetch(`${base}/api/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TCP box', type: 'tcp', host: '10.0.0.2', port: 5760 }),
    });
    const { id } = await created.json();

    const patched = await fetch(`${base}/api/connections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TCP box 2', port: 5761 }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ ok: true });

    const afterPatch = await fetch(`${base}/api/connections`).then((r) => r.json());
    const row = afterPatch.connections.find((c) => Number(c.id) === Number(id));
    expect(row.name).toBe('TCP box 2');
    expect(row.port).toBe(5761);
    expect(row.type).toBe('tcp');

    const deleted = await fetch(`${base}/api/connections/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    const afterDelete = await fetch(`${base}/api/connections`).then((r) => r.json());
    expect(afterDelete.connections.some((c) => Number(c.id) === Number(id))).toBe(false);
  });

  it('POST /api/connections rejects missing name or type without writing a row', async () => {
    const before = await fetch(`${base}/api/connections`).then((r) => r.json());
    const noName = await fetch(`${base}/api/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'udp' }),
    });
    expect(noName.status).toBe(400);
    const badType = await fetch(`${base}/api/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', type: 'not-a-type' }),
    });
    expect(badType.status).toBe(400);
    const after = await fetch(`${base}/api/connections`).then((r) => r.json());
    expect(after.connections.length).toBe(before.connections.length);
  });
});
