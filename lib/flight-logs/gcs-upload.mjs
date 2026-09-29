/**
 * GCS-side flight log upload. Off unless AIRVIX_GCS_LOG_UPLOAD=1.
 * Multipart upload resumes from the last stored part. Secrets stay on the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { flightLogsConfig } from './provider.mjs';
import { createS3Writer } from './s3-write.mjs';
import { sha256Hex } from './s3-client.mjs';

export const GCS_LOG_COPY = Object.freeze({
  off: 'העלאת לוגים מהקרקע כבויה.',
  missing: 'אחסון הלוגים בענן לא הוגדר.',
  ready: 'מוכנים להעלאה.',
  uploading: 'מעלים לוג.',
  interrupted: 'ההעלאה נעצרה. אפשר להמשיך.',
  complete: 'הלוג עלה.',
  failed: 'ההעלאה נכשלה.',
  empty: 'אין לוגים להעלאה.',
  unsafe: 'הקובץ לא בארכיון. ההעלאה נדחתה.',
});

const DEFAULT_PART = 5 * 1024 * 1024;

export function gcsLogUploadEnabled(env = process.env) {
  const v = String(env.AIRVIX_GCS_LOG_UPLOAD ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function envFirst(env, ...names) {
  for (const name of names) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function gcsLogSettings(env = process.env) {
  const cloud = flightLogsConfig(env);
  const enabled = gcsLogUploadEnabled(env);
  const endpoint = envFirst(env, 'AIRVIX_S3_ENDPOINT', 'FLIGHT_CLOUD_ENDPOINT');
  const region = envFirst(env, 'AIRVIX_S3_REGION', 'FLIGHT_CLOUD_REGION');
  const bucket = envFirst(env, 'AIRVIX_S3_BUCKET', 'FLIGHT_CLOUD_BUCKET');
  const keyId = envFirst(env, 'AIRVIX_S3_KEY_ID', 'FLIGHT_CLOUD_KEY_ID');
  const secret = envFirst(env, 'AIRVIX_S3_SECRET', 'FLIGHT_CLOUD_APP_KEY', 'FLIGHT_CLOUD_SECRET');
  const vehicle = String(env.AIRVIX_GCS_VEHICLE_ID || 'gcs').trim().replace(/[^A-Za-z0-9._-]/g, '') || 'gcs';
  const prefix = (envFirst(env, 'AIRVIX_S3_PREFIX', 'FLIGHT_CLOUD_PREFIX') || cloud.prefix || 'v1').replace(/^\/+|\/+$/g, '') || 'v1';
  return {
    enabled,
    configured: Boolean(endpoint && region && bucket && keyId && secret),
    endpoint,
    region,
    bucket,
    keyId,
    secret,
    prefix,
    vehicle,
  };
}

export function safeObjectKey(key, prefix) {
  const k = String(key || '').replace(/\\/g, '/');
  const root = `${String(prefix || 'v1').replace(/^\/+|\/+$/g, '')}/gcs/`;
  if (!k.startsWith(root)) return null;
  if (k.includes('..') || k.includes('//')) return null;
  return k;
}

export function loadUploadStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.jobs) return { jobs: {} };
    return { jobs: parsed.jobs };
  } catch {
    return { jobs: {} };
  }
}

export function saveUploadStore(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ jobs: store.jobs || {} }));
  fs.renameSync(tmp, filePath);
}

function publicJob(job) {
  if (!job) return null;
  const total = Number(job.bytesTotal) || 0;
  const sent = Number(job.bytesSent) || 0;
  return {
    id: job.id,
    key: job.key,
    name: job.name,
    state: job.state,
    bytesSent: sent,
    bytesTotal: total,
    percent: total > 0 ? Math.round((sent / total) * 100) : 0,
    messageHe: job.messageHe || '',
    updatedAt: job.updatedAt || null,
  };
}

function messageFor(state) {
  if (state === 'complete') return GCS_LOG_COPY.complete;
  if (state === 'interrupted') return GCS_LOG_COPY.interrupted;
  if (state === 'uploading') return GCS_LOG_COPY.uploading;
  if (state === 'failed') return GCS_LOG_COPY.failed;
  return GCS_LOG_COPY.ready;
}

function insideRoot(filePath, root) {
  if (!root) return false;
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

export function createGcsLogUploader({
  env = process.env,
  storePath,
  archiveRoot,
  writer = null,
  partSize = DEFAULT_PART,
  now = () => new Date(),
} = {}) {
  const settings = gcsLogSettings(env);
  const store = loadUploadStore(storePath);

  function persist() {
    saveUploadStore(storePath, store);
  }

  function client() {
    if (writer) return writer;
    if (!settings.configured) return null;
    return createS3Writer({
      endpoint: settings.endpoint,
      region: settings.region,
      bucket: settings.bucket,
      accessKeyId: settings.keyId,
      secretAccessKey: settings.secret,
      now,
    });
  }

  function statusBody(extra = {}) {
    const items = Object.values(store.jobs).map(publicJob);
    let messageHe = GCS_LOG_COPY.off;
    let state = 'off';
    if (settings.enabled && !settings.configured) {
      messageHe = GCS_LOG_COPY.missing;
      state = 'missing';
    } else if (settings.enabled) {
      const active = items.find((item) => item.state === 'uploading' || item.state === 'interrupted');
      messageHe = active ? active.messageHe : (items.length ? GCS_LOG_COPY.ready : GCS_LOG_COPY.empty);
      state = active?.state || 'ready';
    }
    return {
      ok: true,
      enabled: settings.enabled,
      configured: settings.configured,
      credential: settings.configured ? 'present' : 'absent',
      state,
      messageHe,
      items,
      ...extra,
    };
  }

  async function uploadFile(absPath, { name } = {}) {
    if (!settings.enabled) {
      return { ...statusBody(), ok: false, status: 409, messageHe: GCS_LOG_COPY.off };
    }
    if (!settings.configured) {
      return { ...statusBody(), ok: false, status: 409, messageHe: GCS_LOG_COPY.missing };
    }
    const resolved = path.resolve(absPath);
    if (!insideRoot(resolved, archiveRoot) || path.extname(resolved).toLowerCase() !== '.tlog') {
      return { ...statusBody(), ok: false, status: 400, messageHe: GCS_LOG_COPY.unsafe };
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ...statusBody(), ok: false, status: 404, messageHe: GCS_LOG_COPY.failed };
    }
    if (!stat.isFile() || stat.size <= 0) {
      return { ...statusBody(), ok: false, status: 400, messageHe: GCS_LOG_COPY.empty };
    }
    const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, '_');
    const id = sha256Hex(`${resolved}\n${stat.size}`);
    const key = `${settings.prefix}/gcs/${settings.vehicle}/${base}`;
    let job = store.jobs[id];
    if (job?.state === 'complete') {
      return { ...statusBody(), ok: true, status: 200, job: publicJob(job) };
    }
    const s3 = client();
    if (!job?.uploadId) {
      const created = await s3.createMultipartUpload(key);
      job = {
        id,
        key,
        name: name || base,
        localPath: resolved,
        uploadId: created.uploadId,
        parts: [],
        nextPart: 1,
        bytesSent: 0,
        bytesTotal: stat.size,
        state: 'uploading',
        messageHe: GCS_LOG_COPY.uploading,
        updatedAt: now().toISOString(),
      };
      store.jobs[id] = job;
      persist();
    }
    const chunk = Math.max(1, Number(partSize) || DEFAULT_PART);
    try {
      while (job.bytesSent < job.bytesTotal) {
        const start = job.bytesSent;
        const length = Math.min(chunk, job.bytesTotal - start);
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(resolved, 'r');
        try {
          fs.readSync(fd, buf, 0, length, start);
        } finally {
          fs.closeSync(fd);
        }
        const part = await s3.uploadPart(key, {
          uploadId: job.uploadId,
          partNumber: job.nextPart,
          body: buf,
        });
        job.parts.push({ partNumber: job.nextPart, etag: part.etag });
        job.nextPart += 1;
        job.bytesSent += length;
        job.state = 'uploading';
        job.messageHe = GCS_LOG_COPY.uploading;
        job.updatedAt = now().toISOString();
        persist();
      }
      await s3.completeMultipartUpload(key, { uploadId: job.uploadId, parts: job.parts });
      job.state = 'complete';
      job.messageHe = GCS_LOG_COPY.complete;
      job.updatedAt = now().toISOString();
      persist();
      return { ...statusBody(), ok: true, status: 200, job: publicJob(job) };
    } catch {
      job.state = 'interrupted';
      job.messageHe = GCS_LOG_COPY.interrupted;
      job.updatedAt = now().toISOString();
      persist();
      return { ...statusBody(), ok: false, status: 502, job: publicJob(job), messageHe: GCS_LOG_COPY.interrupted };
    }
  }

  async function listRemote() {
    if (!settings.enabled || !settings.configured) return [];
    const s3 = client();
    const prefix = `${settings.prefix}/gcs/`;
    const page = await s3.listObjectsV2({ prefix });
    return (page.contents || [])
      .map((item) => ({
        key: item.key,
        size: item.size,
        name: path.posix.basename(item.key),
        state: 'complete',
        messageHe: GCS_LOG_COPY.complete,
      }))
      .filter((item) => safeObjectKey(item.key, settings.prefix));
  }

  async function download(key) {
    const safe = safeObjectKey(key, settings.prefix);
    if (!settings.enabled || !settings.configured || !safe) {
      return { ok: false, status: settings.enabled ? 404 : 409, messageHe: settings.enabled ? GCS_LOG_COPY.failed : GCS_LOG_COPY.off };
    }
    const got = await client().getObject(safe);
    return { ok: true, status: 200, key: safe, bytes: got.bytes, messageHe: GCS_LOG_COPY.complete };
  }

  return {
    settings: { ...settings, secret: undefined, keyId: undefined },
    status() {
      return statusBody();
    },
    uploadFile,
    async resume(id) {
      const job = store.jobs[id];
      if (!job) return { ...statusBody(), ok: false, status: 404, messageHe: GCS_LOG_COPY.failed };
      if (job.state === 'complete') return { ...statusBody(), ok: true, status: 200, job: publicJob(job) };
      return uploadFile(job.localPath, { name: job.name });
    },
    listRemote,
    download,
    messageFor,
  };
}
