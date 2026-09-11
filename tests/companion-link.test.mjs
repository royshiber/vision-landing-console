import { describe, it, expect } from 'vitest';
import {
  mapHealthFields,
  summarizeCompanionLink,
  composeConnectPill,
  hebrewCompanionPill,
  hebrewJetsonState,
  hebrewFcState,
  chipStateFromCompanion,
} from '../lib/companion-link.mjs';
import { DEFAULT_COMPANION_BASE_URL, resolveCompanionConnectDefaults } from '../lib/companion-connection.mjs';
import { normalizeCompanionSecret, readCompanionTokenFromEnv } from '../lib/companion-secret.mjs';
import { createCompanionMock } from '../lib/companion-mock.mjs';

describe('companion health → Jetson / FC mapping', () => {
  it('prefers fc_linked / fc_heartbeat from Companion /api/health', () => {
    const fields = mapHealthFields(
      { fc_linked: true, fc_heartbeat: true },
      { fc: { connected: false, heartbeat: false } },
    );
    expect(fields).toEqual({ fc_linked: true, fc_heartbeat: true });
  });

  it('falls back to overlay FC / MAVLink when health omits the fields', () => {
    const fields = mapHealthFields(
      { ok: true },
      { fc: { connected: true, heartbeat: false }, mavlink: { heartbeat_ok: false } },
    );
    expect(fields.fc_linked).toBe(true);
    expect(fields.fc_heartbeat).toBe(false);
  });

  it('maps reachable + heartbeat as a live GCS-style link', () => {
    const live = summarizeCompanionLink({
      mode: 'real',
      reachable: true,
      health: { fc_linked: true, fc_heartbeat: true },
      defaultConfigured: true,
    });
    expect(live.jetson).toBe('reachable');
    expect(live.jetsonLabelHe).toBe('מחשב משימה');
    expect(live.jetsonStatusHe).toBe('מחובר');
    expect(live.fc).toBe('heartbeat');
    expect(live.fcLabelHe).toBe('בקר טיסה');
    expect(live.fcStatusHe).toBe('דופק חי');
    expect(live.pillLabelHe).toBe('מחובר · בקר טיסה');
    expect(live.pillDot).toBe('on');
    expect(live.connectAvailable).toBe(false);
  });

  it('does not feel totally disconnected when Jetson is up and radio MAVLink is down', () => {
    const jetsonOnly = summarizeCompanionLink({
      mode: 'real',
      reachable: true,
      health: { fc_linked: false, fc_heartbeat: false },
    });
    expect(jetsonOnly.pillLabelHe).toBe('מחובר · מחשב משימה');
    expect(jetsonOnly.pillDot).toBe('warn');
    expect(jetsonOnly.fc).toBe('unlinked');
    expect(jetsonOnly.fcStatusHe).toBe('מנותק');

    const composed = composeConnectPill({
      dual: { radio: 'disconnected', cellular: 'modem_absent', pillLabelHe: 'מנותק' },
      companion: jetsonOnly,
    });
    expect(composed.pillLabelHe).not.toBe('מנותק');
    expect(composed.pillLabelHe).toBe('מחובר · מחשב משימה');
  });

  it('keeps dual-link radio/cellular labels when those sockets are up', () => {
    const companion = summarizeCompanionLink({
      mode: 'real',
      reachable: true,
      health: { fc_linked: true, fc_heartbeat: true },
    });
    const composed = composeConnectPill({
      dual: {
        radio: 'connected',
        cellular: 'disconnected',
        pillLabelHe: 'מחובר · טלמטריה רגילה',
      },
      companion,
    });
    expect(composed.pillLabelHe).toBe('מחובר · טלמטריה רגילה');
    expect(composed.pillDot).toBe('on');
  });

  it('uses Hebrew chip labels and never מסייע', () => {
    expect(hebrewJetsonState('unreachable')).toBe('לא מגיב');
    expect(hebrewFcState('linked')).toBe('מקושר');
    expect(hebrewCompanionPill({ jetson: 'unreachable' })).toBe('מחשב משימה לא מגיב');
    expect(chipStateFromCompanion('fc', 'heartbeat')).toBe('on');
    expect(`${hebrewJetsonState('off')} ${hebrewFcState('heartbeat')}`).not.toMatch(/מסייע/);
  });
});

describe('one-Jetson connect defaults', () => {
  it('takes stored URL+token, else env Tailscale, else the baked product URL', () => {
    const envOnly = resolveCompanionConnectDefaults({
      stored: { connected: false },
      env: {
        JETSON_COMPANION_BASE_URL: 'http://jetson.ts:8081',
        JETSON_COMPANION_TOKEN: 'env-token-aaaa',
      },
    });
    expect(envOnly.configured).toBe(true);
    expect(envOnly.source).toBe('env');
    expect(envOnly.url).toBe('http://jetson.ts:8081');

    const urlAlone = resolveCompanionConnectDefaults({
      env: { JETSON_COMPANION_BASE_URL: 'http://jetson.ts:8081' },
    });
    expect(urlAlone.configured).toBe(false);
    expect(urlAlone.urlConfigured).toBe(true);
    expect(urlAlone.tokenConfigured).toBe(false);

    const baked = resolveCompanionConnectDefaults({ stored: { connected: false }, env: {} });
    expect(baked.url).toBe(DEFAULT_COMPANION_BASE_URL);
    expect(baked.source).toBe('builtin');
    expect(baked.urlConfigured).toBe(true);
    expect(baked.tokenConfigured).toBe(false);
    expect(baked.configured).toBe(false);
  });

  it('strips surrounding quotes from VLC_COMPANION_TOKEN export lines', () => {
    const fortyEight = 'abcdefghijabcdefghijabcdefghijabcdefghijabcdefgh';
    expect(fortyEight).toHaveLength(48);
    expect(`'${fortyEight}'`).toHaveLength(50);
    expect(normalizeCompanionSecret(`'${fortyEight}'`)).toBe(fortyEight);
    expect(normalizeCompanionSecret(`"${fortyEight}"`)).toBe(fortyEight);
    expect(normalizeCompanionSecret(`  "${fortyEight}"  `)).toBe(fortyEight);
    expect(readCompanionTokenFromEnv({
      VLC_COMPANION_TOKEN: `'${fortyEight}'`,
    })).toBe(fortyEight);
    expect(readCompanionTokenFromEnv({
      VLC_COMPANION_TOKEN: `'${fortyEight}'`,
    })).toHaveLength(48);

    const quoted = resolveCompanionConnectDefaults({
      stored: { connected: false },
      env: { VLC_COMPANION_TOKEN: `'${fortyEight}'` },
    });
    expect(quoted.configured).toBe(true);
    expect(quoted.token).toBe(fortyEight);
    expect(quoted.token).toHaveLength(48);
    expect(quoted.url).toBe(DEFAULT_COMPANION_BASE_URL);
    expect(quoted.source).toBe('builtin');
  });

  it('keeps one-click ready when baked URL plus env token exist', () => {
    const ready = summarizeCompanionLink({
      mode: 'off',
      reachable: false,
      defaultConfigured: true,
      urlConfigured: true,
      tokenConfigured: true,
    });
    expect(ready.needAdvanced).toBe(false);
    expect(ready.connectAvailable).toBe(true);
    expect(ready.needToken).toBe(false);
    expect(ready.connected).toBe(false);
  });

  it('asks for a token, not an address, when the baked URL exists without a token', () => {
    const missing = summarizeCompanionLink({
      mode: 'off',
      reachable: false,
      defaultConfigured: false,
      urlConfigured: true,
      tokenConfigured: false,
    });
    expect(missing.needToken).toBe(true);
    expect(missing.focusField).toBe('token');
    expect(missing.connected).toBe(false);
    expect(missing.hint_he).toMatch(/אסימון/);
    expect(missing.hint_he).not.toMatch(/חסרה כתובת/);
    expect(missing.jetsonStatusHe).not.toBe('מחובר');
  });
});

describe('mock Companion health wire', () => {
  it('exposes fc_linked / fc_heartbeat on GET health for each scenario', async () => {
    const healthy = createCompanionMock({ scenario: 'healthy' });
    const h = await healthy.getHealth();
    expect(h.fc_linked).toBe(true);
    expect(h.fc_heartbeat).toBe(true);

    const down = createCompanionMock({ scenario: 'disconnected' });
    const d = await down.getHealth();
    expect(d.fc_linked).toBe(false);
    expect(d.fc_heartbeat).toBe(false);

    const degraded = createCompanionMock({ scenario: 'degraded' });
    const g = await degraded.getHealth();
    expect(g.fc_heartbeat).toBe(false);
  });
});
