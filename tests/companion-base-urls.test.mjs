import { describe, expect, it, vi } from 'vitest';
import {
  createCompanionApiClient,
  parseCompanionBaseUrls,
  resolveCompanionBaseUrlList,
  resolveCompanionV1BaseUrl,
} from '../lib/companion-api-client.mjs';
import { resolveCompanionMode } from '../lib/companion-service.mjs';
import { companionLinkLabelHe, validateCompanionBaseUrl } from '../lib/companion-connection.mjs';
import { relayHostFromCompanionBaseUrl } from '../lib/jetson-companion-proxy.mjs';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('companion base URL fallback', () => {
  it('keeps the BOTH gate on the first address and tries the list in order', async () => {
    const list = 'http://192.168.1.122:8081, http://100.82.59.45:8081';
    expect(parseCompanionBaseUrls(list)).toEqual([
      'http://192.168.1.122:8081',
      'http://100.82.59.45:8081',
    ]);
    expect(resolveCompanionV1BaseUrl({ JETSON_COMPANION_BASE_URL: list })).toBe('http://192.168.1.122:8081');
    expect(resolveCompanionMode({ JETSON_COMPANION_BASE_URL: list })).toBe('off');
    expect(resolveCompanionMode({
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: list,
    })).toBe('real');
    expect(resolveCompanionMode({ COMPANION_MODE: 'real', JETSON_COMPANION_BASE_URL: '' })).toBe('off');

    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('http://192.168.1.122:8081')) {
        await new Promise((resolve, reject) => {
          const fail = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      return jsonResponse({ ok: true, api_version: '1' });
    });

    const client = createCompanionApiClient({
      baseUrl: list,
      fetchImpl,
      timeoutMs: 400,
      failoverTimeoutMs: 40,
    });
    const picked = await client.selectWorkingBaseUrl();
    expect(picked).toBe('http://100.82.59.45:8081');
    expect(client.baseUrl).toBe('http://100.82.59.45:8081');
    const health = await client.getHealth();
    expect(health.ok).toBe(true);
    expect(calls.filter((u) => u.startsWith('http://192.168.1.122:8081')).length).toBe(1);
    expect(calls.filter((u) => u.startsWith('http://100.82.59.45:8081')).length).toBeGreaterThanOrEqual(2);
    expect(companionLinkLabelHe(client.baseUrl)).toBe('Tailscale');
    expect(companionLinkLabelHe('http://192.168.1.122:8081')).toBe('רשת בית');
    expect(validateCompanionBaseUrl(list).ok).toBe(true);
    expect(relayHostFromCompanionBaseUrl(list)).toBe('192.168.1.122');
  });

  it('prefers JETSON_COMPANION_BASE_URLS and still requires COMPANION_MODE=real', () => {
    const urls = 'http://192.168.1.122:8081,http://100.82.59.45:8081';
    expect(resolveCompanionBaseUrlList({
      JETSON_COMPANION_BASE_URLS: urls,
      JETSON_COMPANION_BASE_URL: 'http://10.0.0.9:8081',
    })).toEqual([
      'http://192.168.1.122:8081',
      'http://100.82.59.45:8081',
      'http://10.0.0.9:8081',
    ]);
    expect(resolveCompanionMode({
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: '',
      JETSON_COMPANION_BASE_URLS: urls,
    })).toBe('real');
    expect(resolveCompanionMode({
      JETSON_COMPANION_BASE_URLS: urls,
    })).toBe('off');
    expect(resolveCompanionMode({
      COMPANION_MODE: 'real',
      JETSON_COMPANION_BASE_URL: '',
      JETSON_COMPANION_BASE_URLS: '',
    })).toBe('off');
  });
});
