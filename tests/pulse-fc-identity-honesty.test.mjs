import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

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

function loadPulseIdentity() {
  const src = [
    sliceFunction(js, 'companionFiniteMetric'),
    sliceFunction(js, 'pulseFcObject'),
    sliceFunction(js, 'pulseCompanionFcLink'),
    sliceFunction(js, 'pulseResolveFcHonesty'),
    sliceFunction(js, 'pulseFiniteOrNull'),
    sliceFunction(js, 'pulseFormatHbAge'),
    sliceFunction(js, 'pulseFormatHbRate'),
    sliceFunction(js, 'pulseLinkKindLabel'),
    sliceFunction(js, 'pulseResolveFcIdentity'),
    'return { pulseResolveFcHonesty, pulseResolveFcIdentity, pulseFormatHbAge, pulseFormatHbRate };',
  ].join('\n');
  return new Function(src)();
}

describe('Status Computers pulse identity honesty', () => {
  const ui = loadPulseIdentity();

  it('live heartbeat without SYS_STATUS still shows identity; gauges stay empty', () => {
    const mav = {
      connected: true,
      autopilotName: 'ArduPilot',
      vehicleType: 'Fixed Wing',
      sysId: 51,
      lastHeartbeatAgeMs: 220,
      heartbeatRateHz: 1.02,
      fcLoadPct: null,
      fcMemPct: null,
      fcTempC: null,
    };
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
      fc: { heartbeat: true },
    }, mav);
    expect(honesty.live).toBe(true);
    expect(honesty.hasMetrics).toBe(false);
    expect(honesty.showGcsMissingNote).toBe(true);
    expect(honesty.load).toBeNull();
    expect(honesty.mem).toBeNull();
    expect(honesty.temp).toBeNull();
    const ident = ui.pulseResolveFcIdentity(mav, honesty);
    expect(ident.live).toBe(true);
    expect(ident.autopilotName).toBe('ArduPilot');
    expect(ident.vehicleType).toBe('Fixed Wing');
    expect(ident.sysId).toBe(51);
    expect(ident.heartbeatAgeMs).toBe(220);
    expect(ident.heartbeatRateHz).toBeCloseTo(1.02);
    expect(ident.link).toBe('heartbeat');
  });

  it('missing identity fields stay null / -- and are not invented', () => {
    const honesty = ui.pulseResolveFcHonesty({
      mode: 'real',
      reachable: true,
      fc_heartbeat: true,
    }, { connected: true });
    const ident = ui.pulseResolveFcIdentity({ connected: true }, honesty);
    expect(ident.autopilotName).toBeNull();
    expect(ident.vehicleType).toBeNull();
    expect(ident.sysId).toBeNull();
    expect(ident.heartbeatAgeMs).toBeNull();
    expect(ui.pulseFormatHbAge(null)).toBeNull();
    expect(ui.pulseFormatHbRate(undefined)).toBeNull();
  });

  it('SSE snapshot wires sysId / heartbeat age / rate without inventing SYS_STATUS gauges', () => {
    const snap = buildSseMavlinkSnapshot({
      connected: true,
      listening: true,
      heartbeatCount: 8,
      sysId: 51,
      lastHeartbeatAt: new Date(Date.now() - 180).toISOString(),
      firstHeartbeatAt: new Date(Date.now() - 8000).toISOString(),
      autopilotName: 'ArduPilot',
      vehicleType: 'Fixed Wing',
      lastBattery: null,
    });
    expect(snap.sysId).toBe(51);
    expect(snap.autopilotName).toBe('ArduPilot');
    expect(snap.vehicleType).toBe('Fixed Wing');
    expect(snap.lastHeartbeatAgeMs).toBeGreaterThan(0);
    expect(snap.heartbeatRateHz).toBeGreaterThan(0);
    expect(snap.fcLoadPct).toBeNull();
    expect(snap.fcMemPct).toBeNull();
    expect(snap.fcTempC).toBeNull();
  });

  it('paints identity list from pulseRefresh and keeps honesty note', () => {
    expect(html).toContain('id="pulseFcIdentityList"');
    expect(html).toContain('id="pulseFcSysId"');
    expect(html).toContain('id="pulseFcHbAge"');
    expect(html).toContain('id="pulseFcMetricsNote"');
    const refresh = sliceFunction(js, 'pulseRefresh');
    expect(refresh).toContain('pulsePaintFcIdentity');
    expect(refresh).toContain('pulseFcMetricsNote');
    expect(refresh).not.toMatch(/FLIGHT_ACTION|\/apply|\/restart|\bARM\b|\bLAND\b/);
  });
});
