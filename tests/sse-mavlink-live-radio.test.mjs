import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pickLiveMavlinkConnection } from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const core = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'core-api.mjs'), 'utf8');

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

function fakeRadio(overrides = {}) {
  return {
    id: 1,
    linkRole: 'radio',
    connected: true,
    listening: true,
    heartbeatCount: 12,
    autopilotName: 'ArduPilot',
    vehicleType: 'Fixed Wing',
    statusTexts: [
      { severity: 6, text: 'EKF3 waiting for GPS configuring data', receivedAt: '2026-09-12T06:00:00.000Z' },
      { severity: 4, text: 'PreArm: Waiting for Navigation Checks', receivedAt: '2026-09-12T06:00:01.000Z' },
    ],
    lastBaseMode: 0,
    lastCustomMode: 0,
    lastAttitude: null,
    lastBattery: null,
    lastGpsRaw: null,
    lastRcChannels: null,
    lastVfrHud: null,
    lastGlobalPos: null,
    ...overrides,
  };
}

describe('pickLiveMavlinkConnection — HUD/SSE must follow the live radio', () => {
  it('skips a disconnected preferred command-link when radio id 1 is up', () => {
    const deadPreferred = {
      id: 2,
      linkRole: 'cellular',
      connected: false,
      listening: false,
      heartbeatCount: 0,
      statusTexts: [],
    };
    const radio = fakeRadio();
    const picked = pickLiveMavlinkConnection([deadPreferred, radio], 2);
    expect(picked).toBe(radio);
    expect(picked.connected).toBe(true);
    expect(picked.id).toBe(1);
  });

  it('keeps the preferred link when that socket is actually connected', () => {
    const cell = { id: 2, linkRole: 'cellular', connected: true, heartbeatCount: 3 };
    const radio = fakeRadio();
    expect(pickLiveMavlinkConnection([radio, cell], 2)).toBe(cell);
  });

  it('falls back to first connected radio when command-link id is missing', () => {
    const stale = { id: 9, linkRole: 'radio', connected: false, listening: false };
    const radio = fakeRadio();
    expect(pickLiveMavlinkConnection([stale, radio], null)).toBe(radio);
  });
});

describe('buildSseMavlinkSnapshot — Mission HUD payload', () => {
  it('copies connected + recentStatusTexts from the live radio', () => {
    const snap = buildSseMavlinkSnapshot(fakeRadio());
    expect(snap.connected).toBe(true);
    expect(snap.heartbeatCount).toBe(12);
    expect(snap.autopilotName).toBe('ArduPilot');
    expect(snap.vehicleType).toBe('Fixed Wing');
    expect(snap.recentStatusTexts.map((t) => t.text)).toEqual([
      'EKF3 waiting for GPS configuring data',
      'PreArm: Waiting for Navigation Checks',
    ]);
  });

  it('stays disconnected only when no live socket exists', () => {
    const snap = buildSseMavlinkSnapshot(null);
    expect(snap.connected).toBe(false);
    expect(snap.recentStatusTexts).toEqual([]);
  });
});

describe('SSE + Mission HUD pipeline wiring', () => {
  it('SSE interval builds mavlink from getActiveConnection via buildSseMavlinkSnapshot', () => {
    expect(core).toContain('buildSseMavlinkSnapshot');
    expect(core).toMatch(/const mavConn = getActiveConnection\?\.\(\);/);
    expect(core).toMatch(/const mavlink = buildSseMavlinkSnapshot\(mavConn\);/);
    expect(core).not.toMatch(/const hud = composeHudTelemetryFields\(mavConn\);/);
  });

  it('Mission STATUSTEXT hydrates from live radio status, not only SSE connected', () => {
    const apply = sliceFunction(js, 'applyFcStatustextHud');
    expect(apply).toMatch(/isHudMavlinkLive\(mavlink\)/);
    expect(apply).toContain('אין חיבור לבקר — לא מתקבלות הודעות MAVLink.');
    expect(js).toContain('function resolveHudMavlink(');
    expect(js).toContain('function liveStatusToHudMavlink(');
    expect(js).toContain('function hydrateMissionHudFromLiveLink(');
    expect(js).toMatch(/resolveHudMavlink\(payload\.mavlink,\s*latestLiveRadioStatus\)/);
    expect(js).toMatch(/rememberLiveRadioStatus\(active\.liveStatus\)/);
    expect(js).toMatch(/rememberLiveRadioStatus\(j\.connection\.liveStatus\)/);
  });

  it('does not invent gauges when hydrating from connections status', () => {
    const resolve = sliceFunction(js, 'resolveHudMavlink');
    expect(resolve).toMatch(/connected: true/);
    expect(resolve).toMatch(/recentStatusTexts/);
    expect(resolve).not.toMatch(/Math\.random|fakeAirspeed|invent/);
  });
});
