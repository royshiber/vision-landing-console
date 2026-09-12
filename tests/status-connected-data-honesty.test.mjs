import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  companionHasDataPath,
  composeConnectPill,
  hebrewJetsonState,
  hebrewFcState,
  summarizeCompanionLink,
} from '../lib/companion-link.mjs';
import {
  DEFAULT_COMPANION_CONNECT_URL,
  resolveCompanionConnectDefaults,
  stripWrappedQuotes,
} from '../lib/companion-connection.mjs';
import { companionAuthHeaders } from '../lib/companion-api-client.mjs';
import { mapCompanionStatus } from '../lib/companion-status.mjs';
import { healthyCompanionStatus } from '../lib/companion-mock-fixtures.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function loadUiHonesty() {
  const src = [
    sliceFunction(js, 'pulseCompanionLabel'),
    sliceFunction(js, 'companionFiniteMetric'),
    sliceFunction(js, 'pulseJetsonSystemMetrics'),
    sliceFunction(js, 'pulseMavlinkLive'),
    sliceFunction(js, 'companionHasDataPathClient'),
    sliceFunction(js, 'pulseFcObject'),
    sliceFunction(js, 'pulseCompanionFcLink'),
    sliceFunction(js, 'pulseResolveFcHonesty'),
    sliceFunction(js, 'pulseResolveComputerHonesty'),
    sliceFunction(js, 'companionIsLive'),
    sliceFunction(js, 'formatComputerMetric'),
    sliceFunction(js, 'pulseComputerMetricValue'),
    'return { pulseCompanionLabel, companionHasDataPathClient, pulseFcObject, pulseCompanionFcLink, pulseResolveFcHonesty, pulseResolveComputerHonesty, companionIsLive, formatComputerMetric, pulseComputerMetricValue };',
  ].join('\n');
  return new Function(src)();
}

describe('Status connected ⇔ data honesty', () => {
  it('pins APP_VERSION at 1.02.303 after Status FC honesty', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.303'");
    expect(pkg.version).toBe('1.02.303');
    expect(changelog).toContain('"version": "1.02.293"');
  });

  it('never labels Jetson מחובר when unreachable', () => {
    const dead = summarizeCompanionLink({
      mode: 'real',
      reachable: false,
      health: { fc_linked: true, fc_heartbeat: true },
    });
    expect(dead.jetson).toBe('unreachable');
    expect(dead.jetsonStatusHe).toBe('לא מגיב');
    expect(dead.connected).toBe(false);
    expect(dead.hasData).toBe(false);
    expect(dead.pillLabelHe).toBe('מחשב משימה לא מגיב');
    expect(dead.pillDot).toBe('err');
    expect(dead.fcStatusHe).toBe('מנותק');
    expect(dead.jetsonStatusHe).not.toBe('מחובר');
    expect(dead.fcStatusHe).not.toBe('מחובר');
  });

  it('uses מחובר · אין נתונים when reachable without a data path', () => {
    const empty = summarizeCompanionLink({
      mode: 'real',
      reachable: true,
      health: { ok: true },
    });
    expect(empty.connected).toBe(true);
    expect(empty.hasData).toBe(false);
    expect(empty.jetsonStatusHe).toBe('מחובר · אין נתונים');
    expect(empty.pillLabelHe).toBe('מחובר · אין נתונים');
    expect(empty.pillDot).toBe('warn');
    expect(empty.jetsonChip).toBe('warn');
  });

  it('shows מחובר / דופק חי only with reachability and a data path', () => {
    const live = summarizeCompanionLink({
      mode: 'real',
      reachable: true,
      health: { fc_linked: true, fc_heartbeat: true },
      overlay: { system: { cpu_percent: 41.2, temperature_c: 48.5 } },
    });
    expect(live.hasData).toBe(true);
    expect(live.jetsonStatusHe).toBe('מחובר');
    expect(live.fcStatusHe).toBe('דופק חי');
    expect(live.pillLabelHe).toBe('מחובר · בקר טיסה');
    expect(live.pillDot).toBe('on');
    expect(companionHasDataPath({
      overlay: { system: { cpu_percent: 41.2 } },
    })).toBe(true);
    expect(companionHasDataPath({ health: { fc_heartbeat: true } })).toBe(true);
    expect(companionHasDataPath({ health: { ok: true } })).toBe(false);
  });

  it('keeps topbar and Status labels on the same honesty mapping', () => {
    const ui = loadUiHonesty();
    const unreachable = { mode: 'real', reachable: false, connected: true };
    expect(ui.companionIsLive(unreachable)).toBe(false);
    expect(ui.pulseCompanionLabel(unreachable)).toBe('לא מגיב');
    expect(ui.pulseResolveComputerHonesty(unreachable)).toMatchObject({
      jetsonLabelHe: 'לא מגיב',
      jetsonCard: 'unreachable',
      fcLabelHe: 'מנותק',
      fcCard: 'disconnected',
    });
    expect(ui.pulseResolveFcHonesty(unreachable).card).toBe('disconnected');

    const nodata = { mode: 'real', reachable: true, connected: true, hasData: false };
    expect(ui.pulseCompanionLabel(nodata)).toBe('מחובר · אין נתונים');
    expect(ui.pulseResolveComputerHonesty(nodata).jetsonCard).toBe('nodata');

    const live = {
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
      system: { cpu_percent: 41.2, memPct: 52.5, temperature_c: 48.5 },
      fc: { heartbeat_validity: 'valid', loadPct: 18, memPct: 44, tempC: 36.2 },
    };
    const honesty = ui.pulseResolveComputerHonesty(live);
    expect(honesty.jetsonLabelHe).toBe('מחובר');
    expect(honesty.fcLabelHe).toBe('דופק חי');
    expect(honesty.jetsonCard).toBe('connected');
    expect(honesty.fcCard).toBe('heartbeat');
    expect(ui.formatComputerMetric(null, '%', 'אין נתון')).toBe('אין נתון');
    expect(ui.formatComputerMetric(41.2, '%', 'אין נתון')).toBe('41%');
    expect(ui.pulseComputerMetricValue(false, 41)).toBeNull();
  });

  it('maps Companion health/stats into FC gauge fields without inventing zeros', () => {
    const mapped = mapCompanionStatus(healthyCompanionStatus());
    expect(mapped.system.cpuLoadPct).toBe(41.2);
    expect(mapped.system.tempC).toBe(48.5);
    expect(mapped.fc.loadPct).toBe(18);
    expect(mapped.fc.memPct).toBe(44);
    expect(mapped.fc.tempC).toBe(36.2);
    const empty = mapCompanionStatus({ timestamp: { t_monotonic_ns: 1, t_utc_ns: null }, system: {}, fc: {} });
    expect(empty.fc.loadPct).toBeNull();
    expect(empty.fc.memPct).toBeNull();
    expect(empty.fc.tempC).toBeNull();
  });

  it('one-click default URL stays off HTML/API-client and strips quoted env tokens', () => {
    expect(DEFAULT_COMPANION_CONNECT_URL).toBe('http://100.82.59.45:8081');
    expect(resolveCompanionConnectDefaults({ env: {} }).url).toBe(DEFAULT_COMPANION_CONNECT_URL);
    expect(stripWrappedQuotes('"secret-token"')).toBe('secret-token');
    expect(companionAuthHeaders({ JETSON_COMPANION_TOKEN: "'abc-token'" })['X-Companion-Token']).toBe('abc-token');
    const apiClient = fs.readFileSync(path.join(repoRoot, 'lib', 'companion-api-client.mjs'), 'utf8');
    expect(apiClient).not.toContain('100.82.59.45');
    expect(html).not.toMatch(/100\.82\.59\.45/);
    expect(js).not.toMatch(/JETSON_COMPANION_TOKEN|COMPANION_SHARED_SECRET/);
  });

  it('companionConnectRender requires configuredReal plus reachable for connected chrome', () => {
    const render = sliceFunction(js, 'companionConnectRender');
    const refresh = sliceFunction(js, 'companionConnectRefresh');
    expect(render).toContain("const configuredReal = status?.mode === 'real'");
    expect(render).toContain('status?.mode === \'mock\' || status?.reachable === true');
    expect(render).toContain('const connected = configuredReal && reachable');
    expect(render).toContain('disconnectBtn.hidden = !configuredReal');
    expect(refresh).toContain('reachable: data.reachable === true');
    expect(js).toContain("return source.mode === 'real' && source.reachable === true");
  });

  it('Status version line is APP_VERSION and Jetson version is not a stale console pin', () => {
    const refresh = sliceFunction(js, 'pulseRefresh');
    const offers = sliceFunction(js, 'pulseRefreshVersionOffers');
    expect(refresh).toContain('APP_VERSION_NEW');
    expect(refresh).toContain('honesty.jetsonLabelHe');
    expect(refresh).toContain('אין נתון');
    expect(offers).toContain('APP_VERSION_NEW');
    expect(offers).toContain('אין נתון');
    expect(offers).not.toContain('jetsonInstalledVersionCached');
    expect(html).toMatch(/id="pulseVersion"[^>]*>--</);
    expect(hebrewJetsonState('reachable', { hasData: false })).toBe('מחובר · אין נתונים');
    expect(hebrewFcState('heartbeat')).toBe('דופק חי');
    const pill = composeConnectPill({
      dual: { radio: 'disconnected', cellular: 'disconnected', pillLabelHe: 'מנותק' },
      companion: { jetson: 'unreachable', fc: 'unknown', hasData: false },
    });
    expect(pill.pillLabelHe).toBe('מחשב משימה לא מגיב');
  });
});
