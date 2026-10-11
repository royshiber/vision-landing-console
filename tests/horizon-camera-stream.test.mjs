import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const liveStatus = {
  vision: {
    source: 'absent',
    source_id: 'cam1',
    camera_ok: false,
    cameras: {
      cam0: { id: 'cam0', state: 'streaming', fps: 60, camera_ok: false },
      cam1: { id: 'cam1', state: 'streaming', fps: 29.8, camera_ok: false },
    },
  },
  opticalNav: {
    camera_ok: false,
    cameras: {
      cam1: { id: 'cam1', source: 'absent', camera_ok: false, fps: null, state: 'absent' },
    },
  },
};

function loadHorizonFns() {
  const names = [
    'horizonSlotStreaming',
    'horizonStreamApiId',
    'horizonCameraDetail',
  ];
  const src = names.map((name) => sliceFunction(js, name)).join('\n');
  return new Function(`${src}\nreturn { horizonSlotStreaming, horizonStreamApiId, horizonCameraDetail };`)();
}

function loadModeFns() {
  const start = js.indexOf('const ARDUPILOT_PLANE_MODES');
  const endName = 'function vlcFlightModeText(';
  const end = js.indexOf(endName);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const tail = sliceFunction(js, 'vlcFlightModeText');
  const head = js.slice(start, end);
  const hud = [
    'hudSysId',
    'hudFiniteOrNull',
    'hudFcMetricFields',
    'preferHudFcMetrics',
    'hudFiniteMode',
    'liveStatusToHudMavlink',
    'resolveHudMavlink',
  ].map((name) => sliceFunction(js, name)).join('\n');
  return new Function(`${head}\n${tail}\n${hud}\nreturn { vlcFlightModeText, liveStatusToHudMavlink, resolveHudMavlink };`)();
}

describe('horizon no-stream follows the selected camera', () => {
  it('treats a streaming per-camera row as live when the parent vision block says absent', () => {
    const { horizonSlotStreaming, horizonStreamApiId, horizonCameraDetail } = loadHorizonFns();
    expect(horizonSlotStreaming(liveStatus.vision)).toBe(false);
    expect(horizonSlotStreaming(liveStatus.vision.cameras.cam1)).toBe(true);
    expect(horizonSlotStreaming(liveStatus.vision.cameras.cam0)).toBe(true);
    expect(horizonCameraDetail(liveStatus, 'cam1').fps).toBe(29.8);
    expect(horizonCameraDetail(liveStatus, 'cam1').state).toBe('streaming');
    expect(horizonStreamApiId(liveStatus, ['cam1'])).toBe('cam1');
    expect(horizonStreamApiId(liveStatus, ['cam0'])).toBe('cam0');
    expect(horizonStreamApiId(liveStatus, [])).toBe('cam1');
    expect(horizonStreamApiId(liveStatus, ['cam2'])).toBeNull();
  });

  it('counts fps without camera_ok, and ignores a stub that hides a live sibling', () => {
    const { horizonSlotStreaming, horizonStreamApiId } = loadHorizonFns();
    const omitted = {
      vision: {
        source: 'absent',
        source_id: 'cam1',
        camera_ok: false,
      },
      cameras: {
        cam1: { id: 'cam1', state: 'streaming', fps: 29.8 },
        cam0: { state: 'streaming', fps: 60 },
      },
      optical_nav: {
        cameras: {
          cam1: { id: 'cam1', source: 'absent', camera_ok: false },
        },
      },
    };
    expect(horizonSlotStreaming(omitted.cameras.cam1)).toBe(true);
    expect(horizonStreamApiId(omitted, ['cam1'])).toBe('cam1');
    expect(horizonSlotStreaming({ state: 'disabled', fps: 30, camera_ok: true })).toBe(false);
    expect(horizonSlotStreaming({ state: 'absent', source: 'absent', camera_ok: false })).toBe(false);
  });
});

describe('ArduPlane HEARTBEAT custom_mode 0 is MANUAL once connected', () => {
  it('keeps mode 0 through the SSE snapshot and the flight-mode tile', () => {
    const snap = buildSseMavlinkSnapshot({
      id: 1,
      linkRole: 'radio',
      connected: true,
      listening: true,
      heartbeatCount: 4,
      autopilotName: 'ArduPilot',
      vehicleType: 'Fixed Wing',
      mavType: 1,
      lastCustomMode: 0,
      lastBaseMode: 81,
      statusTexts: [],
      lastAttitude: null,
      lastBattery: null,
      lastGpsRaw: null,
      lastRcChannels: null,
      lastVfrHud: null,
      lastGlobalPos: null,
    });
    expect(snap.flightMode).toBe(0);
    expect(snap.connected).toBe(true);
    const { vlcFlightModeText, liveStatusToHudMavlink, resolveHudMavlink } = loadModeFns();
    const plane = { mavType: 1, vehicleType: 'Fixed Wing', connected: true };
    expect(vlcFlightModeText(0, plane, true)).toBe('MANUAL');
    expect(vlcFlightModeText(0, { mavType: 2, vehicleType: 'Quadrotor' }, true)).toBe('STABILIZE');
    const live = liveStatusToHudMavlink({
      connected: true,
      flightMode: 0,
      custom_mode: 0,
      mavType: 1,
      vehicleType: 'Fixed Wing',
    });
    expect(live.flightMode).toBe(0);
    const resolved = resolveHudMavlink({ connected: false, flightMode: null }, live);
    expect(resolved.flightMode).toBe(0);
    expect(vlcFlightModeText(resolved.flightMode, resolved, resolved.connected)).toBe('MANUAL');
  });
});
