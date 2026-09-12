import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildRequestDataStreamPayload,
  buildSetMessageIntervalPayload,
  hudMessageRateTargets,
  parseMavlinkFrames,
  buildMavlink1Frame,
  MSG_REQUEST_DATA_STREAM,
  MSG_COMMAND_LONG,
  MAV_CMD_SET_MESSAGE_INTERVAL,
  MAV_DATA_STREAM_POSITION,
  MAV_DATA_STREAM_EXTRA1,
  MAV_DATA_STREAM_EXTRA2,
  MSG_ATTITUDE,
  MSG_GLOBAL_POSITION_INT,
  MSG_VFR_HUD,
  HUD_STREAM_RATE_HZ,
  HUD_STREAM_INTERVAL_US,
} from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const core = fs.readFileSync(path.join(repoRoot, 'lib', 'mavlink-connection.mjs'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

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

function loadSizeFns() {
  const src = [
    sliceFunction(js, 'clampMissionFr'),
    sliceFunction(js, 'defaultMissionSize'),
    sliceFunction(js, 'defaultMissionSwap'),
    sliceFunction(js, 'isLegacyDefaultMissionSize'),
    sliceFunction(js, 'missionAhRowPct'),
    sliceFunction(js, 'missionDataRowPx'),
    'function missionLayoutStoreGet(key) { return globalThis.__store?.[key] ?? null; }',
    'function missionLayoutStoreSet(key, value) { globalThis.__store[key] = String(value); }',
    "const MISSION_SIZE_KEY = 'visionLandingMissionSizeV4';",
    "const MISSION_SWAP_KEY = 'visionLandingMissionSwapV1';",
    sliceFunction(js, 'readMissionSize'),
    sliceFunction(js, 'readMissionSwap'),
    sliceFunction(js, 'writeMissionSwap'),
    sliceFunction(js, 'altitudeIsFinite'),
    sliceFunction(js, 'altitudeTileHonestyTitle'),
    "const VLC_TOOLTIP_HUD_TIME_SKEW = 'פער זמן בין חבילות MAVLink — ייתכן עיוות זמני בין אופק לשאר מדי ה-HUD.';",
    "const VLC_TOOLTIP_ALT_WAITING = 'אין גובה מהבקר עדיין';",
    'return { defaultMissionSize, defaultMissionSwap, isLegacyDefaultMissionSize, missionAhRowPct, missionDataRowPx, readMissionSize, readMissionSwap, writeMissionSwap, altitudeTileHonestyTitle };',
  ].join('\n');
  return new Function(src)();
}

describe('Mission AH size bias + swap persistence', () => {
  it('pins APP_VERSION at 1.02.294', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.294'");
    expect(pkg.version).toBe('1.02.294');
  });

  it('defaults to a taller AH share and shorter data strip', () => {
    const fns = loadSizeFns();
    const size = fns.defaultMissionSize();
    expect(size.r1).toBe(0.88);
    expect(size.r2).toBe(0.18);
    expect(size.c1).toBe(0.18);
    expect(size.c3).toBe(0.22);
    expect(size.r1).toBeGreaterThan(0.78);
    expect(size.r2).toBeLessThan(0.22);
    expect(fns.missionAhRowPct(size.r1)).toBe(66);
    expect(fns.missionAhRowPct(0.78)).toBe(59);
    expect(fns.missionDataRowPx(size.r2)).toBe(72);
    expect(css).toMatch(/--mission-ah-row:\s*66%/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*min-height:\s*52%/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*max-height:\s*calc\(100% - var\(--mission-data-h/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*flex:\s*1 1 auto/);
    expect(css).toMatch(/max-height:\s*var\(--mission-data-h, 72px\)/);
    expect(sliceFunction(js, 'applyMissionSize')).toContain('--mission-ah-row');
    expect(sliceFunction(js, 'applyMissionSize')).toContain('--mission-data-h');
  });

  it('migrates the old 0.78/0.22 default and keeps a custom drag-resize', () => {
    const fns = loadSizeFns();
    expect(fns.isLegacyDefaultMissionSize({ r1: 0.78, r2: 0.22 })).toBe(true);
    expect(fns.isLegacyDefaultMissionSize({ r1: 0.84, r2: 0.16 })).toBe(true);
    globalThis.__store = {
      visionLandingMissionSizeV4: JSON.stringify({
        c1: 0.18, c2: 1.1, c3: 0.22, r1: 0.78, r2: 0.22, r3: 0,
      }),
    };
    expect(fns.readMissionSize()).toEqual({
      c1: 0.18, c2: 1.1, c3: 0.22, r1: 0.88, r2: 0.18, r3: 0,
    });
    globalThis.__store = {
      visionLandingMissionSizeV4: JSON.stringify({
        c1: 0.16, c2: 1.3, c3: 0.24, r1: 0.80, r2: 0.18, r3: 0,
      }),
    };
    expect(fns.readMissionSize()).toEqual({
      c1: 0.16, c2: 1.3, c3: 0.24, r1: 0.80, r2: 0.18, r3: 0,
    });
    globalThis.__store = {
      visionLandingMissionSizeV4: JSON.stringify({
        c1: 0.20, c2: 1.20, c3: 0.24, r1: 0.50, r2: 0.40, r3: 0,
      }),
    };
    const clamped = fns.readMissionSize();
    expect(clamped.r1).toBe(0.70);
    expect(clamped.r2).toBe(0.22);
  });

  it('keeps messages in the AH stack and swaps map to the wide 1fr track', () => {
    const horizonBlock = html.slice(
      html.indexOf('data-mission-region="horizon"'),
      html.indexOf('data-mission-region="map"'),
    );
    const mapBlock = html.slice(
      html.indexOf('data-mission-region="map"'),
      html.indexOf('data-mission-region="talk"'),
    );
    expect(horizonBlock).toContain('data-mission-region="messages"');
    expect(mapBlock).not.toContain('data-mission-region="messages"');
    expect(css).toContain('data-mission-swap="map-horizon"');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) minmax(132px, min(20%, var(--mission-ah-col)))');
    expect(css).toMatch(/\.mission-region\[data-mission-region="messages"\]\s*\{[^}]*position:\s*relative/);
    expect(css).not.toMatch(/data-mission-region="messages"\][^{]*\{[^}]*left:\s*6px/);
    expect(sliceFunction(js, 'positionPfdReadinessPopover')).toContain('[data-mission-region="talk"]');
    expect(sliceFunction(js, 'positionPfdReadinessPopover')).toContain('talk.left - w - 8');
  });

  it('defaults to map-horizon and keeps a saved horizon-map choice', () => {
    const fns = loadSizeFns();
    expect(fns.defaultMissionSwap()).toBe('map-horizon');
    globalThis.__store = {};
    expect(fns.readMissionSwap()).toBe('map-horizon');
    globalThis.__store = { visionLandingMissionSwapV1: 'horizon-map' };
    expect(fns.readMissionSwap()).toBe('horizon-map');
    fns.writeMissionSwap('map-horizon');
    expect(globalThis.__store.visionLandingMissionSwapV1).toBe('map-horizon');
    expect(html).toMatch(/data-mission-swap="map-horizon"/);
    expect(sliceFunction(js, 'initMissionLayout')).toContain('applyMissionSwap(readMissionSwap())');
    expect(sliceFunction(js, 'resetMissionLayout')).toContain('defaultMissionSwap()');
    expect(sliceFunction(js, 'toggleMissionHorizonMapSwap')).not.toContain('swapMissionRegions');
  });

  it('keeps the horizon video empty-state honest about a stream address', () => {
    expect(html).toContain('id="horizonVideoToggle"');
    expect(html).toContain('id="horizonVideoUrl"');
    expect(html).toMatch(/id="horizonVideoEmpty"[^>]*>אין וידאו\. דרושה כתובת זרם ממחשב המשימה\.</);
    expect(js).toContain("HORIZON_VIDEO_URL_KEY = 'vlc.horizon.videoUrl'");
  });
});

describe('Altitude tile honesty', () => {
  it('keeps -- and explains a live FC with no altitude yet', () => {
    const fns = loadSizeFns();
    expect(fns.altitudeTileHonestyTitle({
      connected: true,
      rollDeg: 1.2,
      pitchDeg: -4,
      altitude: null,
    })).toBe('אין גובה מהבקר עדיין');
    expect(fns.altitudeTileHonestyTitle({
      connected: true,
      altitude: 88.4,
    })).toBe('');
    expect(fns.altitudeTileHonestyTitle({
      connected: false,
      altitude: null,
    })).toBe('');
    expect(js).toContain("const VLC_TOOLTIP_ALT_WAITING = 'אין גובה מהבקר עדיין'");
    expect(sliceFunction(js, 'applyTopbarFlightData')).toContain('altitudeTileHonestyTitle(mav)');
    expect(sliceFunction(js, 'applyTopbarFlightData')).toContain("useTile ? '--'");
  });
});

describe('HUD message-interval request (no flight commands)', () => {
  it('builds REQUEST_DATA_STREAM and SET_MESSAGE_INTERVAL for VFR_HUD and GLOBAL_POSITION_INT', () => {
    const targets = hudMessageRateTargets();
    expect(targets.streams.map((s) => s.id)).toEqual([
      MAV_DATA_STREAM_POSITION,
      MAV_DATA_STREAM_EXTRA1,
      MAV_DATA_STREAM_EXTRA2,
    ]);
    expect(targets.messages.map((m) => m.id)).toEqual([
      MSG_ATTITUDE,
      MSG_GLOBAL_POSITION_INT,
      MSG_VFR_HUD,
    ]);
    const ds = buildRequestDataStreamPayload(1, 1, MAV_DATA_STREAM_EXTRA2, HUD_STREAM_RATE_HZ);
    expect(ds.length).toBe(6);
    expect(ds[2]).toBe(MAV_DATA_STREAM_EXTRA2);
    expect(ds.readUInt16LE(3)).toBe(HUD_STREAM_RATE_HZ);
    expect(ds[5]).toBe(1);
    const iv = buildSetMessageIntervalPayload(1, 1, MSG_VFR_HUD, HUD_STREAM_INTERVAL_US);
    expect(iv.length).toBe(33);
    expect(iv.readUInt16LE(2)).toBe(MAV_CMD_SET_MESSAGE_INTERVAL);
    expect(iv.readFloatLE(5)).toBe(MSG_VFR_HUD);
    expect(iv.readFloatLE(9)).toBe(HUD_STREAM_INTERVAL_US);
    const frames = parseMavlinkFrames(Buffer.concat([
      buildMavlink1Frame(MSG_REQUEST_DATA_STREAM, ds, 1),
      buildMavlink1Frame(MSG_COMMAND_LONG, iv, 2),
    ]));
    expect(frames.map((f) => f.msgId)).toEqual([MSG_REQUEST_DATA_STREAM, MSG_COMMAND_LONG]);
    expect(core).toContain('requestHudMessageRates()');
    expect(core).toContain('conn.requestHudMessageRates()');
    expect(core).toContain('buildSetMessageIntervalPayload');
    expect(core).toContain('MAV_CMD_SET_MESSAGE_INTERVAL');
    const methodStart = core.indexOf('requestHudMessageRates() {');
    expect(methodStart).toBeGreaterThan(0);
    const method = core.slice(methodStart, methodStart + 1200);
    expect(method).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b|DO_REPOSITION|NAV_LAND|MAV_CMD_COMPONENT_ARM/);
    expect(method).toContain('buildSetMessageIntervalPayload');
    expect(iv.readUInt16LE(2)).not.toBe(400);
    expect(iv.readUInt16LE(2)).not.toBe(176);
  });

  it('SSE snapshot exposes altitudeSource without inventing altitude', () => {
    const snap = buildSseMavlinkSnapshot({
      connected: true,
      listening: true,
      heartbeatCount: 4,
      lastAttitude: { rollDeg: 2, pitchDeg: -3 },
      lastVfrHud: null,
      lastGlobalPos: null,
    });
    expect(snap.altitude).toBeNull();
    expect(snap.altitudeSource).toBeNull();
    expect(snap.rollDeg).toBe(2);
  });
});
