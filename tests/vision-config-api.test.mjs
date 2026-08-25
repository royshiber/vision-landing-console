import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase, getConfig } from '../lib/db.mjs';
import { buildArduTargetDefaults } from '../lib/param-schema.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function emptyRouteCtx(db) {
  return {
    db,
    APP_VERSION: '0.0.0-test',
    getAppVersion: () => '0.0.0-test',
    upload: { single: () => (_req, _res, next) => next() },
    jetsonState: { lastSeen: null, missedBeats: 0, totalBeats: 0 },
    visionState: {},
    slamState: {},
    visionNavModeState: { mode: 'prior_mission_map' },
    companionService: null,
    arduTargetParams: { ...buildArduTargetDefaults() },
    visionProfileStore: {},
    arduCurrentParams: null,
  };
}

async function startCoreApi(db) {
  const intervalIds = [];
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = function patchedSetInterval(...args) {
    const id = origSetInterval.apply(this, args);
    intervalIds.push(id);
    return id;
  };
  try {
    const { registerCoreApi } = await import('../lib/routes/core-api.mjs');
    const app = express();
    app.use(express.json());
    registerCoreApi(app, emptyRouteCtx(db));
    const server = await listen(app);
    const addr = server.address();
    return {
      server,
      base: `http://127.0.0.1:${addr.port}`,
      intervalIds,
    };
  } finally {
    globalThis.setInterval = origSetInterval;
  }
}

async function stopCoreApi(handle) {
  for (const id of handle.intervalIds) clearInterval(id);
  if (handle.server) await new Promise((resolve) => handle.server.close(resolve));
}

describe('GET/POST /api/vision/config SQLite persistence', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-vision-config-${Date.now()}.sqlite`);
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* wal cleanup */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* shm cleanup */ }
  });

  it('GET on a fresh database returns empty profile companion defaults and RAM arduTarget defaults', async () => {
    const handle = await startCoreApi(db);
    try {
      const r = await fetch(`${handle.base}/api/vision/config`);
      const j = await r.json();
      expect(r.status).toBe(200);
      expect(j.ok).toBe(true);
      expect(j.profile.flare_alt_m).toBeUndefined();
      expect(j.profile.companion_serial_port).toBe(2);
      expect(j.arduTarget.LAND_SPEED).toBe(buildArduTargetDefaults().LAND_SPEED);
    } finally {
      await stopCoreApi(handle);
    }
  });

  it('POST then a fresh in-memory ctx GET returns the saved profile + arduTarget from SQLite', async () => {
    const first = await startCoreApi(db);
    let posted;
    try {
      const res = await fetch(`${first.base}/api/vision/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: { flare_alt_m: 12, companion_serial_port: 3 },
          arduTarget: { LAND_SPEED: 75 },
        }),
      });
      posted = await res.json();
      expect(res.status).toBe(200);
      expect(posted.ok).toBe(true);
      expect(posted.profile.flare_alt_m).toBe(12);
      expect(posted.profile.companion_serial_port).toBe(3);
      expect(posted.arduTarget.LAND_SPEED).toBe(75);
      expect(posted.rejected).toEqual({});
    } finally {
      await stopCoreApi(first);
    }

    expect(getConfig(db, 'visionProfileStore').flare_alt_m).toBe(12);
    expect(getConfig(db, 'arduTargetParams').LAND_SPEED).toBe(75);

    const restarted = await startCoreApi(db);
    try {
      const r = await fetch(`${restarted.base}/api/vision/config`);
      const j = await r.json();
      expect(r.status).toBe(200);
      expect(j.ok).toBe(true);
      expect(j.profile.flare_alt_m).toBe(12);
      expect(j.profile.companion_serial_port).toBe(3);
      expect(j.arduTarget.LAND_SPEED).toBe(75);
      expect(j.arduTarget.LAND_SPEED).not.toBe(buildArduTargetDefaults().LAND_SPEED);
    } finally {
      await stopCoreApi(restarted);
    }
  });

  it('keeps coerce/reject behavior and does not persist rejected keys across restart', async () => {
    const first = await startCoreApi(db);
    let posted;
    try {
      const res = await fetch(`${first.base}/api/vision/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: { flare_alt_m: 8, not_a_key: 1 },
          arduTarget: { LAND_SPEED: 80, NOT_A_PARAM: 1, EK3_ENABLE: 'nope' },
        }),
      });
      posted = await res.json();
      expect(res.status).toBe(200);
      expect(posted.ok).toBe(true);
      expect(posted.profile.flare_alt_m).toBe(8);
      expect(posted.profile.not_a_key).toBeUndefined();
      expect(posted.arduTarget.LAND_SPEED).toBe(80);
      expect(posted.arduTarget.NOT_A_PARAM).toBeUndefined();
      expect(posted.arduTarget.EK3_ENABLE).toBe(1);
      expect(posted.rejected.profile.not_a_key).toBe('unknown_key');
      expect(posted.rejected.arduTarget.NOT_A_PARAM).toBe('unknown_key');
      expect(posted.rejected.arduTarget.EK3_ENABLE).toBe('not_bool_01');
    } finally {
      await stopCoreApi(first);
    }

    const savedProfile = getConfig(db, 'visionProfileStore');
    const savedArdu = getConfig(db, 'arduTargetParams');
    expect(savedProfile.not_a_key).toBeUndefined();
    expect(savedArdu.NOT_A_PARAM).toBeUndefined();

    const restarted = await startCoreApi(db);
    try {
      const r = await fetch(`${restarted.base}/api/vision/config`);
      const j = await r.json();
      expect(j.profile.flare_alt_m).toBe(8);
      expect(j.profile.not_a_key).toBeUndefined();
      expect(j.arduTarget.LAND_SPEED).toBe(80);
      expect(j.arduTarget.NOT_A_PARAM).toBeUndefined();
      expect(j.arduTarget.EK3_ENABLE).toBe(1);
    } finally {
      await stopCoreApi(restarted);
    }
  });
});
