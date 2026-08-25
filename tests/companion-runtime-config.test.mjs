import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import {
  CONFIG_TIER,
  flattenCompanionConfig,
  buildRuntimeConfigPatch,
  sanitizeRuntimeConfigPatch,
} from '../lib/companion-display.mjs';
import {
  unwrapCompanionProxy,
  companionConfigFromProxyJson,
  policyDocumentFromProxyJson,
} from '../lib/companion-proxy-unwrap.mjs';
import { healthyCompanionConfig } from '../lib/companion-mock-fixtures.mjs';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { createCompanionService } from '../lib/companion-service.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { COMPANION_PROXY_PREFIX } from '../lib/companion-v1-paths.mjs';

describe('RUNTIME config flatten + patch helpers', () => {
  it('marks only RUNTIME leaf rows editable', () => {
    const rows = flattenCompanionConfig(healthyCompanionConfig());
    expect(rows.filter((r) => r.editable === true).every((r) => r.tier === CONFIG_TIER.RUNTIME)).toBe(true);
    expect(rows.find((r) => r.key === 'runtime.log_level')?.editable).toBe(true);
    expect(rows.find((r) => r.key === 'vision.default_source')?.editable).toBe(true);
    expect(rows.find((r) => r.key === 'flight_critical.precision_land')?.editable).toBe(false);
    expect(rows.find((r) => r.key === 'read_only.api_version')?.editable).toBe(false);
    expect(rows.find((r) => r.key === 'aruco.dictionary_name')?.editable).toBe(false);
  });

  it('buildRuntimeConfigPatch includes RUNTIME keys only', () => {
    const rows = flattenCompanionConfig(healthyCompanionConfig());
    const patch = buildRuntimeConfigPatch(rows, {
      'runtime.log_level': 'DEBUG',
      'runtime.vision_stale_timeout_s': '2.5',
      'vision.default_source': 'replay',
      'flight_critical.precision_land': 'armed',
      'read_only.api_version': '99',
      'aruco.dictionary_name': 'DICT_6X6_250',
    });
    expect(patch).toEqual({
      runtime: {
        log_level: 'DEBUG',
        vision_stale_timeout_s: 2.5,
      },
      vision: { default_source: 'replay' },
    });
    expect(patch.flight_critical).toBeUndefined();
    expect(patch.aruco).toBeUndefined();
    expect(patch.read_only).toBeUndefined();
  });

  it('buildRuntimeConfigPatch ignores FLIGHT_CRITICAL even if editable is tampered', () => {
    const rows = [
      { key: 'flight_critical.precision_land', value: 'not_exposed', tier: CONFIG_TIER.FLIGHT_CRITICAL, editable: true },
      { key: 'runtime.log_level', value: 'INFO', tier: CONFIG_TIER.RUNTIME, editable: true },
    ];
    const patch = buildRuntimeConfigPatch(rows, {
      'flight_critical.precision_land': 'armed',
      'runtime.log_level': 'ERROR',
    });
    expect(patch).toEqual({ runtime: { log_level: 'ERROR' } });
  });

  it('sanitizeRuntimeConfigPatch drops FLIGHT_CRITICAL groups', () => {
    expect(sanitizeRuntimeConfigPatch({
      runtime: { log_level: 'DEBUG' },
      flight_critical: { precision_land: 'armed' },
      vision: { default_source: 'csi' },
    })).toEqual({
      runtime: { log_level: 'DEBUG' },
      vision: { default_source: 'csi' },
    });
    expect(sanitizeRuntimeConfigPatch({
      log_level: 'INFO',
      flight_critical: { precision_land: 'armed' },
    })).toEqual({ log_level: 'INFO' });
  });
});

describe('config proxy envelope unwrap', () => {
  it('unwraps GET config from { ok, lane, data }', () => {
    const cfg = healthyCompanionConfig();
    const doc = companionConfigFromProxyJson({ ok: true, lane: 'NEW', data: cfg });
    expect(doc.runtime.log_level).toBe('INFO');
    expect(flattenCompanionConfig(doc).find((r) => r.key === 'runtime.log_level')?.editable).toBe(true);
  });

  it('passes through an already-unwrapped config document', () => {
    const cfg = healthyCompanionConfig();
    expect(companionConfigFromProxyJson(cfg)).toBe(cfg);
  });

  it('does not treat policy tokens as a config document', () => {
    expect(companionConfigFromProxyJson({ gcs_4g: { tokens: { VISION: 'denied' } } })).toBeNull();
    expect(policyDocumentFromProxyJson(healthyCompanionConfig())).toBeNull();
  });
});

describe('mock + proxy RUNTIME save-not-apply', () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerCompanionProxyApi(app, { companionService: createCompanionService({ COMPANION_MODE: 'mock' }) });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('PATCH /config/runtime is 200 with applied false', async () => {
    const res = await fetch(`${base}${COMPANION_PROXY_PREFIX}/config/runtime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime: { log_level: 'DEBUG' } }),
    });
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.lane).toBe('NEW');
    const data = unwrapCompanionProxy(envelope);
    expect(data.applied).toBe(false);
    expect(data.runtime.log_level).toBe('DEBUG');
  });

  it('GET /config envelope unwraps and reflects the runtime PATCH', async () => {
    await fetch(`${base}${COMPANION_PROXY_PREFIX}/config/runtime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: { min_detection_confidence: 0.7 },
        vision: { default_source: 'replay' },
      }),
    });
    const res = await fetch(`${base}${COMPANION_PROXY_PREFIX}/config`);
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.runtime).toBeUndefined();
    const cfg = companionConfigFromProxyJson(envelope);
    expect(cfg.runtime.min_detection_confidence).toBe(0.7);
    expect(cfg.vision.default_source).toBe('replay');
    const rows = flattenCompanionConfig(cfg);
    expect(rows.find((r) => r.key === 'runtime.min_detection_confidence')?.value).toBe(0.7);
    expect(rows.find((r) => r.key === 'vision.default_source')?.value).toBe('replay');
  });

  it('does not write FLIGHT_CRITICAL through the runtime PATCH', async () => {
    const before = companionConfigFromProxyJson(
      await fetch(`${base}${COMPANION_PROXY_PREFIX}/config`).then((r) => r.json()),
    );
    await fetch(`${base}${COMPANION_PROXY_PREFIX}/config/runtime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: { log_level: 'WARNING' },
        flight_critical: { precision_land: 'armed' },
      }),
    });
    const after = companionConfigFromProxyJson(
      await fetch(`${base}${COMPANION_PROXY_PREFIX}/config`).then((r) => r.json()),
    );
    expect(after.runtime.log_level).toBe('WARNING');
    expect(after.flight_critical).toEqual(before.flight_critical);
  });

  it('config apply/restart stay 404', async () => {
    for (const path of ['/config/apply', '/config/restart', '/config/runtime/apply', '/config/runtime/restart']) {
      const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}${path}`, { method: 'POST' });
      expect(r.status).toBe(404);
      const j = await r.json();
      expect(j.code).toBe('companion_forbidden');
    }
  });

  it('policy apply and ARM stay 404', async () => {
    const apply = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy/apply`, { method: 'POST' });
    const arm = await fetch(`${base}${COMPANION_PROXY_PREFIX}/arm`, { method: 'POST' });
    expect(apply.status).toBe(404);
    expect(arm.status).toBe(404);
  });
});

describe('mock client RUNTIME round-trip', () => {
  it('PATCH updates GET without applied true', async () => {
    const mock = createCompanionMock();
    const res = await mock.patchConfigRuntime({
      runtime: { log_level: 'ERROR' },
      vision: { default_source: 'synthetic' },
    });
    expect(res.applied).toBe(false);
    const cfg = await mock.getConfig();
    expect(cfg.runtime.log_level).toBe('ERROR');
    expect(cfg.vision.default_source).toBe('synthetic');
    expect(cfg.flight_critical.precision_land).toBe('not_exposed');
  });
});
