import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { decimateMinMax } from '../lib/flight-logs/decimate.mjs';
import { NOT_CONFIGURED_HE } from '../lib/flight-logs/messages.mjs';
import { parseJsonMaybeGzip, reassembleChunks, sha256Hex } from '../lib/flight-logs/objects.mjs';
import { presignGetUrl, signAwsRequest } from '../lib/flight-logs/s3-client.mjs';
import { validateSchema } from '../lib/flight-logs/schema.mjs';
import {
  _resetFlightLogsMemory,
  listFlightLogs,
  syncFlightLogs,
} from '../lib/flight-logs/sync.mjs';
import { formatJerusalem, formatTPlus } from '../lib/flight-logs/time.mjs';
import { registerFlightLogsApi } from '../lib/routes/flight-logs-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'flight-logs');
const SECRET = 'super-secret-flight-cloud-app-key-ZZZ';
const ENV_KEYS = [
  'FLIGHT_LOGS_MODE',
  'FLIGHT_LOGS_FIXTURE_ROOT',
  'FLIGHT_CLOUD_ENDPOINT',
  'FLIGHT_CLOUD_REGION',
  'FLIGHT_CLOUD_BUCKET',
  'FLIGHT_CLOUD_KEY_ID',
  'FLIGHT_CLOUD_APP_KEY',
  'FLIGHT_CLOUD_PREFIX',
  'FLIGHT_CLOUD_VEHICLES',
];

let savedEnv = null;

function saveEnv() {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _resetFlightLogsMemory();
}

beforeEach(() => {
  saveEnv();
  for (const key of ENV_KEYS) delete process.env[key];
  _resetFlightLogsMemory();
});

afterEach(() => {
  restoreEnv();
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(server, url, opts = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text, json, headers: res.headers };
}

describe('flight log SigV4', () => {
  it('matches the AWS IAM ListUsers signature vector', () => {
    const signed = signAwsRequest({
      method: 'GET',
      host: 'iam.amazonaws.com',
      uri: '/',
      query: { Action: 'ListUsers', Version: '2010-05-08' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'iam',
      amzDate: '20150830T123600Z',
      contentShaHeader: false,
    });
    expect(signed.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('presigns a GET without putting the secret in the URL', () => {
    const { url } = presignGetUrl({
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      bucket: 'airvix-flights',
      key: 'v1/airvix01/index/flight.json',
      accessKeyId: 'KEYID',
      secretAccessKey: SECRET,
      region: 'us-west-004',
      expires: 300,
      amzDate: '20260920T070000Z',
    });
    expect(url).toContain('X-Amz-Expires=300');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).not.toContain(SECRET);
  });
});

describe('flight log objects', () => {
  it('reassembles chunks and marks a sha mismatch corrupt', () => {
    const a = Buffer.from('hello ');
    const b = Buffer.from('world');
    const whole = Buffer.concat([a, b]);
    const manifest = {
      bytes: whole.length,
      sha256: sha256Hex(whole),
      parts: [
        { n: 1, bytes: a.length, sha256: sha256Hex(a) },
        { n: 2, bytes: b.length, sha256: sha256Hex(b) },
      ],
    };
    const ok = reassembleChunks(manifest, [a, b]);
    expect(ok.ok).toBe(true);
    expect(ok.bytes.toString()).toBe('hello world');
    const bad = Buffer.from(b);
    bad[0] = bad[0] ^ 0xff;
    const corrupt = reassembleChunks(manifest, [a, bad]);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.state).toBe('corrupt');
    expect(corrupt.bytes).toBeNull();
  });

  it('reads gzip and plain JSON', () => {
    const obj = { ok: true, n: 2 };
    const plain = Buffer.from(JSON.stringify(obj));
    const gz = zlib.gzipSync(plain);
    expect(parseJsonMaybeGzip(plain)).toEqual(obj);
    expect(parseJsonMaybeGzip(gz)).toEqual(obj);
  });
});

describe('flight log schemas and time', () => {
  it('validates every fixture document', () => {
    const schemas = Object.fromEntries(['index', 'manifest', 'summary', 'event', 'series', 'track'].map((name) => [
      name,
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs', 'schemas', 'flight-log', `${name}.schema.json`), 'utf8')),
    ]));
    const vehicle = path.join(fixtureRoot, 'v1', 'airvix01');
    const indexes = fs.readdirSync(path.join(vehicle, 'index')).filter((n) => n.endsWith('.json'));
    expect(indexes.length).toBe(4);
    const errors = [];
    for (const name of indexes) {
      const index = JSON.parse(fs.readFileSync(path.join(vehicle, 'index', name), 'utf8'));
      errors.push(...validateSchema(schemas.index, index).map((e) => `${name} ${e}`));
      const flightDir = path.join(vehicle, 'flights', index.flight_id);
      for (const kind of ['manifest.json', 'summary.json']) {
        const doc = JSON.parse(fs.readFileSync(path.join(flightDir, kind), 'utf8'));
        const schema = kind.startsWith('manifest') ? schemas.manifest : schemas.summary;
        errors.push(...validateSchema(schema, doc).map((e) => `${index.flight_id}/${kind} ${e}`));
      }
      for (const [file, schema, parse] of [
        ['events.jsonl.gz', schemas.event, 'jsonl'],
        ['series.json.gz', schemas.series, 'json'],
        ['track.geojson.gz', schemas.track, 'json'],
      ]) {
        const raw = zlib.gunzipSync(fs.readFileSync(path.join(flightDir, file)));
        if (parse === 'jsonl') {
          const lines = raw.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
          expect(lines.length).toBeGreaterThan(0);
          for (const line of lines) {
            errors.push(...validateSchema(schema, JSON.parse(line)).map((e) => `${index.flight_id}/${file} ${e}`));
          }
        } else {
          errors.push(...validateSchema(schema, JSON.parse(raw.toString('utf8'))).map((e) => `${index.flight_id}/${file} ${e}`));
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('formats Asia/Jerusalem and T+mm:ss', () => {
    expect(formatJerusalem('2026-09-20T07:00:00.000Z')).toBe('20/09/2026 10:00:00');
    expect(formatTPlus(0)).toBe('T+00:00');
    expect(formatTPlus(125.4)).toBe('T+02:05');
    expect(formatTPlus(3661)).toBe('T+61:01');
    expect(formatTPlus(-5)).toBe('T-00:05');
  });

  it('keeps a spike when decimating', () => {
    const t = Array.from({ length: 400 }, (_, i) => i);
    const v = t.map(() => 1);
    v[217] = 80;
    const out = decimateMinMax(t, v, 40);
    expect(out.v.length).toBeLessThanOrEqual(40);
    expect(Math.max(...out.v)).toBe(80);
    expect(out.t).toContain(217);
  });
});

describe('flight log sync, API, and migration', () => {
  it('migrates a fresh database and an old flights table', () => {
    const freshPath = path.join(os.tmpdir(), `airvix-fb-fresh-${process.pid}.sqlite`);
    fs.rmSync(freshPath, { force: true });
    const fresh = openDatabase(freshPath);
    fresh.prepare(`INSERT INTO flights (title) VALUES ('manual')`).run();
    const cols = new Set(fresh.prepare('PRAGMA table_info(flights)').all().map((c) => c.name));
    expect(cols.has('flight_uid')).toBe(true);
    expect(cols.has('origin')).toBe(true);
    expect(cols.has('user_label')).toBe(true);
    expect(fresh.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='flight_debriefs'`).get()).toBeTruthy();
    expect(fresh.prepare(`SELECT origin FROM flights WHERE title = 'manual'`).get().origin).toBe('manual');
    fresh.close();

    const oldPath = path.join(os.tmpdir(), `airvix-fb-old-${process.pid}.sqlite`);
    fs.rmSync(oldPath, { force: true });
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    old.prepare(`INSERT INTO flights (title) VALUES ('kept')`).run();
    old.close();
    const migrated = openDatabase(oldPath);
    const row = migrated.prepare(`SELECT title, flight_uid, origin FROM flights`).get();
    expect(row.title).toBe('kept');
    expect(row.flight_uid).toBeNull();
    expect(row.origin).toBe('manual');
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE name='flight_events'`).get()).toBeTruthy();
    expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE name='flight_cloud_artifacts'`).get()).toBeTruthy();
    migrated.close();
    fs.rmSync(freshPath, { force: true });
    fs.rmSync(oldPath, { force: true });
  });

  it('syncs fixtures twice without duplicates and updates when the ETag changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-fb-fix-'));
    fs.cpSync(fixtureRoot, root, { recursive: true });
    process.env.FLIGHT_LOGS_MODE = 'mock';
    process.env.FLIGHT_LOGS_FIXTURE_ROOT = root;
    const dbPath = path.join(root, 'book.sqlite');
    const db = openDatabase(dbPath);
    const ctx = { db };
    await syncFlightLogs(ctx);
    await syncFlightLogs(ctx);
    const flights = db.prepare(`SELECT COUNT(*) AS n FROM flights WHERE origin = 'cloud'`).get().n;
    expect(flights).toBe(4);
    const uidB = '20260921T080000Z-airvix01-c3d4';
    const events = db.prepare(`SELECT COUNT(*) AS n FROM flight_events WHERE flight_uid = ?`).get(uidB).n;
    expect(events).toBe(9);
    const indexPath = path.join(root, 'v1', 'airvix01', 'index', `${uidB}.json`);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.warnings = 4;
    index.manifest_rev = 2;
    fs.writeFileSync(indexPath, JSON.stringify(index));
    _resetFlightLogsMemory();
    await syncFlightLogs(ctx);
    const updated = db.prepare(`SELECT warnings, manifest_rev FROM flights WHERE flight_uid = ?`).get(uidB);
    expect(updated.warnings).toBe(4);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM flights WHERE flight_uid = ?`).get(uidB).n).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM flight_events WHERE flight_uid = ?`).get(uidB).n).toBe(9);
    db.close();
  });

  it('filters, searches, rejects traversal, and never echoes the app key', async () => {
    process.env.FLIGHT_LOGS_MODE = 'mock';
    process.env.FLIGHT_LOGS_FIXTURE_ROOT = fixtureRoot;
    const db = openDatabase(path.join(os.tmpdir(), `airvix-fb-api-${process.pid}-${Date.now()}.sqlite`));
    const ctx = { db };
    await syncFlightLogs(ctx);
    const app = express();
    app.use(express.json());
    registerFlightLogsApi(app, ctx);
    const server = await listen(app);
    try {
      const all = await request(server, '/api/flight-logs/flights');
      expect(all.json.flights.map((f) => f.flight_uid)).toEqual([
        '20260923T100000Z-airvix01-0789',
        '20260921T080000Z-airvix01-c3d4',
        '20260920T070000Z-airvix01-a1b2',
      ]);
      const ground = await request(server, '/api/flight-logs/flights?includeGround=1');
      expect(ground.json.flights.some((f) => f.classification === 'bench')).toBe(true);
      const warnings = await request(server, '/api/flight-logs/flights?warnings=1&includeGround=1');
      expect(warnings.json.flights.every((f) => f.classification !== 'bench')).toBe(true);
      const rtl = await request(server, '/api/flight-logs/flights?mode=RTL');
      expect(rtl.json.flights.map((f) => f.flight_uid).sort()).toEqual([
        '20260920T070000Z-airvix01-a1b2',
        '20260921T080000Z-airvix01-c3d4',
      ]);
      const q = await request(server, `/api/flight-logs/flights?q=${encodeURIComponent('גליץ')}`);
      expect(q.json.flights.map((f) => f.flight_uid)).toEqual(['20260921T080000Z-airvix01-c3d4']);
      const day = await request(server, '/api/flight-logs/flights?from=2026-09-21&to=2026-09-21');
      expect(day.json.flights.map((f) => f.flight_uid)).toEqual(['20260921T080000Z-airvix01-c3d4']);

      const uidA = '20260920T070000Z-airvix01-a1b2';
      const bin = await request(server, `/api/flight-logs/flights/${uidA}/artifacts/${encodeURIComponent('fc/00000042.BIN.gz').replace(/%2F/g, '/')}`);
      expect(bin.status).toBe(200);
      expect(bin.headers.get('content-disposition')).toMatch(/attachment/);
      const pending = await request(server, '/api/flight-logs/flights/20260921T080000Z-airvix01-c3d4/artifacts/fc/00000043.BIN.gz');
      expect(pending.status).toBe(409);
      expect(pending.json.messageHe).toContain('הבקר כבוי');
      const traversal = await request(server, `/api/flight-logs/flights/${uidA}/artifacts/fc/..%2Fsecret.json`);
      expect(traversal.status).toBe(400);
      expect(traversal.text).not.toContain(SECRET);

      const series = await request(server, `/api/flight-logs/flights/${uidA}/series`);
      expect(series.json.series.alt_rel_m.t.length).toBeGreaterThan(2000);
      const partial = await request(server, '/api/flight-logs/flights/20260923T100000Z-airvix01-0789/series');
      expect(partial.json.series.throttle_pct).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }

    process.env.FLIGHT_LOGS_MODE = 'cloud';
    process.env.FLIGHT_CLOUD_ENDPOINT = 'http://127.0.0.1:9';
    process.env.FLIGHT_CLOUD_REGION = 'us-west-004';
    process.env.FLIGHT_CLOUD_BUCKET = 'airvix-flights';
    process.env.FLIGHT_CLOUD_KEY_ID = 'KEYIDEXAMPLE';
    process.env.FLIGHT_CLOUD_APP_KEY = SECRET;
    process.env.FLIGHT_CLOUD_VEHICLES = 'airvix01';
    _resetFlightLogsMemory();
    const emptyDb = openDatabase(':memory:');
    const cloudApp = express();
    registerFlightLogsApi(cloudApp, { db: emptyDb });
    const cloudServer = await listen(cloudApp);
    try {
      const status = await request(cloudServer, '/api/flight-logs/status');
      const synced = await request(cloudServer, '/api/flight-logs/sync', { method: 'POST' });
      const listed = await request(cloudServer, '/api/flight-logs/flights');
      const blob = `${status.text}\n${synced.text}\n${listed.text}`;
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain('KEYIDEXAMPLE');
      expect(status.json.configured).toBe(true);
      expect(listed.json.flights).toEqual([]);
    } finally {
      await new Promise((resolve) => cloudServer.close(resolve));
      emptyDb.close();
    }

    delete process.env.FLIGHT_LOGS_MODE;
    delete process.env.FLIGHT_CLOUD_APP_KEY;
    _resetFlightLogsMemory();
    const offDb = openDatabase(':memory:');
    offDb.prepare(`INSERT INTO flights (title, origin, flight_uid, classification) VALUES ('leftover', 'cloud', 'leftover-uid', 'flight')`).run();
    const off = listFlightLogs({ db: offDb }, {});
    expect(off.configured).toBe(false);
    expect(off.flights).toEqual([]);
    expect(off.messageHe).toBe(NOT_CONFIGURED_HE);
    offDb.close();
  });
});
