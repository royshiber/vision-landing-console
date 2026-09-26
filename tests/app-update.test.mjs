import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';
import {
  assessUpdateSafety,
  buildUpdaterLaunch,
  compareVersions,
  createAppUpdateService,
  isLoopbackRequest,
  isNewerVersion,
  parseVersionPayload,
} from '../lib/app-update.mjs';
import { registerAppUpdateApi } from '../lib/routes/app-update-api.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('version comparison', () => {
  it('orders dotted numeric segments', () => {
    expect(compareVersions('1.02.329', '1.02.330')).toBe(-1);
    expect(compareVersions('1.02.330', '1.02.329')).toBe(1);
    expect(compareVersions('1.02.329', '1.02.329')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.02.10', '1.02.9')).toBe(1);
    expect(isNewerVersion('1.02.331', '1.02.329')).toBe(true);
    expect(isNewerVersion('1.02.329', '1.02.331')).toBe(false);
    expect(parseVersionPayload('{"version":"1.02.332"}')).toBe('1.02.332');
    expect(parseVersionPayload("export const APP_VERSION = '1.02.329';")).toBe('1.02.329');
  });
});

describe('update flight gate', () => {
  it('blocks armed and in-flight, and asks again when a connected vehicle has no arm state', () => {
    expect(assessUpdateSafety(null).allowed).toBe(true);
    expect(assessUpdateSafety({ connected: true, lastBaseMode: 0x80 }).blockedReason).toBe('armed');
    expect(assessUpdateSafety({
      connected: true,
      lastBaseMode: 0x01,
      lastGlobalPos: { relativeAltM: 8 },
    }).blockedReason).toBe('in_flight');
    const unknown = assessUpdateSafety({ connected: true });
    expect(unknown.blockedReason).toBe('unknown_connected');
    expect(unknown.needsConfirmation).toBe(true);
    expect(assessUpdateSafety({ connected: true }, { confirmUnknown: true }).allowed).toBe(true);
    expect(assessUpdateSafety({ connected: true, lastBaseMode: 0x01, lastGlobalPos: { relativeAltM: 0.2 } }).allowed).toBe(true);
  });
});

describe('update status and apply', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'airvix-update-'));

  function service(extra = {}) {
    const spawnImpl = vi.fn(() => ({ pid: 4242, unref() {} }));
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('version.json')) {
        return new Response(JSON.stringify({ version: '1.02.400' }), { status: 200 });
      }
      if (u.includes('commits')) {
        return new Response(JSON.stringify([
          { commit: { message: 'feat: newer console\nbody' } },
          { commit: { message: 'land 1.02.329\n' } },
        ]), { status: 200 });
      }
      return new Response('missing', { status: 404 });
    });
    const svc = createAppUpdateService({
      appRoot: path.resolve('.'),
      getCurrentVersion: () => '1.02.329',
      fetchImpl,
      spawnImpl,
      platform: 'linux',
      logPath: path.join(tmp, 'update.log'),
      statusPath: path.join(tmp, 'status.json'),
      ignorePreview: true,
      ...extra,
    });
    return { svc, spawnImpl, fetchImpl };
  }

  it('reports a newer version and changelog subjects after the installed one', async () => {
    const { svc } = service();
    const status = await svc.status({ refresh: true, mavConn: null });
    expect(status.current).toBe('1.02.329');
    expect(status.latest).toBe('1.02.400');
    expect(status.available).toBe(true);
    expect(status.lastChecked).toEqual(expect.any(String));
    expect(status.changelog).toEqual(['feat: newer console']);
    expect(status.error).toBe(null);
  });

  it('stays quiet when the version check has no network', async () => {
    const { svc } = service({
      fetchImpl: vi.fn(async () => { throw new Error('offline'); }),
    });
    const status = await svc.check();
    expect(status.error).toBe('offline');
    expect(status.available).toBe(false);
    expect(status.latest).toBe(null);
  });

  it('refuses apply while armed and does not spawn', async () => {
    const { svc, spawnImpl } = service();
    const armed = { connected: true, lastBaseMode: 0x80 };
    const blocked = await svc.apply({ mavConn: armed });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(409);
    expect(blocked.blockedReason).toBe('armed');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('requires a second confirmation when arm state is unknown on a connected vehicle', async () => {
    const { svc, spawnImpl } = service();
    const connected = { connected: true };
    const first = await svc.apply({ mavConn: connected });
    expect(first.blockedReason).toBe('unknown_connected');
    expect(first.needsConfirmation).toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();
    const second = await svc.apply({ mavConn: connected, confirmUnknown: true });
    expect(second.ok).toBe(true);
    expect(second.status).toBe(202);
    expect(spawnImpl).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnImpl.mock.calls[0];
    expect(cmd).toBe('bash');
    expect(args[0]).toContain('update-airvix.sh');
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
  });

  it('serves status and blocks apply over the HTTP route', async () => {
    const { svc } = service();
    let mav = null;
    const app = express();
    app.use(express.json());
    registerAppUpdateApi(app, { updateService: svc, getMavConn: () => mav });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const idle = await fetch(`${base}/api/v1/update/status`).then((r) => r.json());
      expect(idle.current).toBe('1.02.329');
      expect(idle.available).toBe(false);
      const fresh = await fetch(`${base}/api/v1/update/status?refresh=1`).then((r) => r.json());
      expect(fresh.available).toBe(true);
      expect(fresh.latest).toBe('1.02.400');
      mav = { connected: true, lastBaseMode: 0x80 };
      const blocked = await fetch(`${base}/api/v1/update/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(blocked.status).toBe(409);
      const body = await blocked.json();
      expect(body.blockedReason).toBe('armed');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('treats only loopback sockets as allowed to apply', () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.20' } })).toBe(false);
  });

  it('launches the in-repo updater hidden on Windows', () => {
    const launch = buildUpdaterLaunch({
      platform: 'win32',
      appRoot: '/app',
      logPath: path.join(tmp, 'win.log'),
      statusPath: path.join(tmp, 'win.json'),
    });
    expect(launch.script).toBe(path.join('/app', 'scripts', 'windows', 'install-airvix.ps1'));
    expect(launch.args).toContain('-UpdateOnly');
    expect(launch.args).toContain('-WindowStyle');
    expect(launch.args).toContain('Hidden');
  });
});
