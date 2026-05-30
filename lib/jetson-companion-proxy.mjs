import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { projectRoot } from './db.mjs';

const DEFAULT_HTTP_PORT = 8081;
const DEFAULT_RELAY_PORT = 5770;

export function clientIpFromRequest(req) {
  const raw =
    String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      ?.trim() ||
    req.socket?.remoteAddress ||
    '';
  return raw.replace(/^::ffff:/i, '');
}

/** @param {object} jetsonState @param {string} [envBaseUrl] */
export function getCompanionBaseUrl(jetsonState, envBaseUrl = '') {
  const env = String(envBaseUrl || '').trim().replace(/\/$/, '');
  if (env) return env;
  const fromHb = String(jetsonState?.companionHttpUrl || '').trim().replace(/\/$/, '');
  if (fromHb) return fromHb;
  const ip = String(jetsonState?.peerIp || '').trim();
  const port = Number(jetsonState?.companionHttpPort) || DEFAULT_HTTP_PORT;
  if (ip) return `http://${ip}:${port}`;
  return null;
}

export function companionAuthHeaders() {
  const token = String(process.env.COMPANION_SHARED_SECRET || '').trim();
  return token ? { 'X-Companion-Token': token, Authorization: `Bearer ${token}` } : {};
}

async function companionFetch(baseUrl, pathname, { method = 'GET', body } = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${pathname}`;
  const headers = { ...companionAuthHeaders() };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.message || data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function listCompanionLogs(baseUrl) {
  const data = await companionFetch(baseUrl, '/api/logs');
  const files = Array.isArray(data.logs) ? data.logs : Array.isArray(data.files) ? data.files : [];
  return files.map((f) => (typeof f === 'string' ? { name: f } : f));
}

export async function downloadCompanionLog(baseUrl, name) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/logs/${encodeURIComponent(name)}`;
  const r = await fetch(url, { headers: companionAuthHeaders(), signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`download ${name} failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, mime: r.headers.get('content-type') || 'application/octet-stream' };
}

export async function deployCompanionAgent(baseUrl, scriptText, version) {
  return companionFetch(baseUrl, '/api/install', {
    method: 'POST',
    body: { version, script: scriptText },
  });
}

export function buildJetsonRelayTargets(jetsonState, env = {}) {
  /** @type {{ type: 'tcp', host: string, port: number, label: string }[]} */
  const out = [];
  const seen = new Set();
  const add = (host, port, label) => {
    const h = String(host || '').trim();
    const p = Number(port);
    if (!h || !Number.isFinite(p)) return;
    const k = `${h}:${p}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type: 'tcp', host: h, port: p, label });
  };

  const ip = String(jetsonState?.peerIp || '').trim();
  const relayPort = Number(jetsonState?.relayPort) || DEFAULT_RELAY_PORT;
  if (ip) add(ip, relayPort, `Jetson MAVLink relay (${ip}:${relayPort})`);

  const envUrl = String(env.JETSON_COMPANION_BASE_URL || '').trim();
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      add(u.hostname, relayPort, `Jetson relay (env ${u.hostname})`);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function buildSitlFallbackTargets() {
  return [
    { type: 'udp', host: '0.0.0.0', port: 14550, label: 'SITL UDP 14550' },
    { type: 'tcp', host: '127.0.0.1', port: 5760, label: 'SITL TCP 5760' },
  ];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ flightId: number, source: string, originalName: string, buf: Buffer, mime?: string }} opts
 */
export async function saveLogArtifactBuffer(db, { flightId, source, originalName, buf, mime = 'application/octet-stream' }) {
  const uploadsRoot = path.join(projectRoot, 'uploads');
  await mkdir(uploadsRoot, { recursive: true });
  const safe = String(originalName || 'log').replace(/[^\w.\-]+/g, '_');
  const storedName = `${Date.now()}-${safe}`;
  const abs = path.join(uploadsRoot, storedName);
  await writeFile(abs, buf);
  let textExcerpt = '';
  if (/\.(log|txt|csv|tlog)$/i.test(safe) || mime.startsWith('text/')) {
    try {
      textExcerpt = buf.toString('utf8').slice(0, 120_000);
    } catch {
      textExcerpt = '(לא ניתן לקרוא כטקסט)';
    }
  } else {
    textExcerpt = `(קובץ בינארי — ${safe})`;
  }
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
  const r = db
    .prepare(
      `INSERT INTO log_artifacts (flight_id, source, original_name, stored_path, mime, size_bytes, text_excerpt) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(flightId, source, originalName, rel, mime, buf.length, textExcerpt);
  return { id: r.lastInsertRowid, storedName, excerptLen: textExcerpt.length };
}

export async function readCompanionAgentScript() {
  const p = path.join(projectRoot, 'scripts', 'jetson-companion', 'companion_agent.py');
  return readFile(p, 'utf8');
}
