import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  POLICY_UI_STATES,
  POLICY_CHANNELS,
  POLICY_DIRECTIONS,
  CATEGORY_LABELS_HE,
  channelCategoryStates,
  buildChannelPolicyFromUi,
  buildPolicyFromUi,
  isPolicyDirty,
} from '../lib/companion-policy-state.mjs';
import {
  unwrapCompanionProxy,
  policyDocumentFromProxyJson,
} from '../lib/companion-proxy-unwrap.mjs';
import {
  MAVLINK_DISPLAY_CATEGORIES,
  policyTokenState,
  mapPolicyPreview,
} from '../lib/companion-display.mjs';
import {
  healthyPolicy,
  healthyPolicyPreview,
} from '../lib/companion-mock-fixtures.mjs';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import express from 'express';
import { createCompanionService } from '../lib/companion-service.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { COMPANION_PROXY_PREFIX } from '../lib/companion-v1-paths.mjs';

describe('companion-policy-state', () => {
  const policy = healthyPolicy();
  const gcs = policy.channels.gcs_4g;

  it('channelCategoryStates parses deny lists', () => {
    const states = channelCategoryStates(gcs);
    expect(states.length).toBe(MAVLINK_DISPLAY_CATEGORIES.length);
    const hb = states.find((s) => s.category === 'HEARTBEAT');
    expect(hb.denied).toBe(false);
    expect(hb.allowed).toBe(true);
    const vis = states.find((s) => s.category === 'VISION');
    expect(vis.denied).toBe(true);
    expect(vis.direction).toBe('BOTH');
  });

  it('channelCategoryStates handles deny_in / deny_out', () => {
    const ch = { deny: [], deny_in: ['GPS'], deny_out: ['BATTERY'], allow: [] };
    const states = channelCategoryStates(ch);
    expect(states.find((s) => s.category === 'GPS').direction).toBe('INBOUND');
    expect(states.find((s) => s.category === 'BATTERY').direction).toBe('OUTBOUND');
  });

  it('buildChannelPolicyFromUi round-trips', () => {
    const states = channelCategoryStates(gcs);
    const wire = buildChannelPolicyFromUi(states, gcs);
    expect(wire.deny.sort()).toEqual([...gcs.deny].sort());
    expect(wire.deny_in).toEqual(gcs.deny_in);
    expect(wire.deny_out).toEqual(gcs.deny_out);
  });

  it('buildPolicyFromUi produces full wire format', () => {
    const statesGcs = channelCategoryStates(gcs);
    const statesRfd = channelCategoryStates(policy.channels.rfd900x);
    const wire = buildPolicyFromUi(policy.version, { gcs_4g: statesGcs, rfd900x: statesRfd }, policy);
    expect(wire.version).toBe(1);
    expect(wire.channels.gcs_4g.deny.sort()).toEqual([...gcs.deny].sort());
  });

  it('isPolicyDirty detects changes', () => {
    expect(isPolicyDirty(policy, policy)).toBe(false);
    const mod = { ...policy, version: 99 };
    expect(isPolicyDirty(policy, mod)).toBe(true);
  });

  it('POLICY_CHANNELS has correct structure', () => {
    expect(POLICY_CHANNELS.gcs_4g.channelNum).toBe(3);
    expect(POLICY_CHANNELS.rfd900x.channelNum).toBe(2);
    expect(POLICY_CHANNELS.rfd900x.jetsonInPath).toBe(false);
  });

  it('POLICY_DIRECTIONS covers three options', () => {
    expect(Object.keys(POLICY_DIRECTIONS)).toEqual(['BOTH', 'INBOUND', 'OUTBOUND']);
  });

  it('CATEGORY_LABELS_HE has all categories', () => {
    for (const cat of MAVLINK_DISPLAY_CATEGORIES) {
      expect(CATEGORY_LABELS_HE[cat]).toBeTruthy();
    }
  });
});

describe('companion-display policy helpers', () => {
  it('policyTokenState returns denied for deny list', () => {
    const ch = { deny: ['GPS'], deny_in: [], deny_out: [], allow: [] };
    expect(policyTokenState(ch, 'GPS')).toBe('denied');
    expect(policyTokenState(ch, 'HEARTBEAT')).toBe('unspecified');
  });

  it('mapPolicyPreview maps channels', () => {
    const mapped = mapPolicyPreview(healthyPolicy());
    expect(mapped.gcs_4g.tokens.VISION).toBe('denied');
    expect(mapped.gcs_4g.tokens.HEARTBEAT).toBe('allowed');
    expect(mapped.applySupported).toBe(false);
  });
});

describe('mock policy round-trip', () => {
  it('PUT updates GET', async () => {
    const mock = createCompanionMock();
    const orig = await mock.getPolicy();
    expect(orig.channels.gcs_4g.deny).toContain('VISION');
    const modified = structuredClone(orig);
    modified.channels.gcs_4g.deny = ['HIGH_RATE'];
    await mock.putPolicy(modified);
    const after = await mock.getPolicy();
    expect(after.channels.gcs_4g.deny).toEqual(['HIGH_RATE']);
  });

  it('preview reflects current mock state', async () => {
    const mock = createCompanionMock();
    const modified = structuredClone(await mock.getPolicy());
    modified.channels.gcs_4g.deny = ['BATTERY'];
    await mock.putPolicy(modified);
    const prev = await mock.getPolicyPreview();
    expect(prev.snippet).toContain('BATTERY');
    expect(prev.applySupported).toBe(false);
    expect(prev.writes_etc).toBe(false);
  });

  it('apply route is forbidden in proxy', async () => {
    const app = express();
    app.use(express.json());
    registerCompanionProxyApi(app, { companionService: createCompanionService({ COMPANION_MODE: 'mock' }) });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      const r = await fetch(`http://127.0.0.1:${addr.port}${COMPANION_PROXY_PREFIX}/policy/apply`, { method: 'POST' });
      expect(r.status).toBe(404);
      const j = await r.json();
      expect(j.code).toBe('companion_forbidden');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('policy state transitions', () => {
  it('dirty detection works for edited states', () => {
    const orig = healthyPolicy();
    const same = structuredClone(orig);
    expect(isPolicyDirty(orig, same)).toBe(false);
    same.channels.gcs_4g.deny = [];
    expect(isPolicyDirty(orig, same)).toBe(true);
  });

  it('UI states are frozen', () => {
    expect(Object.isFrozen(POLICY_UI_STATES)).toBe(true);
    expect(POLICY_UI_STATES.SAVED_NOT_APPLIED).toBe('SAVED_NOT_APPLIED');
  });
});

describe('companion proxy envelope unwrap', () => {
  it('returns json.data when the NEW-lane envelope is present', () => {
    const doc = healthyPolicy();
    const unwrapped = unwrapCompanionProxy({ ok: true, lane: 'NEW', data: doc });
    expect(unwrapped).toBe(doc);
    expect(unwrapped.channels.gcs_4g.deny).toContain('VISION');
  });

  it('returns the same object when already unwrapped', () => {
    const doc = healthyPolicy();
    expect(unwrapCompanionProxy(doc)).toBe(doc);
  });

  it('policyDocumentFromProxyJson hydrates channels from the envelope', () => {
    const envelope = { ok: true, lane: 'NEW', data: healthyPolicy() };
    const doc = policyDocumentFromProxyJson(envelope);
    expect(doc.channels.gcs_4g).toBeTruthy();
    expect(doc.channels.rfd900x).toBeTruthy();
    const vis = channelCategoryStates(doc.channels.gcs_4g).find((s) => s.category === 'VISION');
    expect(vis.denied).toBe(true);
  });

  it('does not treat mapPolicyPreview tokens as a policy document', () => {
    const mapped = mapPolicyPreview(healthyPolicy());
    expect(mapped.gcs_4g.tokens.VISION).toBe('denied');
    expect(policyDocumentFromProxyJson(mapped)).toBeNull();
    expect(policyDocumentFromProxyJson({ ok: true, lane: 'NEW', data: mapped })).toBeNull();
  });

  it('unwraps policy preview snippet from the envelope', () => {
    const preview = healthyPolicyPreview();
    const data = unwrapCompanionProxy({ ok: true, lane: 'NEW', data: preview });
    expect(data.snippet).toContain('preview only');
    expect(data.applySupported).toBe(false);
  });
});

describe('policy editor GET/PUT round-trip through proxy envelope', () => {
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

  it('GET envelope unwraps to channels the editor can render', async () => {
    const res = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy`);
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.lane).toBe('NEW');
    expect(envelope.channels).toBeUndefined();
    const doc = policyDocumentFromProxyJson(envelope);
    expect(doc.channels.gcs_4g.deny).toContain('VISION');
    const states = channelCategoryStates(doc.channels.gcs_4g);
    expect(states.find((s) => s.category === 'VISION').denied).toBe(true);
    expect(states.find((s) => s.category === 'HEARTBEAT').denied).toBe(false);
  });

  it('PUT is 200 and GET rehydrate still sees channels', async () => {
    const before = policyDocumentFromProxyJson(
      await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy`).then((r) => r.json()),
    );
    const next = structuredClone(before);
    next.channels.gcs_4g.deny = ['HIGH_RATE'];
    const put = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.ok).toBe(true);
    expect(unwrapCompanionProxy(putBody).applied).toBe(false);

    const after = policyDocumentFromProxyJson(
      await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy`).then((r) => r.json()),
    );
    expect(after.channels.gcs_4g.deny).toEqual(['HIGH_RATE']);
    const states = channelCategoryStates(after.channels.gcs_4g);
    expect(states.find((s) => s.category === 'HIGH_RATE').denied).toBe(true);
    expect(after.channels.gcs_4g.deny).not.toContain('VISION');
  });

  it('POST /policy/apply stays 404', async () => {
    const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}/policy/apply`, { method: 'POST' });
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.code).toBe('companion_forbidden');
  });
});
