import { describe, expect, it, vi } from 'vitest';
import {
  CompanionApiError,
  createCompanionApiClient,
  joinCompanionUrl,
  resolveCompanionV1BaseUrl,
} from '../lib/companion-api-client.mjs';
import { COMPANION_V1_PATHS } from '../lib/companion-v1-paths.mjs';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CompanionApiClient', () => {
  it('uses JETSON_COMPANION_BASE_URL from env', () => {
    expect(resolveCompanionV1BaseUrl({ JETSON_COMPANION_BASE_URL: 'http://jetson:8080/' })).toBe(
      'http://jetson:8080',
    );
    expect(resolveCompanionV1BaseUrl({})).toBe(null);
  });

  it('does not hard-code a device IP', async () => {
    const src = await import('../lib/companion-api-client.mjs?cachebust=ip');
    const text = (await import('fs')).readFileSync(
      new URL('../lib/companion-api-client.mjs', import.meta.url),
      'utf8',
    );
    expect(text).not.toContain('100.82.59.45');
    expect(src.resolveCompanionV1BaseUrl({})).toBe(null);
  });

  it('joins origin-only and /api/v1 bases without duplicating the prefix', () => {
    expect(joinCompanionUrl('http://jetson:8080', '/api/v1/health')).toBe(
      'http://jetson:8080/api/v1/health',
    );
    expect(joinCompanionUrl('http://jetson:8472/api/v1', '/api/v1/health')).toBe(
      'http://jetson:8472/api/v1/health',
    );
    expect(joinCompanionUrl('http://jetson:8472/api/v1/', COMPANION_V1_PATHS.status)).toBe(
      'http://jetson:8472/api/v1/status',
    );
    expect(joinCompanionUrl('http://jetson:8472/api/v1', COMPANION_V1_PATHS.events)).toBe(
      'http://jetson:8472/api/v1/events',
    );
  });

  it('requests /api/v1/health when env base already includes /api/v1', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('http://jetson:8472/api/v1/health');
      return jsonResponse({ ok: true, api_version: '1' });
    });
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8472/api/v1',
      fetchImpl,
      timeoutMs: 500,
    });
    const data = await client.getHealth();
    expect(data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('succeeds and calls /api/v1/health', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('http://jetson:8080/api/v1/health');
      return jsonResponse({ ok: true, status: 'OK', api: 'v1' });
    });
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8080',
      fetchImpl,
      timeoutMs: 500,
    });
    const data = await client.getHealth();
    expect(data.ok).toBe(true);
    expect(client.apiVersion).toBe('v1');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('times out', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8080',
      fetchImpl,
      timeoutMs: 30,
    });
    await expect(client.getStatus()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps connection failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8080',
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(client.getVersion()).rejects.toBeInstanceOf(CompanionApiError);
    await expect(client.getVersion()).rejects.toMatchObject({ kind: 'connection' });
  });

  it('rejects invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{not-json', { status: 200 }));
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8080',
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(client.getStatus()).rejects.toMatchObject({ kind: 'parse' });
  });

  it('maps HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'nope' }, 503));
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8080',
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(client.getDiagnostics()).rejects.toMatchObject({ kind: 'http', status: 503 });
  });

  it('fails closed when base URL missing', async () => {
    const client = createCompanionApiClient({ baseUrl: null, fetchImpl: vi.fn() });
    await expect(client.getHealth()).rejects.toMatchObject({ kind: 'config' });
  });

  it('sends PATCH runtime and PUT policy only as writes', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return jsonResponse({ ok: true });
    });
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8080',
      fetchImpl,
      env: { COMPANION_SHARED_SECRET: 'tok' },
    });
    await client.patchConfigRuntime({ visionEnabled: true });
    await client.putPolicy({ channels: {} });
    expect(calls[0]).toEqual({
      url: `http://jetson:8080${COMPANION_V1_PATHS.configRuntime}`,
      method: 'PATCH',
    });
    expect(calls[1]).toEqual({
      url: `http://jetson:8080${COMPANION_V1_PATHS.policy}`,
      method: 'PUT',
    });
    expect(client).not.toHaveProperty('arm');
    expect(client).not.toHaveProperty('disarm');
    expect(client).not.toHaveProperty('setMode');
    expect(client).not.toHaveProperty('land');
  });

  it('opens /api/v1/events with the same auth headers as other Companion calls', async () => {
    const encoder = new TextEncoder();
    const envelope = {
      api_version: '1',
      event: 'status',
      timestamp: { t_monotonic_ns: 1, t_utc_ns: null },
      payload: { timestamp: { t_monotonic_ns: 1, t_utc_ns: null }, system: { cpu_percent: 10 } },
    };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe('http://jetson:8472/api/v1/events');
      expect(init.headers.Accept).toBe('text/event-stream');
      expect(init.headers['X-Companion-Token']).toBe('tok');
      expect(init.headers.Authorization).toBe('Bearer tok');
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8472',
      fetchImpl,
      timeoutMs: 500,
      env: { COMPANION_SHARED_SECRET: 'tok' },
    });
    const events = [];
    const { done } = await client.openEventsStream({ onEvent: (e) => events.push(e) });
    await done;
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('status');
    expect(events[0].payload.system.cpu_percent).toBe(10);
  });

  it('rejects events stream 404 so the bridge can poll', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'nope' }, 404));
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8472',
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(client.openEventsStream({ onEvent: () => {} })).rejects.toMatchObject({
      kind: 'http',
      status: 404,
    });
  });

  it('rejects events stream 501 so the bridge can poll', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'not implemented' }, 501));
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8472',
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(client.openEventsStream({ onEvent: () => {} })).rejects.toMatchObject({
      kind: 'http',
      status: 501,
    });
  });

  it('rejects a JSON 200 on /events as an unsupported stream', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createCompanionApiClient({
      baseUrl: 'http://jetson:8472',
      fetchImpl,
      timeoutMs: 200,
    });
    await expect(client.openEventsStream({ onEvent: () => {} })).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});
