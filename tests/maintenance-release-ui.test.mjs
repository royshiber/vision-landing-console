import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { createCompanionService } from '../lib/companion-service.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { COMPANION_PROXY_PREFIX, COMPANION_V1_PATHS, COMPANION_READ_METHODS, COMPANION_WRITE_METHODS } from '../lib/companion-v1-paths.mjs';
import {
  buildDeployPayload,
  sanitizeDeployPayload,
  formatActivationMessage,
  evaluateDeployOutcome,
  mapReleaseInventoryForUi,
  mapBackupsForUi,
  mapAuditForUi,
  isDeployableReleaseStatus,
  FORBIDDEN_DEPLOY_BODY_KEYS,
  formatMaintenanceApiError,
} from '../lib/companion-release-mgmt.mjs';
import { releaseInventoryForScenario, MOCK_RELEASE_CATALOG } from '../lib/companion-mock-fixtures.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Release management paths (C8.2)', () => {
  it('registers read and write maintenance release paths', async () => {
    expect(COMPANION_V1_PATHS.maintenanceReleases).toBe('/api/v1/maintenance/releases');
    expect(COMPANION_V1_PATHS.maintenanceBackup).toBe('/api/v1/maintenance/backup');
    expect(COMPANION_V1_PATHS.maintenanceDeploy).toBe('/api/v1/maintenance/deploy');
    expect(COMPANION_V1_PATHS.maintenanceRollback).toBe('/api/v1/maintenance/rollback');
    expect(COMPANION_READ_METHODS).toContain('getMaintenanceReleases');
    expect(COMPANION_WRITE_METHODS).toContain('postMaintenanceDeploy');
  });
});

describe('Deploy payload safety', () => {
  it('buildDeployPayload contains ONLY release_id', () => {
    expect(buildDeployPayload('rel-verified-003')).toEqual({ release_id: 'rel-verified-003' });
  });

  it('rejects forbidden path/url/command fields', () => {
    for (const key of ['path', 'url', 'command', 'shell']) {
      expect(() => sanitizeDeployPayload({ release_id: 'x', [key]: '/tmp/evil' })).toThrow(/only release_id|forbidden/);
    }
  });

  it('rejects extra keys beyond release_id', () => {
    expect(() => sanitizeDeployPayload({ release_id: 'x', version: '1.0' })).toThrow(/only release_id/);
  });

  it('documents forbidden keys list', () => {
    expect(FORBIDDEN_DEPLOY_BODY_KEYS).toContain('artifact_url');
    expect(FORBIDDEN_DEPLOY_BODY_KEYS).toContain('sudo');
  });
});

describe('Release inventory mapping', () => {
  it('maps active, previous, and available releases', () => {
    const inv = releaseInventoryForScenario('healthy');
    const ui = mapReleaseInventoryForUi(inv);
    expect(ui.active.releaseId).toBe('rel-active-001');
    expect(ui.previous.releaseId).toBe('rel-prev-002');
    expect(ui.available.length).toBe(MOCK_RELEASE_CATALOG.length);
    expect(ui.canRollback).toBe(true);
    expect(ui.available.find((r) => r.releaseId === 'rel-verified-003')?.deployable).toBe(true);
  });

  it('marks VERIFIED and AVAILABLE as deployable', () => {
    expect(isDeployableReleaseStatus('VERIFIED')).toBe(true);
    expect(isDeployableReleaseStatus('AVAILABLE')).toBe(true);
    expect(isDeployableReleaseStatus('FAILED')).toBe(false);
  });
});

describe('Deploy outcome messaging', () => {
  it('does NOT claim success without runtime proof', () => {
    const msg = formatActivationMessage({
      state: 'FAILED',
      running_process_changed: false,
      failure_reason: 'health failed',
    });
    expect(msg).toContain('failed');
  });

  it('evaluates strict success contract', () => {
    const out = evaluateDeployOutcome({
      state: 'SUCCEEDED',
      release_id: 'rel-verified-003',
      running_process_changed: true,
      running_version: '2.0.0',
      active_release: { version: '2.0.0' },
      health_check_ok: true,
    }, 'rel-verified-003');
    expect(out.ok).toBe(true);
    expect(out.message).toContain('successful');
  });

  it('evaluates rolled-back deploy as failure', () => {
    const out = evaluateDeployOutcome({
      state: 'ROLLED_BACK',
      running_version: '1.9.0',
      failure_reason: 'health check failed',
    }, 'rel-verified-003');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('restored');
  });

  it('fails strict success when version mismatch', () => {
    const out = evaluateDeployOutcome({
      state: 'SUCCEEDED',
      release_id: 'rel-verified-003',
      running_process_changed: true,
      running_version: '1.0.0',
      active_release: { version: '2.0.0' },
      health_check_ok: true,
    }, 'rel-verified-003');
    expect(out.ok).toBe(false);
  });

  it('allows running label only when changed=true', () => {
    const msg = formatActivationMessage({
      state: 'SUCCEEDED',
      running_process_changed: true,
      active_release: { version: '2.0.0' },
    });
    expect(msg).toContain('successful');
  });

  it('uses server message when provided', () => {
    expect(formatActivationMessage({ message: 'Custom Jetson message' })).toBe('Custom Jetson message');
  });
});

describe('Mock release management', () => {
  let mock;
  beforeEach(() => {
    mock = createCompanionMock({ scenario: 'healthy' });
  });

  it('returns release inventory in healthy mock', async () => {
    const inv = await mock.getMaintenanceReleases();
    expect(inv.active.release_id).toBe('rel-active-001');
    expect(inv.available.some((r) => r.status === 'VERIFIED')).toBe(true);
  });

  it('backup success returns backup_id (MOCK)', async () => {
    const res = await mock.postMaintenanceBackup();
    expect(res.mock).toBe(true);
    expect(res.backup_id).toMatch(/^bk-mock-/);
    const backups = await mock.getMaintenanceBackups();
    expect(backups.backups.some((b) => b.backup_id === res.backup_id)).toBe(true);
  });

  it('deploy sends ONLY release_id and returns SUCCEEDED in healthy', async () => {
    const payload = sanitizeDeployPayload({ release_id: 'rel-verified-003' });
    expect(Object.keys(payload)).toEqual(['release_id']);
    const res = await mock.postMaintenanceDeploy(payload);
    expect(res.mock).toBe(true);
    expect(res.state).toBe('SUCCEEDED');
    expect(res.running_process_changed).toBe(true);
    expect(res.running_version).toBe(res.active_release.version);
  });

  it('deploy rejects non-deployable release', async () => {
    await expect(mock.postMaintenanceDeploy({ release_id: 'rel-failed-005' })).rejects.toMatchObject({ status: 400 });
  });

  it('rollback returns success state in healthy', async () => {
    const res = await mock.postMaintenanceRollback();
    expect(res.state).toBe('SUCCEEDED');
    expect(res.running_process_changed).toBe(true);
  });

  it('disconnected mock is unavailable — no fabricated inventory', async () => {
    mock.setScenario('disconnected');
    await expect(mock.getMaintenanceReleases()).rejects.toMatchObject({ kind: 'connection' });
  });

  it('degraded mock backup returns 409 conflict', async () => {
    mock.setScenario('degraded');
    await expect(mock.postMaintenanceBackup()).rejects.toMatchObject({ status: 409 });
  });

  it('degraded mock deploy returns 409 conflict', async () => {
    mock.setScenario('degraded');
    await expect(mock.postMaintenanceDeploy({ release_id: 'rel-verified-003' })).rejects.toMatchObject({ status: 409 });
  });

  it('degraded mock rollback returns unsupported/failure', async () => {
    mock.setScenario('degraded');
    await expect(mock.postMaintenanceRollback()).rejects.toMatchObject({ status: 501 });
  });

  it('audit fixtures map without path fields', async () => {
    const mock = createCompanionMock();
    const audit = mapAuditForUi(await mock.getMaintenanceAudit());
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).not.toHaveProperty('path');
  });
});

describe('Proxy integration — release routes', () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {string} */
  let base;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    const companionService = createCompanionService({ COMPANION_MODE: 'mock' });
    registerCompanionProxyApi(app, { companionService });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('proxies GET releases, backups, audit', async () => {
    const rel = await fetch(`${base}${COMPANION_PROXY_PREFIX}/maintenance/releases`).then((r) => r.json());
    const bk = await fetch(`${base}${COMPANION_PROXY_PREFIX}/maintenance/backups`).then((r) => r.json());
    const audit = await fetch(`${base}${COMPANION_PROXY_PREFIX}/maintenance/audit`).then((r) => r.json());
    expect(rel.ok && bk.ok && audit.ok).toBe(true);
    expect(rel.data.active.release_id).toBeTruthy();
    expect(Array.isArray(bk.data.backups)).toBe(true);
    expect(Array.isArray(audit.data.entries)).toBe(true);
  });

  it('POST deploy body is sanitized to release_id only', async () => {
    const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}/maintenance/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_id: 'rel-verified-003', path: '/etc/evil' }),
    });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
  });

  it('POST deploy success via proxy', async () => {
    const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}/maintenance/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_id: 'rel-verified-003' }),
    });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.state).toBe('SUCCEEDED');
  });

  it('returns structured error for 409 deploy conflict in degraded scenario', async () => {
    await fetch(`${base}${COMPANION_PROXY_PREFIX}/_console/mock-scenario`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'degraded' }),
    });
    const r = await fetch(`${base}${COMPANION_PROXY_PREFIX}/maintenance/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ release_id: 'rel-verified-003' }),
    });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.message).toMatch(/conflict|failed/i);
    await fetch(`${base}${COMPANION_PROXY_PREFIX}/_console/mock-scenario`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'healthy' }),
    });
  });

  it('503 when companion is off — real unavailable', async () => {
    const app = express();
    app.use(express.json());
    registerCompanionProxyApi(app, { companionService: createCompanionService({ COMPANION_MODE: 'off' }) });
    const s = await listen(app);
    try {
      const addr = s.address();
      const r = await fetch(`http://127.0.0.1:${addr.port}${COMPANION_PROXY_PREFIX}/maintenance/releases`);
      expect(r.status).toBe(503);
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });
});

describe('Human-readable API errors', () => {
  it('maps HTTP status codes', () => {
    expect(formatMaintenanceApiError(403, { message: 'denied' })).toBe('denied');
    expect(formatMaintenanceApiError(409, {})).toMatch(/קונפליקט/);
    expect(formatMaintenanceApiError(501, {})).toMatch(/נתמך/);
  });
});

describe('Backups and audit UI mapping', () => {
  it('maps backups without filesystem paths', () => {
    const ui = mapBackupsForUi({
      backups: [{ backup_id: 'bk-1', created_at: '2026-01-01T00:00:00Z', release_id: 'rel-1', sha256: 'abc' }],
    });
    expect(ui[0].backupId).toBe('bk-1');
    expect(ui[0]).not.toHaveProperty('path');
  });
});
