import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mapCompanionStatus } from '../lib/companion-status.mjs';
import { healthyCompanionStatus } from '../lib/companion-mock-fixtures.mjs';
import { hebrewFcState } from '../lib/companion-link.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');

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

function loadFcHonesty() {
  const src = [
    sliceFunction(js, 'companionFiniteMetric'),
    sliceFunction(js, 'pulseFcObject'),
    sliceFunction(js, 'pulseCompanionFcLink'),
    sliceFunction(js, 'pulseResolveFcHonesty'),
    'return { companionFiniteMetric, pulseFcObject, pulseCompanionFcLink, pulseResolveFcHonesty };',
  ].join('\n');
  return new Function(src)();
}

describe('Status FC honest gauges (UART heartbeat vs GCS load)', () => {
  const ui = loadFcHonesty();

  it('shows דופק חי without fake green מחובר when heartbeat is live and GCS metrics are null', () => {
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
      fc_linked: true,
      fc: { heartbeat: true, heartbeat_validity: 'valid' },
    }, { connected: false, fcLoadPct: null, fcMemPct: null, fcTempC: null });
    expect(honesty.link).toBe('heartbeat');
    expect(honesty.labelHe).toBe('דופק חי');
    expect(honesty.labelHe).not.toBe('מחובר');
    expect(honesty.card).toBe('heartbeat');
    expect(honesty.card).not.toBe('connected');
    expect(honesty.live).toBe(true);
    expect(honesty.hasMetrics).toBe(false);
    expect(honesty.showGcsMissingNote).toBe(true);
    expect(honesty.load).toBeNull();
    expect(honesty.mem).toBeNull();
    expect(honesty.temp).toBeNull();
    expect(honesty.load).not.toBe(0);
    expect(honesty.mem).not.toBe(0);
    expect(honesty.temp).not.toBe(0);
  });

  it('shows מקושר warn chrome when UART is linked without heartbeat or GCS load', () => {
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_linked: true,
      fc_heartbeat: false,
    }, { connected: false });
    expect(honesty.link).toBe('linked');
    expect(honesty.labelHe).toBe('מקושר');
    expect(honesty.card).toBe('linked');
    expect(honesty.showGcsMissingNote).toBe(true);
  });

  it('shows מנותק when companion UART is unlinked and GCS HUD is down', () => {
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_linked: false,
      fc_heartbeat: false,
    }, { connected: false });
    expect(honesty.link).toBe('unlinked');
    expect(honesty.labelHe).toBe('מנותק');
    expect(honesty.card).toBe('disconnected');
    expect(honesty.showGcsMissingNote).toBe(false);
    expect(honesty.live).toBe(false);
  });

  it('maps Companion sys_status FC metrics when present and does not invent missing ones', () => {
    const mapped = mapCompanionStatus(healthyCompanionStatus());
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
      fc: mapped.fc,
    }, { connected: false, fcLoadPct: null, fcMemPct: null, fcTempC: null });
    expect(honesty.load).toBe(18);
    expect(honesty.mem).toBe(44);
    expect(honesty.temp).toBe(36.2);
    expect(honesty.showGcsMissingNote).toBe(false);
    expect(honesty.card).toBe('heartbeat');

    const empty = mapCompanionStatus({
      timestamp: { t_monotonic_ns: 1, t_utc_ns: null },
      fc: { heartbeat: { validity: 'valid' }, sys_status: { fields: {} } },
    });
    expect(empty.fc.loadPct).toBeNull();
    expect(empty.fc.memPct).toBeNull();
    expect(empty.fc.tempC).toBeNull();
  });

  it('prefers real GCS HUD numbers when MAVLink is connected', () => {
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
      fc: {},
    }, { connected: true, fcLoadPct: 22.4, fcMemPct: null, fcTempC: 31 });
    expect(honesty.load).toBeCloseTo(22.4);
    expect(honesty.mem).toBeNull();
    expect(honesty.temp).toBe(31);
    expect(honesty.hasMetrics).toBe(true);
    expect(honesty.showGcsMissingNote).toBe(false);
    expect(honesty.gaugeMissing).toBe('אין נתון');
  });

  it('aligns Status FC chrome tokens with topbar heartbeat vs unlinked', () => {
    expect(hebrewFcState('heartbeat')).toBe('דופק חי');
    expect(hebrewFcState('linked')).toBe('מקושר');
    expect(hebrewFcState('unlinked')).toBe('מנותק');
    expect(html).toContain('id="pulseFcMetricsNote"');
    expect(html).toContain('אין נתוני עומס מ־GCS');
    expect(css).toMatch(/\.pulse-computer-card\[data-state="heartbeat"\]/);
    expect(css).toMatch(/\.pulse-computer-card\[data-state="linked"\]/);
    const refresh = sliceFunction(js, 'pulseRefresh');
    expect(refresh).toContain('pulseResolveFcHonesty');
    expect(refresh).toContain('fcHonesty.card');
    expect(refresh).toContain('pulseFcMetricsNote');
    expect(refresh).not.toMatch(/aircraftEl\.textContent = fcConnected \? 'מחובר'/);
    expect(refresh).not.toMatch(/fcCard: fcHb \? 'connected'/);
    const apply = sliceFunction(js, 'applyCompanionLinkUi');
    expect(apply).not.toMatch(/fc:\s*link\.fc/);
    expect(apply).not.toMatch(/jetson:\s*link\.jetson/);
    expect(apply).toContain('fc_heartbeat: link.fc_heartbeat');
  });

  it('does not add flight-command or Companion apply/restart paths', () => {
    const src = [
      sliceFunction(js, 'pulseCompanionFcLink'),
      sliceFunction(js, 'pulseResolveFcHonesty'),
      sliceFunction(js, 'pulseRefresh'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND/);
  });
});
