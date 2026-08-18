import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createCompanionService } from '../lib/companion-service.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { COMPANION_PROXY_PREFIX } from '../lib/companion-v1-paths.mjs';
import { getCompanionBaseUrl } from '../lib/jetson-companion-proxy.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('companion proxy routes', () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const companionService = createCompanionService({ COMPANION_MODE: 'mock' });
    registerCompanionProxyApi(app, { companionService });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('discovers the NEW lane without talking to a Jetson', async () => {
    const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}`);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.lane).toBe('NEW');
    expect(j.mode).toBe('mock');
    expect(j.forbidden).toContain('ARM');
  });

  it('proxies status and vision result', async () => {
    const status = await fetch(`${base}${COMPANION_PROXY_PREFIX}/status`).then((r) => r.json());
    const vision = await fetch(`${base}${COMPANION_PROXY_PREFIX}/vision/result`).then((r) => r.json());
    expect(status.ok).toBe(true);
    expect(status.data.timestamp).toBeTruthy();
    expect(status.data.vision.fps).toBe(30);
    expect(vision.ok).toBe(true);
    expect(vision.data.quality.confidence).not.toBeUndefined();
  });

  it('proxies config and policy reads/writes without apply', async () => {
    const cfg = await fetch(`${base}${COMPANION_PROXY_PREFIX}/config`).then((r) => r.json());
    const pol = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy`).then((r) => r.json());
    const preview = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy/preview`).then((r) => r.json());
    const patch = await fetch(`${base}${COMPANION_PROXY_PREFIX}/config/runtime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visionEnabled: true }),
    }).then((r) => r.json());
    const put = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: {} }),
    }).then((r) => r.json());
    expect(cfg.ok && pol.ok && preview.ok && patch.ok && put.ok).toBe(true);
    expect(preview.data.applySupported).toBe(false);
    expect(patch.data.applied).toBe(false);
    expect(put.data.applied).toBe(false);
  });

  it('does not expose ARM / LAND', async () => {
    const arm = await fetch(`${base}${COMPANION_PROXY_PREFIX}/arm`, { method: 'POST' });
    const land = await fetch(`${base}${COMPANION_PROXY_PREFIX}/land`, { method: 'POST' });
    expect(arm.status).toBe(404);
    expect(land.status).toBe(404);
    const body = await arm.json();
    expect(body.code).toBe('companion_forbidden');
  });

  it('does not expose policy apply', async () => {
    const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy/apply`, { method: 'POST' });
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('companion_forbidden');
  });

  it('switches mock scenario from the console-only route', async () => {
    const put = await fetch(`${base}${COMPANION_PROXY_PREFIX}/_console/mock-scenario`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'disconnected' }),
    });
    expect(put.ok).toBe(true);
    const got = await fetch(`${base}${COMPANION_PROXY_PREFIX}/_console/mock-scenario`).then((r) => r.json());
    expect(got.scenario).toBe('disconnected');
    await fetch(`${base}${COMPANION_PROXY_PREFIX}/_console/mock-scenario`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'healthy' }),
    });
  });

  it('returns 503 when companion is off', async () => {
    const app = express();
    registerCompanionProxyApi(app, { companionService: createCompanionService({ COMPANION_MODE: 'off' }) });
    const s = await listen(app);
    try {
      const addr = s.address();
      const r = await fetch(`http://127.0.0.1:${addr.port}${COMPANION_PROXY_PREFIX}/status`);
      expect(r.status).toBe(503);
      const j = await r.json();
      expect(j.code).toBe('companion_disabled');
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });
});

describe('companion service config', () => {
  it('selects real mode from JETSON_COMPANION_BASE_URL', () => {
    const svc = createCompanionService({
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: 'http://jetson:8080',
    });
    expect(svc.mode).toBe('real');
    expect(svc.baseUrl).toBe('http://jetson:8080');
    expect(svc.client.kind).toBe('real');
  });

  it('keeps a base URL that already includes /api/v1', () => {
    const svc = createCompanionService({
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: 'http://jetson:8472/api/v1',
    });
    expect(svc.mode).toBe('real');
    expect(svc.baseUrl).toBe('http://jetson:8472/api/v1');
    expect(svc.client.eventsUrl()).toBe('http://jetson:8472/api/v1/events');
  });

  it('defaults to off without URL so existing UI stays on legacy state', () => {
    const svc = createCompanionService({ COMPANION_MODE: '', JETSON_COMPANION_BASE_URL: '' });
    expect(svc.mode).toBe('off');
    expect(svc.client).toBeNull();
  });

  it('mock does not require a base URL', () => {
    const svc = createCompanionService({ COMPANION_MODE: 'mock' });
    expect(svc.mode).toBe('mock');
    expect(svc.describe().baseUrl).toBe('mock://companion');
  });

  it('does not send legacy companion_agent calls to a v1 API base', () => {
    const v1 = 'http://jetson:8472/api/v1';
    expect(getCompanionBaseUrl({ companionHttpUrl: 'http://192.0.2.8:8081' }, v1)).toBe(
      'http://192.0.2.8:8081',
    );
    expect(getCompanionBaseUrl({}, v1)).toBe(null);
    expect(getCompanionBaseUrl({}, 'http://jetson:8081')).toBe('http://jetson:8081');
  });
});
