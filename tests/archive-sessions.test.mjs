import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { registerDualLinkApi } from '../lib/routes/dual-link-api.mjs';
import { resetDualLinkRuntimeForTests } from '../lib/dual-link-runtime.mjs';
import {
  ARCHIVE_SESSION_COPY_HE,
  describeArchiveSession,
  listArchiveSessions,
  resolveArchiveSessionFile,
  isSafeArchiveTlog,
} from '../lib/telemetry-archive.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const paren = src.indexOf('(', start);
  let depth = 0;
  let i = paren;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const brace = src.indexOf('{', i);
  depth = 0;
  for (i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

describe('archive session list helpers', () => {
  it('returns Hebrew emptyHe when there are no rows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-sess-empty-'));
    const db = openDatabase(path.join(root, 'index.sqlite'));
    const listed = listArchiveSessions(db, { archiveRoot: path.join(root, 'flights', 'archive') });
    expect(listed.sessions).toEqual([]);
    expect(listed.emptyHe).toBe(ARCHIVE_SESSION_COPY_HE.empty);
    expect(listed.emptyHe).toBe('אין הקלטות ארכיון עדיין');
    db.close();
  });

  it('maps stored columns only and flags interrupted / empty honestly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-sess-map-'));
    const archiveRoot = path.join(root, 'flights', 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    const goodPath = path.join(archiveRoot, 'closed.tlog');
    fs.writeFileSync(goodPath, Buffer.from([0xfe, 0x01]));
    const emptyPath = path.join(archiveRoot, 'empty.tlog');
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const db = openDatabase(path.join(root, 'index.sqlite'));
    db.prepare(
      `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state, ended_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(null, 'radio', goodPath, 2, 1, 'local', '2026-09-12 10:00:00');
    db.prepare(
      `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state, ended_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(null, 'cellular', emptyPath, 0, 0, 'interrupted', '2026-09-12 11:00:00');
    const listed = listArchiveSessions(db, { archiveRoot });
    expect(listed.emptyHe).toBeNull();
    expect(listed.sessions).toHaveLength(2);
    const closed = listed.sessions.find((s) => s.basename === 'closed.tlog');
    const interrupted = listed.sessions.find((s) => s.basename === 'empty.tlog');
    expect(closed.bytes).toBe(2);
    expect(closed.empty).toBe(false);
    expect(closed.interrupted).toBe(false);
    expect(closed.orphan).toBe(false);
    expect(closed.downloadable).toBe(true);
    expect(closed.downloadUrl).toMatch(/\/api\/telemetry-archive\/sessions\/\d+\/file/);
    expect(closed).not.toHaveProperty('duration');
    expect(closed).not.toHaveProperty('rate');
    expect(interrupted.empty).toBe(true);
    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.orphan).toBe(true);
    expect(interrupted.linkRole).toBe('cellular');
    expect(interrupted.linkRoleHe).toBe('סלולר');
    expect(interrupted.statusHe).toBe('נקטע');
    expect(interrupted.bytesHe).toBe('0 ב');
    db.close();
  });

  it('never marks a path outside the archive root downloadable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-sess-unsafe-'));
    const archiveRoot = path.join(root, 'flights', 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    const outside = path.join(root, 'escape.tlog');
    fs.writeFileSync(outside, Buffer.from([0xfe]));
    const described = describeArchiveSession({
      id: 9,
      started_at: '2026-09-12 09:00:00',
      ended_at: '2026-09-12 09:01:00',
      bytes: 1,
      link_role: 'radio',
      stored_path: outside,
      downlink_state: 'local',
    }, { archiveRoot });
    expect(isSafeArchiveTlog({ storedPath: outside, archiveRoot })).toBe(false);
    expect(described.downloadable).toBe(false);
    expect(described.downloadUrl).toBeNull();
    const db = openDatabase(path.join(root, 'index.sqlite'));
    const ins = db.prepare(
      `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state)
       VALUES (?,?,?,?,?,?)`,
    ).run(null, 'radio', outside, 1, 1, 'local');
    const resolved = resolveArchiveSessionFile(db, { id: ins.lastInsertRowid, archiveRoot });
    expect(resolved.ok).toBe(false);
    expect(resolved.status).toBe(404);
    expect(resolved.reason).toBe('unsafe');
    db.close();
  });
});

describe('GET /api/telemetry-archive/sessions', () => {
  const tmpPath = path.join(os.tmpdir(), `test-vlc-archive-sess-${Date.now()}.sqlite`);
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-sess-'));
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
    resetDualLinkRuntimeForTests();
    if (server) await new Promise((resolve) => server.close(resolve));
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch { /* ignore */ }
  });

  it('lists Hebrew empty state before any session exists', async () => {
    const r = await fetch(`${base}/api/telemetry-archive/sessions`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.sessions).toEqual([]);
    expect(j.emptyHe).toBe('אין הקלטות ארכיון עדיין');
  });

  it('does not open a recording when listing sessions', async () => {
    const archiveDir = path.join(tmpData, 'flights', 'archive');
    const before = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((n) => n.endsWith('.tlog')) : [];
    await fetch(`${base}/api/telemetry-archive/sessions`);
    const armed = await (await fetch(`${base}/api/telemetry-archive`)).json();
    expect(armed.recording.armed).toBe(false);
    const after = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((n) => n.endsWith('.tlog')) : [];
    expect(after).toEqual(before);
  });

  it('returns a closed zero-byte session and serves the tlog when safe', async () => {
    const start = await fetch(`${base}/api/telemetry-archive/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkRole: 'radio' }),
    });
    const started = await start.json();
    expect(started.ok).toBe(true);
    const stop = await fetch(`${base}/api/telemetry-archive/stop`, { method: 'POST' });
    const stopped = await stop.json();
    expect(stopped.ok).toBe(true);
    const listed = await (await fetch(`${base}/api/telemetry-archive/sessions`)).json();
    expect(listed.ok).toBe(true);
    expect(listed.sessions.length).toBeGreaterThanOrEqual(1);
    const row = listed.sessions.find((s) => s.id === stopped.closed.rowId)
      || listed.sessions[0];
    expect(row.basename).toMatch(/\.tlog$/);
    expect(row.empty).toBe(true);
    expect(row.bytes).toBe(0);
    expect(row.interrupted).toBe(false);
    expect(row.statusHe).toBe('ריק');
    expect(row.downloadable).toBe(true);
    const file = await fetch(`${base}${row.downloadUrl}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition') || '').toMatch(/\.tlog/i);
    const buf = Buffer.from(await file.arrayBuffer());
    expect(buf.length).toBe(0);
  });

  it('refuses download for a row whose path left the archive root', async () => {
    const outside = path.join(tmpData, 'not-archive.tlog');
    fs.writeFileSync(outside, Buffer.from([0xfe, 0x09]));
    const ins = db.prepare(
      `INSERT INTO telemetry_archive (flight_id, link_role, stored_path, bytes, frames, downlink_state, ended_at)
       VALUES (?,?,?,?,?,?,datetime('now'))`,
    ).run(null, 'radio', outside, 2, 1, 'local');
    const id = Number(ins.lastInsertRowid);
    const listed = await (await fetch(`${base}/api/telemetry-archive/sessions`)).json();
    const row = listed.sessions.find((s) => s.id === id);
    expect(row.downloadable).toBe(false);
    expect(row.downloadUrl).toBeNull();
    const file = await fetch(`${base}/api/telemetry-archive/sessions/${id}/file`);
    expect(file.status).toBe(404);
    const body = await file.json();
    expect(body.ok).toBe(false);
    expect(body.messageHe).toBe('אין קובץ');
  });
});

describe('תחקור archive sessions UI contract', () => {
  it('hosts the archive list in לוגים with Hebrew empty state', () => {
    const rec = html.match(
      /<section\b[^>]*\bid="recordings"[^>]*>([\s\S]*?)<\/section>\s*<section\b[^>]*\bid="telemetry"/,
    )?.[1] || '';
    expect(rec).toContain('id="archiveSessionsCard"');
    expect(rec).toContain('id="archiveSessionsEmpty"');
    expect(rec).toContain('id="archiveSessionsList"');
    expect(rec).toContain('id="refreshArchiveSessionsBtn"');
    expect(rec).toContain('הקלטות ארכיון');
    expect(rec).toContain('אין הקלטות ארכיון עדיין');
    expect(rec).toMatch(/id="debriefLogsBtn"[^>]*data-debrief-tab="logs"[^>]*>לוגים</);
    expect(rec.indexOf('archiveSessionsCard')).toBeLessThan(rec.indexOf('allLogsArduTbody'));
  });

  it('renders honest flags and never starts a recording from the list', () => {
    const refresh = sliceFunction(js, 'refreshArchiveSessions');
    const render = sliceFunction(js, 'renderArchiveSessionsList');
    expect(refresh).toContain('/api/telemetry-archive/sessions');
    expect(refresh).not.toContain('/api/telemetry-archive/start');
    expect(refresh).not.toContain('/api/telemetry-archive/stop');
    expect(js).toContain(`const ARCHIVE_SESSIONS_EMPTY_HE = '${ARCHIVE_SESSION_COPY_HE.empty}'`);
    expect(render).toContain('ARCHIVE_SESSIONS_EMPTY_HE');
    expect(js).toContain('נקטע');
    expect(js).toContain('ריק');
    expect(render).toContain('העתק נתיב');
    expect(render).toContain('הורדה');
    expect(render).toContain('אין קובץ');
    expect(js).toContain("function copyArchiveSessionPath(");
    const applyDebrief = sliceFunction(js, 'applyDebriefSubtab');
    expect(applyDebrief).toContain('refreshArchiveSessions');
  });

  it('pins APP_VERSION at 1.02.311', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.311'");
    expect(pkg.version).toBe('1.02.311');
  });
});
