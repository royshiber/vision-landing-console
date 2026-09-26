import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  assertRollbackConfirm,
  buildVersionsView,
  findCleanEndedFlight,
  findPreviousConsole,
  maybeAutoKnownGood,
  readLastFcParamSnapshotAt,
} from '../lib/versions-view.mjs';
import { registerVersionsApi } from '../lib/routes/versions-api.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('versions view data', () => {
  it('reads an FC param snapshot and stays empty when the table is absent', () => {
    const db = new Database(':memory:');
    expect(readLastFcParamSnapshotAt(db)).toBeNull();
    expect(findCleanEndedFlight(db)).toBeNull();
    db.exec(`CREATE TABLE param_snapshots (id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, target TEXT, payload_json TEXT, reason TEXT)`);
    db.prepare(`INSERT INTO param_snapshots (created_at, kind, target, payload_json) VALUES (?, 'apply', 'fc', '{}')`).run('2026-09-20 08:30:00');
    expect(readLastFcParamSnapshotAt(db)).toBe('2026-09-20 08:30:00');
    db.close();
  });

  it('auto-marks a known-good combo only after a clean ended flight when both versions exist', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE flights (id INTEGER PRIMARY KEY, disarm_utc TEXT, errors INTEGER, critical INTEGER)`);
    db.prepare(`INSERT INTO flights (disarm_utc, errors, critical) VALUES ('2026-09-26T09:00:00Z', 0, 0)`).run();
    const missingCompanion = maybeAutoKnownGood({ autoFlightId: null, knownGood: null }, db, {
      consoleVersion: '1.02.338',
      companionVersion: null,
      nowIso: '2026-09-26T10:00:00Z',
    });
    expect(missingCompanion.marked).toBe(false);
    const marked = maybeAutoKnownGood({ autoFlightId: null, knownGood: null }, db, {
      consoleVersion: '1.02.338',
      companionVersion: '2.6.0',
      nowIso: '2026-09-26T10:00:00Z',
    });
    expect(marked.marked).toBe(true);
    expect(marked.state.knownGood.source).toBe('flight');
    db.prepare(`UPDATE flights SET errors = 2`).run();
    const dirty = new Database(':memory:');
    dirty.exec(`CREATE TABLE flights (id INTEGER PRIMARY KEY, disarm_utc TEXT, errors INTEGER, critical INTEGER)`);
    dirty.prepare(`INSERT INTO flights (disarm_utc, errors, critical) VALUES ('2026-09-26T09:00:00Z', 2, 0)`).run();
    expect(maybeAutoKnownGood({ autoFlightId: null }, dirty, {
      consoleVersion: '1.02.338',
      companionVersion: '2.6.0',
      nowIso: '2026-09-26T10:00:00Z',
    }).marked).toBe(false);
    db.close();
    dirty.close();
  });

  it('explains when the console has no previous build', () => {
    const view = buildVersionsView({
      appVersion: '1.02.338',
      state: { console: { installedAt: null, previousVersion: null }, knownGood: null, rollback: { state: 'idle' } },
      previousConsole: { available: false, version: null },
      companion: null,
      fcSnapshotAt: null,
    });
    expect(view.console.rollbackAvailable).toBe(false);
    expect(view.console.rollbackUnavailableReason).toContain('לא זמינה');
    expect(view.companion.linked).toBe(false);
    expect(view.companion.version).toBeNull();
    expect(view.fcParams.snapshotAt).toBeNull();
    expect(assertRollbackConfirm({ confirm: false, from: '1', to: '0' }, { from: '1', to: '0' }).status).toBe(400);
  });

  it('sees a previous console tree kept by the updater', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-prev-'));
    const appRoot = path.join(parent, 'console');
    fs.mkdirSync(path.join(parent, 'airvix-rollback', 'console'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'airvix-rollback', 'console', 'version.js'), "export const APP_VERSION = '1.02.335';\n");
    expect(findPreviousConsole(appRoot)).toMatchObject({ available: true, version: '1.02.335' });
  });
});

describe('versions rollback route', () => {
  it('requires confirmation and reports from and to', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-route-'));
    const appRoot = path.join(parent, 'console');
    fs.mkdirSync(path.join(parent, 'airvix-rollback', 'console'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'airvix-rollback', 'console', 'version.js'), "export const APP_VERSION = '1.02.335';\n");
    const rollbackPrevious = vi.fn(async () => ({ ok: true, status: 202 }));
    const app = express();
    app.use(express.json());
    registerVersionsApi(app, {
      appRoot,
      versionsStatePath: path.join(parent, 'versions-state.json'),
      getAppVersion: () => '1.02.338',
      db: null,
      updateService: { rollbackPrevious },
      getMavConn: () => null,
    });
    const server = await listen(app);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const view = await fetch(`${base}/api/versions`).then((r) => r.json());
    expect(view.console.version).toBe('1.02.338');
    expect(view.console.previousVersion).toBe('1.02.335');
    expect(view.console.installedAt).toBeNull();
    expect(view.fcParams.snapshotAt).toBeNull();
    const denied = await fetch(`${base}/api/versions/rollback/console`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, from: '1.02.338', to: '9.9.9' }),
    });
    expect(denied.status).toBe(409);
    expect(rollbackPrevious).not.toHaveBeenCalled();
    const ok = await fetch(`${base}/api/versions/rollback/console`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, from: '1.02.338', to: '1.02.335' }),
    });
    const body = await ok.json();
    expect(ok.status).toBe(202);
    expect(body.from).toBe('1.02.338');
    expect(body.to).toBe('1.02.335');
    expect(rollbackPrevious).toHaveBeenCalledOnce();
    server.close();
  });
});
