/**
 * Timestamped FC parameter snapshots beside the console database.
 * Not stored in the repo. No flight-good marker is invented.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataDir } from './db.mjs';

const ID_RE = /^[0-9]{10,16}-(read|write)-[a-f0-9]{8}$/;
const MAX_FILES = 80;

export function resolveFcParamFilesDir(db) {
  const name = db && typeof db.name === 'string' ? db.name : '';
  if (name && name !== ':memory:') {
    return path.join(path.dirname(path.resolve(name)), 'fc-param-files');
  }
  return path.join(dataDir, 'fc-param-files');
}

export function shouldRecordFcRead({ record, mavlinkConnected, connected, current }) {
  return record === true
    && mavlinkConnected === true
    && connected === true
    && current != null
    && typeof current === 'object'
    && !Array.isArray(current)
    && Object.keys(current).length > 0;
}

function indexPath(dir) {
  return path.join(dir, 'index.json');
}

function loadIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function copyParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (!key || value == null || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function saveFcParamFile(dir, { source, params, armed } = {}) {
  const kind = source === 'read' || source === 'write' ? source : '';
  const stored = copyParams(params);
  if (!kind || !stored || !dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${kind}-${crypto.randomBytes(4).toString('hex')}`;
  const savedAt = new Date().toISOString();
  const record = {
    id,
    source: kind,
    savedAt,
    armed: armed === true ? true : armed === false ? false : null,
    count: Object.keys(stored).length,
    params: stored,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record));
  const meta = {
    id,
    source: kind,
    savedAt,
    count: record.count,
    armed: record.armed,
  };
  const index = [meta, ...loadIndex(dir)].slice(0, MAX_FILES);
  const keep = new Set(index.map((item) => item.id));
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    const fileId = name.slice(0, -5);
    if (!keep.has(fileId)) fs.rmSync(path.join(dir, name), { force: true });
  }
  fs.writeFileSync(indexPath(dir), JSON.stringify(index));
  return meta;
}

export function listFcParamFiles(dir) {
  if (!dir) return [];
  return loadIndex(dir).map((item) => ({
    id: item.id,
    source: item.source,
    savedAt: item.savedAt,
    count: item.count,
    armed: item.armed === true ? true : item.armed === false ? false : null,
  }));
}

export function readFcParamFile(dir, id) {
  const name = String(id || '');
  if (!ID_RE.test(name) || !dir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    if (!raw || raw.id !== name || !raw.params || typeof raw.params !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Diff a saved snapshot against the current FC map.
 * No current map → לא ידוע. Missing key → חסר. Equal values are not changed.
 */
export function diffFcParamFile(snapshotParams, current) {
  const params = snapshotParams && typeof snapshotParams === 'object' && !Array.isArray(snapshotParams)
    ? snapshotParams
    : {};
  const rows = [];
  for (const key of Object.keys(params).sort()) {
    const nextText = String(params[key]);
    let currentText = 'לא ידוע';
    let changed = true;
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        currentText = 'חסר';
      } else {
        currentText = current[key] == null || current[key] === '' ? 'לא ידוע' : String(current[key]);
        changed = currentText !== nextText;
      }
    }
    rows.push({ key, currentText, nextText, changed });
  }
  return rows;
}
