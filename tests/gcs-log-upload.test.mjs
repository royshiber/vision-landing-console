/**
 * GCS flight-log upload with a mock S3. Nothing on the network.
 * Upload stays off unless AIRVIX_GCS_LOG_UPLOAD=1.
 */
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../lib/flight-logs/s3-client.mjs';
import { createS3Writer } from '../lib/flight-logs/s3-write.mjs';
import {
  GCS_LOG_COPY,
  createGcsLogUploader,
  gcsLogUploadEnabled,
  safeObjectKey,
} from '../lib/flight-logs/gcs-upload.mjs';
import { registerGcsLogsApi } from '../lib/routes/gcs-logs-api.mjs';

const SECRET = 'unit-test-secret-not-real';

function creds(extra = {}) {
  return {
    AIRVIX_S3_ENDPOINT: 'https://s3.test.local',
    AIRVIX_S3_REGION: 'us-east-1',
    AIRVIX_S3_BUCKET: 'airvix-flight-logs',
    AIRVIX_S3_KEY_ID: 'unit-key',
    AIRVIX_S3_SECRET: SECRET,
    AIRVIX_S3_PREFIX: 'v1',
    AIRVIX_GCS_LOG_UPLOAD: '1',
    ...extra,
  };
}

function mockS3({ failSecondPart = true } = {}) {
  const objects = new Map();
  const uploads = new Map();
  const calls = [];
  let seq = 1;
  let failPart2 = failSecondPart;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, url, headers: init.headers || {}, body: init.body });
    const auth = String(init.headers?.authorization || '');
    if (auth.includes(SECRET)) throw new Error('secret leaked into Authorization');
    const parts = u.pathname.split('/').filter(Boolean);
    const key = decodeURIComponent(parts.slice(1).join('/'));
    const xml = (status, text, headers = {}) => new Response(text, { status, headers });
    if (method === 'POST' && u.searchParams.has('uploads')) {
      const id = `up-${seq}`;
      seq += 1;
      uploads.set(id, { key, parts: [] });
      return xml(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === 'PUT' && u.searchParams.get('uploadId')) {
      const id = u.searchParams.get('uploadId');
      const partNumber = Number(u.searchParams.get('partNumber'));
      if (partNumber === 2 && failPart2) {
        failPart2 = false;
        return xml(500, '<Error><Code>SlowDown</Code></Error>');
      }
      const body = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body || '');
      const etag = sha256Hex(body).slice(0, 16);
      uploads.get(id).parts.push({ partNumber, etag, body });
      return new Response('', { status: 200, headers: { etag: `"${etag}"` } });
    }
    if (method === 'POST' && u.searchParams.get('uploadId')) {
      const up = uploads.get(u.searchParams.get('uploadId'));
      const ordered = up.parts.slice().sort((a, b) => a.partNumber - b.partNumber);
      objects.set(up.key, Buffer.concat(ordered.map((p) => p.body)));
      return xml(200, '<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
    }
    if (method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const contents = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, buf]) => `<Contents><Key>${k}</Key><ETag>"abc"</ETag><Size>${buf.length}</Size></Contents>`)
        .join('');
      return xml(200, `<ListBucketResult>${contents}</ListBucketResult>`);
    }
    if (method === 'GET') {
      const buf = objects.get(key);
      if (!buf) return xml(404, 'missing');
      return new Response(buf, { status: 200, headers: { etag: '"abc"' } });
    }
    return xml(400, 'bad');
  };
  return { fetchImpl, objects, calls };
}

function tmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-logs-'));
  const archive = path.join(root, 'archive');
  fs.mkdirSync(archive);
  const file = path.join(archive, 'flight-1.tlog');
  const bytes = Buffer.from('abcdefghijklmnopqrst');
  fs.writeFileSync(file, bytes);
  return { root, archive, file, bytes };
}

describe('GCS flight log upload', () => {
  const servers = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it('stays off by default and does not call storage', async () => {
    expect(gcsLogUploadEnabled({})).toBe(false);
    const tree = tmpTree();
    let called = false;
    const uploader = createGcsLogUploader({
      env: creds({ AIRVIX_GCS_LOG_UPLOAD: '' }),
      storePath: path.join(tree.root, 'store.json'),
      archiveRoot: tree.archive,
      writer: { createMultipartUpload() { called = true; } },
    });
    const status = uploader.status();
    expect(status.enabled).toBe(false);
    expect(status.messageHe).toBe(GCS_LOG_COPY.off);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const result = await uploader.uploadFile(tree.file);
    expect(result.ok).toBe(false);
    expect(result.messageHe).toBe(GCS_LOG_COPY.off);
    expect(called).toBe(false);
  });

  it('resumes a multipart upload, then lists and downloads', async () => {
    const tree = tmpTree();
    const mock = mockS3();
    const writer = createS3Writer({
      endpoint: 'https://s3.test.local',
      region: 'us-east-1',
      bucket: 'airvix-flight-logs',
      accessKeyId: 'unit-key',
      secretAccessKey: SECRET,
      fetchImpl: mock.fetchImpl,
      now: () => new Date('2026-09-29T00:00:00Z'),
    });
    const uploader = createGcsLogUploader({
      env: creds(),
      storePath: path.join(tree.root, 'store.json'),
      archiveRoot: tree.archive,
      writer,
      partSize: 8,
    });
    const first = await uploader.uploadFile(tree.file);
    expect(first.ok).toBe(false);
    expect(first.job.state).toBe('interrupted');
    expect(first.messageHe).toBe(GCS_LOG_COPY.interrupted);
    expect(first.job.bytesSent).toBe(8);
    const part1Puts = mock.calls.filter((c) => c.method === 'PUT' && c.url.includes('partNumber=1'));
    expect(part1Puts).toHaveLength(1);

    const second = await uploader.resume(first.job.id);
    expect(second.ok).toBe(true);
    expect(second.job.state).toBe('complete');
    expect(second.job.messageHe).toBe(GCS_LOG_COPY.complete);
    expect(mock.calls.filter((c) => c.method === 'PUT' && c.url.includes('partNumber=1'))).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain(SECRET);

    const listed = await uploader.listRemote();
    expect(listed.map((item) => item.name)).toContain('flight-1.tlog');
    const got = await uploader.download(listed[0].key);
    expect(got.ok).toBe(true);
    expect(Buffer.compare(got.bytes, tree.bytes)).toBe(0);
    expect(safeObjectKey('../x', 'v1')).toBe(null);
    expect(await uploader.download('v1/other/secret.tlog')).toMatchObject({ ok: false });
  });

  it('serves Hebrew status and blocks upload when the flag is off', async () => {
    const tree = tmpTree();
    const app = express();
    app.use(express.json());
    const uploader = createGcsLogUploader({
      env: creds({ AIRVIX_GCS_LOG_UPLOAD: '0' }),
      storePath: path.join(tree.root, 'store.json'),
      archiveRoot: tree.archive,
      writer: { listObjectsV2: async () => ({ contents: [] }) },
    });
    registerGcsLogsApi(app, { gcsUploader: uploader, archiveRoot: tree.archive });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = server.address().port;
    const status = await fetch(`http://127.0.0.1:${port}/api/gcs-logs`).then((r) => r.json());
    expect(status.messageHe).toBe(GCS_LOG_COPY.off);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const posted = await fetch(`http://127.0.0.1:${port}/api/gcs-logs/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 1 }),
    });
    const body = await posted.json();
    expect(posted.status).toBeGreaterThanOrEqual(400);
    expect(body.messageHe).toBeTruthy();
  });

  it('marks a leftover uploading job interrupted and refuses its download', async () => {
    const tree = tmpTree();
    const storePath = path.join(tree.root, 'store.json');
    const mock = mockS3();
    const writer = createS3Writer({
      endpoint: 'https://s3.test.local',
      region: 'us-east-1',
      bucket: 'airvix-flight-logs',
      accessKeyId: 'unit-key',
      secretAccessKey: SECRET,
      fetchImpl: mock.fetchImpl,
      now: () => new Date('2026-09-29T00:00:00Z'),
    });
    const uploader = createGcsLogUploader({
      env: creds(),
      storePath,
      archiveRoot: tree.archive,
      writer,
      partSize: 8,
    });
    const first = await uploader.uploadFile(tree.file);
    expect(first.job.state).toBe('interrupted');
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const stored = Object.values(raw.jobs)[0];
    stored.state = 'uploading';
    stored.messageHe = GCS_LOG_COPY.uploading;
    fs.writeFileSync(storePath, JSON.stringify(raw));
    const restarted = createGcsLogUploader({
      env: creds(),
      storePath,
      archiveRoot: tree.archive,
      writer,
      partSize: 8,
    });
    const status = restarted.status();
    expect(status.items[0].state).toBe('interrupted');
    expect(status.items[0].messageHe).toBe(GCS_LOG_COPY.interrupted);
    const denied = await restarted.download(status.items[0].key);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(409);
    const resumed = await restarted.resume(status.items[0].id);
    expect(resumed.job.state).toBe('complete');
  });

  it('reports pending archive sessions and uploads each of them', async () => {
    const tree = tmpTree();
    const file2 = path.join(tree.archive, 'flight-2.tlog');
    fs.writeFileSync(file2, Buffer.from('second-log-bytes-here'));
    const mock = mockS3({ failSecondPart: false });
    const writer = createS3Writer({
      endpoint: 'https://s3.test.local',
      region: 'us-east-1',
      bucket: 'airvix-flight-logs',
      accessKeyId: 'unit-key',
      secretAccessKey: SECRET,
      fetchImpl: mock.fetchImpl,
      now: () => new Date('2026-09-29T00:00:00Z'),
    });
    const uploader = createGcsLogUploader({
      env: creds(),
      storePath: path.join(tree.root, 'store.json'),
      archiveRoot: tree.archive,
      writer,
      partSize: 8,
    });
    const sessions = [
      { id: 1, absPath: tree.file, downloadable: true, open: false, empty: false },
      { id: 2, absPath: file2, downloadable: true, open: false, empty: false },
    ];
    const app = express();
    app.use(express.json());
    registerGcsLogsApi(app, {
      gcsUploader: uploader,
      archiveRoot: tree.archive,
      listPendingSessions: () => sessions,
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = server.address().port;
    const before = await fetch(`http://127.0.0.1:${port}/api/gcs-logs`).then((r) => r.json());
    expect(before.messageHe).toBe(GCS_LOG_COPY.pending);
    expect(before.pendingSessionIds).toEqual([1, 2]);
    const posted = await fetch(`http://127.0.0.1:${port}/api/gcs-logs/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: before.pendingSessionIds }),
    });
    const body = await posted.json();
    expect(posted.status).toBe(200);
    expect(body.items.map((item) => item.name).sort()).toEqual(['flight-1.tlog', 'flight-2.tlog']);
    expect(body.pendingCount).toBe(0);
    const again = await fetch(`http://127.0.0.1:${port}/api/gcs-logs/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(404);
  });
});
