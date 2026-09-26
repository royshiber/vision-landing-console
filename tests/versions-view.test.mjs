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

  it('blocks console rollback when flight state is unknown or airborne, without a second confirm', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-route-'));
    const appRoot = path.join(parent, 'console');
    fs.mkdirSync(path.join(parent, 'airvix-rollback', 'console'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'airvix-rollback', 'console', 'version.js'), "export const APP_VERSION = '1.02.335';\n");
    const rollbackPrevious = vi.fn(async () => ({ ok: true, status: 202 }));
    const app = express();
    app.use(express.json());
    let mav = { connected: true };
    registerVersionsApi(app, {
      appRoot,
      versionsStatePath: path.join(parent, 'versions-state.json'),
      getAppVersion: () => '1.02.338',
      db: null,
      updateService: { rollbackPrevious },
      getMavConn: () => mav,
    });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = () => fetch(`${base}/api/versions/rollback/console`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, from: '1.02.338', to: '1.02.335', confirmUnknown: true }),
    });
    const unknown = await post();
    const unknownBody = await unknown.json();
    expect(unknown.status).toBe(409);
    expect(unknownBody.needsConfirmation).toBe(false);
    expect(unknownBody.message).toContain('לא ידוע');
    expect(unknownBody.message).not.toContain('לעדכן');
    mav = { connected: true, lastBaseMode: 0, lastGlobalPos: { relativeAltM: 12 } };
    const flying = await post();
    const flyingBody = await flying.json();
    expect(flying.status).toBe(409);
    expect(flyingBody.message).toContain('באוויר');
    expect(flyingBody.needsConfirmation).toBe(false);
    expect(rollbackPrevious).not.toHaveBeenCalled();
    server.close();
  });

  it('rejects a second rollback while one is running, then times out and can be dismissed', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-route-'));
    const appRoot = path.join(parent, 'console');
    fs.mkdirSync(path.join(parent, 'airvix-rollback', 'console'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'airvix-rollback', 'console', 'version.js'), "export const APP_VERSION = '1.02.335';\n");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const rollbackPrevious = vi.fn(() => gate.then(() => ({ ok: true, status: 202 })));
    const app = express();
    app.use(express.json());
    const statePath = path.join(parent, 'versions-state.json');
    registerVersionsApi(app, {
      appRoot,
      versionsStatePath: statePath,
      getAppVersion: () => '1.02.338',
      db: null,
      updateService: { rollbackPrevious },
      getMavConn: () => null,
    });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify({ confirm: true, from: '1.02.338', to: '1.02.335' });
    const first = fetch(`${base}/api/versions/rollback/console`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await fetch(`${base}/api/versions/rollback/console`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(second.status).toBe(409);
    expect((await second.json()).message).toContain('כבר רצה');
    release();
    expect((await first).status).toBe(202);
    const startedAt = new Date(Date.now() - 46000).toISOString();
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    stored.rollback.startedAt = startedAt;
    fs.writeFileSync(statePath, JSON.stringify(stored));
    const timed = await fetch(`${base}/api/versions`).then((r) => r.json());
    expect(timed.rollback.state).toBe('failed');
    expect(timed.rollback.error).toContain('לא הסתיימה');
    const dismissed = await fetch(`${base}/api/versions/rollback/dismiss`, { method: 'POST', body: '{}' });
    expect(dismissed.status).toBe(200);
    const after = await fetch(`${base}/api/versions`).then((r) => r.json());
    expect(after.rollback.state).toBe('idle');
    server.close();
  });

  it('shows a companion auto-revert and the real known-good error', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-route-'));
    const statePath = path.join(parent, 'versions-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      console: { version: '1.02.338', installedAt: null, previousVersion: null },
      knownGood: null,
      rollback: {
        state: 'running',
        kind: 'companion',
        from: '2.6.0',
        to: '2.5.0',
        backupId: '20260926T100000Z',
        error: null,
        startedAt: new Date().toISOString(),
      },
    }));
    const app = express();
    app.use(express.json());
    registerVersionsApi(app, {
      appRoot: path.join(parent, 'console'),
      versionsStatePath: statePath,
      getAppVersion: () => '1.02.338',
      db: null,
      getMavConn: () => null,
      companionClient: {
        async getVersions() {
          return {
            version: '2.6.0',
            deployed_at: '2026-09-26T12:00:00Z',
            git_sha: 'abc',
            backups: [],
            rollback: {
              state: 'failed',
              reverted: true,
              backup_id: '20260926T100000Z',
              finished_at: new Date().toISOString(),
              message: 'השירות לא עלה. הוחזרה הגרסה הקודמת.',
            },
          };
        },
        async postVersionsKnownGood() {
          const err = new Error('forbidden');
          err.status = 403;
          err.body = { message: 'אסור לסמן' };
          throw err;
        },
      },
    });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const view = await fetch(`${base}/api/versions`).then((r) => r.json());
    expect(view.rollback.state).toBe('failed');
    expect(view.rollback.error).toContain('הוחזרה הגרסה הקודמת');
    const mark = await fetch(`${base}/api/versions/known-good`, { method: 'POST', body: '{}' });
    const markBody = await mark.json();
    expect(mark.status).toBe(403);
    expect(markBody.message).toBe('אסור לסמן');
    server.close();
  });

  it('blocks a companion rollback when the aircraft is armed, airborne, or unknown', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-route-'));
    const app = express();
    app.use(express.json());
    const postRollback = vi.fn(async () => ({ ok: true, state: 'restarting' }));
    let mav = { connected: true, lastBaseMode: 0x80 };
    registerVersionsApi(app, {
      appRoot: path.join(parent, 'console'),
      versionsStatePath: path.join(parent, 'versions-state.json'),
      getAppVersion: () => '1.02.338',
      db: null,
      getMavConn: () => mav,
      companionClient: {
        async getVersions() {
          return {
            version: '2.6.0',
            deployed_at: '2026-09-26T12:00:00Z',
            backups: [{ id: '20260926T100000Z', version: '2.5.0', deployed_at: '2026-09-25T18:00:00Z' }],
          };
        },
        postVersionsRollback: postRollback,
      },
    });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = () => fetch(`${base}/api/versions/rollback/companion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, from: '2.6.0', to: '2.5.0', backupId: '20260926T100000Z', confirmUnknown: true }),
    });
    const armed = await (await send()).json();
    expect(armed.message).toContain('חמוש');
    expect(armed.needsConfirmation).toBe(false);
    mav = { connected: true, lastBaseMode: 0, lastGlobalPos: { relativeAltM: 9 } };
    const flying = await (await send()).json();
    expect(flying.message).toContain('באוויר');
    mav = { connected: true };
    const unknown = await (await send()).json();
    expect(unknown.message).toContain('לא ידוע');
    expect(unknown.message).not.toContain('לעדכן');
    expect(postRollback).not.toHaveBeenCalled();
    server.close();
  });
});
