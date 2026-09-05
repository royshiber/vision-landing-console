import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, getConfig } from '../lib/db.mjs';
import { createCompanionService, resolveCompanionMode } from '../lib/companion-service.mjs';
import { registerCompanionConnectionApi } from '../lib/routes/companion-connection-api.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import {
  COMPANION_CONNECTION_KEY,
  COMPANION_HE,
  hebrewCompanionError,
  maskCompanionToken,
  mergeCompanionEnv,
  readStoredCompanionConnection,
  validateCompanionBaseUrl,
  validateCompanionToken,
  writeStoredCompanionConnection,
} from '../lib/companion-connection.mjs';
import { CompanionApiError } from '../lib/companion-api-client.mjs';
import { payloadContainsSecret } from '../lib/coding-agent-connection.mjs';
import { logger } from '../lib/logger.mjs';

const TOKEN = 'companion-connect-token-9f3a2c1b';
const BASE_URL = 'http://jetson.example:8081';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okFetch() {
  return vi.fn(async () => jsonResponse({
    ok: true,
    status: 'OK',
    api_version: 'v1',
    companion_version: 'test',
    system: { status: 'OK', cpu_percent: 3 },
  }));
}

function startApp({ fetchImpl, companionEnv = {}, db, extraServiceEnv = {} } = {}) {
  const impl = fetchImpl || okFetch();
  const merged = mergeCompanionEnv(companionEnv, readStoredCompanionConnection(db));
  const companionService = createCompanionService(
    { ...extraServiceEnv, ...merged },
    { fetchImpl: impl, timeoutMs: 80, pollMs: 30_000 },
  );
  const app = express();
  app.use(express.json());
  const ctx = {
    db,
    companionService,
    companionEnv,
    companionFetchImpl: impl,
    companionTimeoutMs: 80,
  };
  registerCompanionConnectionApi(app, ctx);
  registerCompanionProxyApi(app, ctx);
  return { app, companionService, fetchImpl: impl, ctx };
}

describe('companion connection helpers', () => {
  it('masks tokens and never returns the raw secret', () => {
    expect(maskCompanionToken(TOKEN)).toBe('••••2c1b');
    expect(maskCompanionToken(TOKEN)).not.toBe(TOKEN);
    expect(maskCompanionToken('abcd')).toBe('••••');
    expect(maskCompanionToken('')).toBe(null);
  });

  it('rejects an empty or invalid base URL in Hebrew', () => {
    expect(validateCompanionBaseUrl('').status_he).toBe(COMPANION_HE.urlEmpty);
    expect(validateCompanionBaseUrl('   ').error).toBe('url_empty');
    expect(validateCompanionBaseUrl('not-a-url').error).toBe('url_invalid');
    expect(validateCompanionBaseUrl('ftp://jetson:8081').error).toBe('url_invalid');
    expect(validateCompanionBaseUrl('http://jetson:8081').ok).toBe(true);
    expect(validateCompanionBaseUrl('http://jetson:8081/api/v1/').url).toBe('http://jetson:8081/api/v1');
    expect(validateCompanionToken('').status_he).toBe(COMPANION_HE.tokenEmpty);
    expect(validateCompanionToken('   ').error).toBe('token_empty');
    expect(validateCompanionToken(TOKEN).ok).toBe(true);
  });

  it('maps CompanionApiError kinds including 401 to Hebrew', () => {
    expect(hebrewCompanionError(new CompanionApiError({ kind: 'http', status: 401, message: 'nope' })))
      .toBe(COMPANION_HE.unauthorized);
    expect(COMPANION_HE.unauthorized).toMatch(/אסימון/);
    expect(COMPANION_HE.hint).toMatch(/כתובת לבד לא מחברת/);
    expect(COMPANION_HE.bothGate).toMatch(/כתובת לבד לא מחברת/);
    expect(hebrewCompanionError(new CompanionApiError({ kind: 'timeout', message: 't' })))
      .toBe(COMPANION_HE.timeout);
    expect(hebrewCompanionError(new CompanionApiError({ kind: 'connection', message: 'c' })))
      .toBe(COMPANION_HE.connectFailed);
    expect(hebrewCompanionError(new CompanionApiError({ kind: 'http', status: 503, message: 'down' })))
      .toBe(COMPANION_HE.httpError);
    expect(hebrewCompanionError(new CompanionApiError({ kind: 'config', message: 'missing' })))
      .toBe(COMPANION_HE.urlEmpty);
  });

  it('does not enable real from a stored URL alone', () => {
    const env = mergeCompanionEnv(
      { COMPANION_MODE: '', JETSON_COMPANION_BASE_URL: '' },
      { connected: false, baseUrl: BASE_URL, token: TOKEN },
    );
    expect(resolveCompanionMode(env)).toBe('off');
    expect(env.COMPANION_MODE || '').not.toBe('real');
    const svc = createCompanionService(env);
    expect(svc.mode).toBe('off');
    expect(svc.client).toBeNull();
  });

  it('enables real only when stored connect sets BOTH mode and URL', () => {
    const env = mergeCompanionEnv(
      { COMPANION_MODE: 'off' },
      { connected: true, baseUrl: BASE_URL, token: TOKEN },
    );
    expect(env.COMPANION_MODE).toBe('real');
    expect(env.JETSON_COMPANION_BASE_URL).toBe(BASE_URL);
    expect(resolveCompanionMode(env)).toBe('real');
    expect(resolveCompanionMode({ COMPANION_MODE: 'real' })).toBe('off');
    expect(resolveCompanionMode({ JETSON_COMPANION_BASE_URL: BASE_URL })).toBe('off');
  });
});

describe('Companion in-product v1 connect', () => {
  let server;
  let base;
  let root;
  let db;
  let logChunks;

  async function boot(opts = {}) {
    const started = startApp({ ...opts, db });
    server = await listen(started.app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
    return started;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-companion-connect-'));
    db = openDatabase(path.join(root, 'app.sqlite'));
    logChunks = [];
    const origInfo = logger.info.bind(logger);
    const origWarn = logger.warn.bind(logger);
    const origError = logger.error.bind(logger);
    const capture = (...args) => { logChunks.push(JSON.stringify(args)); };
    logger.info = (...args) => { capture(...args); return origInfo(...args); };
    logger.warn = (...args) => { capture(...args); return origWarn(...args); };
    logger.error = (...args) => { capture(...args); return origError(...args); };
    logger.__restore = () => {
      logger.info = origInfo;
      logger.warn = origWarn;
      logger.error = origError;
    };
  });

  afterEach(async () => {
    logger.__restore?.();
    if (server) await new Promise((r) => server.close(r));
    server = null;
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('persists connect, hydrates real, and never echoes the raw token', async () => {
    const first = await boot();
    const before = await fetch(`${base}/api/companion/connection`).then((r) => r.json());
    expect(before.mode).toBe('off');
    expect(before.connect_available).toBe(true);
    expect(before.hint_he).toBe(COMPANION_HE.hint);
    expect(before.status_he).toBe(COMPANION_HE.disconnected);
    expect(JSON.stringify(before)).not.toContain(TOKEN);

    const connected = await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL, token: TOKEN }),
    }).then((r) => r.json());
    expect(connected.ok).toBe(true);
    expect(connected.mode).toBe('real');
    expect(connected.connected).toBe(true);
    expect(connected.status_he).toBe(COMPANION_HE.connected);
    expect(connected.token_hint).toBe(maskCompanionToken(TOKEN));
    expect(connected.base_url).toBe(BASE_URL);
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    expect(first.companionService.mode).toBe('real');
    expect(first.companionService.baseUrl).toBe(BASE_URL);

    const stored = getConfig(db, COMPANION_CONNECTION_KEY);
    expect(stored.token).toBe(TOKEN);
    expect(stored.connected).toBe(true);
    expect(stored.baseUrl).toBe(BASE_URL);

    await new Promise((r) => server.close(r));
    server = null;
    const restarted = await boot();
    const hydrated = await fetch(`${base}/api/companion/connection`).then((r) => r.json());
    expect(hydrated.mode).toBe('real');
    expect(hydrated.token_hint).toBe('••••2c1b');
    expect(JSON.stringify(hydrated)).not.toContain(TOKEN);
    expect(restarted.companionService.mode).toBe('real');
    expect(logChunks.join('\n')).not.toContain(TOKEN);
  });

  it('keeps BOTH gate: URL alone leaves companion off', async () => {
    writeStoredCompanionConnection(db, {
      connected: false,
      baseUrl: BASE_URL,
      token: TOKEN,
    });
    const started = await boot({ companionEnv: { JETSON_COMPANION_BASE_URL: BASE_URL } });
    const status = await fetch(`${base}/api/companion/connection`).then((r) => r.json());
    expect(status.mode).toBe('off');
    expect(status.connected).toBe(false);
    expect(started.companionService.mode).toBe('off');
    expect(started.companionService.client).toBeNull();
    expect(resolveCompanionMode({ JETSON_COMPANION_BASE_URL: BASE_URL })).toBe('off');
  });

  it('rejects an empty token in Hebrew without probing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }, 200));
    await boot({ fetchImpl });
    const res = await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.status_he).toBe(COMPANION_HE.tokenEmpty);
    expect(body.error).toBe('token_empty');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readStoredCompanionConnection(db).connected).toBe(false);
  });

  it('maps HTTP 401 to the Hebrew token error and does not persist real', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'unauthorized' }, 401));
    await boot({ fetchImpl });
    const res = await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL, token: TOKEN }),
    });
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.status_he).toBe(COMPANION_HE.unauthorized);
    expect(body.error).toBe('unauthorized');
    expect(readStoredCompanionConnection(db).connected).toBe(false);
    const after = await fetch(`${base}/api/companion/connection`).then((r) => r.json());
    expect(after.mode).toBe('off');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('maps timeout to Hebrew and stays off', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    await boot({ fetchImpl });
    const res = await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL, token: TOKEN }),
    });
    const body = await res.json();
    expect(res.status).toBe(504);
    expect(body.status_he).toBe(COMPANION_HE.timeout);
    expect(readStoredCompanionConnection(db).connected).toBe(false);
  });

  it('rejects a missing URL without becoming real', async () => {
    await boot();
    const res = await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.status_he).toBe(COMPANION_HE.urlEmpty);
    expect(body.mode).toBe('off');
  });

  it('disconnects to off, clears the token, and keeps the BOTH gate', async () => {
    const started = await boot();
    await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL, token: TOKEN }),
    });
    expect(started.companionService.mode).toBe('real');

    const disconnected = await fetch(`${base}/api/companion/connection/disconnect`, {
      method: 'POST',
    }).then((r) => r.json());
    expect(disconnected.mode).toBe('off');
    expect(disconnected.connected).toBe(false);
    expect(disconnected.status_he).toBe(COMPANION_HE.disconnected);
    expect(disconnected.token_hint).toBe(null);
    expect(JSON.stringify(disconnected)).not.toContain(TOKEN);
    expect(readStoredCompanionConnection(db).token).toBe(null);
    expect(readStoredCompanionConnection(db).connected).toBe(false);
    expect(started.companionService.mode).toBe('off');
    expect(started.companionService.client).toBeNull();
  });

  it('disconnect from env real returns to off without staying live', async () => {
    const started = await boot({
      companionEnv: {
        COMPANION_MODE: 'real',
        JETSON_COMPANION_BASE_URL: BASE_URL,
        JETSON_COMPANION_TOKEN: TOKEN,
      },
    });
    expect(started.companionService.mode).toBe('real');
    const disconnected = await fetch(`${base}/api/companion/connection/disconnect`, {
      method: 'POST',
    }).then((r) => r.json());
    expect(disconnected.mode).toBe('off');
    expect(started.companionService.mode).toBe('off');
  });

  it('updates the live service overlay after connect', async () => {
    const started = await boot();
    await started.companionService.start();
    expect(started.companionService.getSseOverlay().companion.mode).toBe('off');
    const connected = await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL, token: TOKEN }),
    }).then((r) => r.json());
    expect(connected.mode).toBe('real');
    const overlay = started.companionService.getSseOverlay().companion;
    expect(overlay.mode).toBe('real');
    expect(overlay.api).toBe('v1');
  });

  it('does not leak the token in JSON logs', async () => {
    await boot();
    await fetch(`${base}/api/companion/connection/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: BASE_URL, token: TOKEN }),
    });
    expect(payloadContainsSecret(logChunks.join('\n'), [TOKEN])).toBe(false);
  });
});

describe('Companion connect chrome', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('puts a Hebrew connect control on the telemetry companion dashboard', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
    expect(html).toMatch(/id="companionConnect"/);
    expect(html).toMatch(/id="companionBaseUrl"/);
    expect(html).toMatch(/id="companionToken"[^>]*type="password"/);
    expect(html).toMatch(/id="companionConnectBtn"[^>]*>חיבור</);
    expect(html).toMatch(/id="companionDisconnectBtn"[^>]*>ניתוק</);
    expect(html).toMatch(/כתובת בסיס/);
    expect(html).toMatch(/אסימון/);
    expect(html).toMatch(/חיבור דורש כתובת ואסימון יחד/);
    expect(html).toMatch(/כתובת לבד לא מחברת/);
    expect(html).toMatch(/id="companionConnectForm"[^>]*novalidate/);
    expect(html).toMatch(/id="companionBaseUrl"[^>]*type="text"/);
    expect(html).not.toMatch(/id="companionBaseUrl"[^>]*type="url"/);
    expect(html).not.toMatch(/כתובת הבסיס חייבת לשרת/);
    expect(html).toMatch(/id="maintCompanionConnectStatus"/);
    expect(html).not.toMatch(/JETSON_COMPANION_TOKEN/);
    expect(html).not.toMatch(/COMPANION_SHARED_SECRET/);
    expect(html).not.toMatch(/100\.82\.59\.45/);
  });
});
