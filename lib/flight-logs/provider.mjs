/**
 * Flight-log source: off (default), mock fixtures, or read-only cloud.
 * A URL or a partial key set never turns cloud on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../db.mjs';
import { createS3Client, sha256Hex } from './s3-client.mjs';
import { parseJsonMaybeGzip, reassembleChunks } from './objects.mjs';

function envFirst(env, ...names) {
  for (const name of names) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function flightIdFromIndexKey(key) {
  const base = path.posix.basename(String(key || '')).replace(/\.json$/i, '');
  const mark = base.indexOf('--');
  return mark === -1 ? base : base.slice(0, mark);
}

export function indexVariantRank(key) {
  const base = path.posix.basename(String(key || ''));
  if (base.includes('--in_flight.')) return 0;
  if (base.includes('--processing.')) return 1;
  return 2;
}

/** Keep one index object per flight. The canonical key wins over in-progress variants. */
export function preferIndexObjects(items) {
  const best = new Map();
  for (const item of items || []) {
    const flightId = flightIdFromIndexKey(item.key);
    if (!flightId) continue;
    const rank = indexVariantRank(item.key);
    const prev = best.get(flightId);
    if (!prev || rank >= prev.rank) best.set(flightId, { ...item, flightId, rank });
  }
  return [...best.values()];
}

export function flightLogsConfig(env = process.env) {
  const raw = String(env.FLIGHT_LOGS_MODE || 'off').trim().toLowerCase();
  const mode = raw === 'mock' || raw === 'cloud' ? raw : 'off';
  const endpoint = envFirst(env, 'AIRVIX_S3_ENDPOINT', 'FLIGHT_CLOUD_ENDPOINT');
  const region = envFirst(env, 'AIRVIX_S3_REGION', 'FLIGHT_CLOUD_REGION');
  const bucket = envFirst(env, 'AIRVIX_S3_BUCKET', 'FLIGHT_CLOUD_BUCKET');
  const keyId = envFirst(env, 'AIRVIX_S3_KEY_ID', 'FLIGHT_CLOUD_KEY_ID');
  const appKey = envFirst(env, 'AIRVIX_S3_SECRET', 'FLIGHT_CLOUD_APP_KEY', 'FLIGHT_CLOUD_SECRET');
  const cloudReady = Boolean(endpoint && region && bucket && keyId && appKey);
  const configured = mode === 'mock' || (mode === 'cloud' && cloudReady);
  const vehicles = envFirst(env, 'AIRVIX_S3_VEHICLES', 'FLIGHT_CLOUD_VEHICLES')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const prefix = (envFirst(env, 'AIRVIX_S3_PREFIX', 'FLIGHT_CLOUD_PREFIX') || 'v1').replace(/^\/+|\/+$/g, '') || 'v1';
  const fixtureRoot = String(env.FLIGHT_LOGS_FIXTURE_ROOT || '').trim()
    || path.join(projectRoot, 'tests', 'fixtures', 'flight-logs');
  return {
    mode,
    configured,
    cloudReady,
    prefix,
    vehicles,
    fixtureRoot,
    endpoint,
    region,
    bucket,
    keyId,
    appKey: mode === 'cloud' ? appKey : '',
  };
}

function assertSafeKey(key) {
  const rel = String(key || '').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel)) {
    const err = new Error('bad object key');
    err.status = 400;
    throw err;
  }
  return rel;
}

function resolveUnder(root, key) {
  const rel = assertSafeKey(key);
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) {
    const err = new Error('bad object key');
    err.status = 400;
    throw err;
  }
  return full;
}

function createOffProvider(cfg) {
  return {
    cfg,
    async listVehicles() { return []; },
    async listIndex() { return []; },
    async getBytes() {
      const err = new Error('flight logs off');
      err.status = 409;
      throw err;
    },
    async readJson() {
      const err = new Error('flight logs off');
      err.status = 409;
      throw err;
    },
    async readChunked() {
      const err = new Error('flight logs off');
      err.status = 409;
      throw err;
    },
  };
}

function createMockProvider(cfg) {
  const root = cfg.fixtureRoot;
  return {
    cfg,
    async listVehicles() {
      if (cfg.vehicles.length) return cfg.vehicles;
      const dir = path.join(root, cfg.prefix);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    },
    async listIndex(vehicle) {
      const dir = resolveUnder(root, `${cfg.prefix}/${vehicle}/index`);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const key = `${cfg.prefix}/${vehicle}/index/${name}`;
          const bytes = fs.readFileSync(resolveUnder(root, key));
          return {
            key,
            etag: sha256Hex(bytes),
            flightId: name.replace(/\.json$/, ''),
            size: bytes.length,
          };
        });
    },
    async getBytes(key) {
      const full = resolveUnder(root, key);
      if (!fs.existsSync(full)) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      const bytes = fs.readFileSync(full);
      return { bytes, etag: sha256Hex(bytes) };
    },
    async readJson(key) {
      const { bytes, etag } = await this.getBytes(key);
      return { json: parseJsonMaybeGzip(bytes), etag, bytes };
    },
    async readChunked(baseKey) {
      const partsObj = await this.readJson(`${baseKey}.parts.json`);
      const manifest = partsObj.json;
      const buffers = [];
      const parts = [...(manifest.parts || [])].sort((a, b) => Number(a.n) - Number(b.n));
      for (const part of parts) {
        const n = String(part.n).padStart(4, '0');
        const got = await this.getBytes(`${baseKey}.part${n}`);
        buffers.push(got.bytes);
      }
      return reassembleChunks(manifest, buffers);
    },
  };
}

function createCloudProvider(cfg) {
  const s3 = createS3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyId: cfg.keyId,
    secretAccessKey: cfg.appKey,
  });
  return {
    cfg,
    async listVehicles() {
      if (cfg.vehicles.length) return cfg.vehicles;
      const listed = await s3.listObjectsV2({ prefix: `${cfg.prefix}/`, delimiter: '/' });
      return listed.prefixes
        .map((p) => p.replace(new RegExp(`^${cfg.prefix}/`), '').replace(/\/$/, ''))
        .filter(Boolean);
    },
    async listIndex(vehicle) {
      const prefix = `${cfg.prefix}/${vehicle}/index/`;
      const listed = await s3.listObjectsV2({ prefix });
      return listed.contents
        .filter((o) => o.key.endsWith('.json'))
        .map((o) => ({
          key: o.key,
          etag: o.etag,
          flightId: path.posix.basename(o.key).replace(/\.json$/, ''),
          size: o.size,
        }));
    },
    async getBytes(key) {
      assertSafeKey(key);
      return s3.getObject(key);
    },
    async readJson(key) {
      const { bytes, etag } = await this.getBytes(key);
      return { json: parseJsonMaybeGzip(bytes), etag, bytes };
    },
    async readChunked(baseKey) {
      assertSafeKey(baseKey);
      const partsObj = await this.readJson(`${baseKey}.parts.json`);
      const manifest = partsObj.json;
      const parts = [...(manifest.parts || [])].sort((a, b) => Number(a.n) - Number(b.n));
      const buffers = [];
      for (const part of parts) {
        const n = String(part.n).padStart(4, '0');
        const got = await this.getBytes(`${baseKey}.part${n}`);
        buffers.push(got.bytes);
      }
      return reassembleChunks(manifest, buffers);
    },
  };
}

export function createFlightLogProvider(env = process.env) {
  const cfg = flightLogsConfig(env);
  if (!cfg.configured) return createOffProvider(cfg);
  if (cfg.mode === 'mock') return createMockProvider(cfg);
  if (cfg.mode === 'cloud') return createCloudProvider(cfg);
  return createOffProvider(cfg);
}

export function artifactObjectKey(cfg, vehicleId, flightId, name) {
  return `${cfg.prefix}/${vehicleId}/flights/${flightId}/${name}`;
}
