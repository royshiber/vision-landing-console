import { describe, expect, it } from 'vitest';
import { UPLINK_PATH_LOCK_HE } from '../lib/comm-links.mjs';
import { setCompanionUplink } from '../lib/dual-link-runtime.mjs';

function controlCtx(client, calls) {
  return {
    networkUplinks: {
      wifi: { enabled: true, up: true },
      cellular: { enabled: true, up: true },
    },
    companionService: {
      client,
      getSseOverlay: () => ({ companion: { health: { capabilities: { uplinkControl: true } } } }),
    },
    setNetworkUplink: async (which, body) => {
      calls.push({ which, enabled: body?.enabled });
      return { wifi: { enabled: true }, cellular: { enabled: true } };
    },
  };
}

describe('companion path lock', () => {
  it('refuses to disable the live path until another path answers', async () => {
    const calls = [];
    const snap = {
      activeId: 'home',
      paths: [
        { id: 'home', url: 'http://192.168.1.122:8081', ok: true },
        { id: 'cellular', url: 'http://100.82.59.45:8081', ok: false },
      ],
    };
    const refused = await setCompanionUplink(controlCtx({
      refreshCompanionPaths: async () => snap,
    }, calls), { role: 'home', enabled: false });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(409);
    expect(refused.reason).toBe('path_lock');
    expect(refused.messageHe).toBe(UPLINK_PATH_LOCK_HE);
    expect(refused.messageHe).not.toMatch(/\.env|docs\//);
    expect(calls).toEqual([]);
  });

  it('allows the cut once another path is live', async () => {
    const calls = [];
    const snap = {
      activeId: 'home',
      paths: [
        { id: 'home', url: 'http://192.168.1.122:8081', ok: true },
        { id: 'cellular', url: 'http://100.82.59.45:8081', ok: true },
      ],
    };
    const allowed = await setCompanionUplink(controlCtx({
      refreshCompanionPaths: async () => snap,
    }, calls), { role: 'wifi', enabled: false });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual([{ which: 'wifi', enabled: false }]);
  });

  it('still posts when the client cannot probe paths', async () => {
    const calls = [];
    const posted = await setCompanionUplink(controlCtx(null, calls), { role: 'home', enabled: false });
    expect(posted.ok).toBe(true);
    expect(calls).toEqual([{ which: 'wifi', enabled: false }]);
  });
});
