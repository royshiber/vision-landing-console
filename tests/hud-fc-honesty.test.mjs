import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  HUD_REASON_NO_LINK,
  HUD_REASON_ALT_WAITING,
  HUD_REASON_SPD_WAITING,
  HUD_REASON_GPS_WAITING,
  HUD_REASON_EKF_WAIT_GPS,
  HUD_REASON_EKF_NO_FIX,
  hudFieldHonesty,
  altitudeHonestyTitle,
  airspeedHonestyTitle,
  classifyEkfGpsStatusText,
  pickHudEkfGpsHint,
  formatGpsHudReadout,
  shouldReRequestHudRates,
  HUD_RATE_RECONNECT_GAP_MS,
  HUD_RATE_MISSING_RETRY_MS,
  HUD_RATE_MAX_REQUESTS,
} from '../lib/hud-honesty.mjs';
import {
  parseGpsRawInt,
  hudMessageRateTargets,
  MSG_VFR_HUD,
  MSG_GLOBAL_POSITION_INT,
  MSG_GPS_RAW_INT,
  MSG_ATTITUDE,
  MSG_SYS_STATUS,
} from '../lib/mavlink-connection.mjs';
import { composeHudTelemetryFields } from '../lib/mavlink-hud-fields.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(repoRoot, 'lib', 'mavlink-connection.mjs'), 'utf8');

function liveMav(overrides = {}) {
  return {
    connected: true,
    listening: true,
    heartbeatCount: 12,
    altitude: null,
    airspeed: null,
    gpsFixType: null,
    gpsSats: null,
    recentStatusTexts: [],
    ...overrides,
  };
}

describe('HUD field honesty helper', () => {
  it('does not invent numbers when VFR and GLOBAL are missing', () => {
    const hud = composeHudTelemetryFields({
      lastVfrHud: null,
      lastGlobalPos: null,
      lastAttitude: { rollDeg: 2, pitchDeg: -4, yawDeg: 90, receivedWallMs: 1 },
    });
    expect(hud.altitude).toBeNull();
    expect(hud.airspeed).toBeNull();
    expect(hud.groundspeed).toBeNull();
    expect(hud.climbRate).toBeNull();
    expect(hud.altitudeSource).toBeNull();
    const snap = buildSseMavlinkSnapshot({
      connected: true,
      listening: true,
      heartbeatCount: 6,
      lastAttitude: { rollDeg: 2, pitchDeg: -4 },
      lastVfrHud: null,
      lastGlobalPos: null,
      lastGpsRaw: null,
    });
    expect(snap.altitude).toBeNull();
    expect(snap.airspeed).toBeNull();
    expect(snap.climbRate).toBeNull();
    expect(snap.gpsFixType).toBeNull();
    expect(snap.gpsSats).toBeNull();
    expect(snap.map).toBeNull();
  });

  it('uses dashes plus a distinct Hebrew reason for no-link vs connected-waiting', () => {
    expect(hudFieldHonesty('altitude', null, null)).toEqual({
      state: 'no_link',
      title: HUD_REASON_NO_LINK,
      dash: true,
    });
    expect(hudFieldHonesty('altitude', { connected: false }, null).state).toBe('no_link');
    expect(hudFieldHonesty('altitude', liveMav(), null)).toEqual({
      state: 'waiting',
      title: HUD_REASON_ALT_WAITING,
      dash: true,
    });
    expect(hudFieldHonesty('airspeed', liveMav(), null).title).toBe(HUD_REASON_SPD_WAITING);
    expect(hudFieldHonesty('gps', liveMav(), null).title).toBe(HUD_REASON_GPS_WAITING);
    expect(hudFieldHonesty('altitude', liveMav({ altitude: 41.5 }), 41.5)).toEqual({
      state: 'value',
      title: '',
      dash: false,
    });
    expect(altitudeHonestyTitle(null)).toBe(HUD_REASON_NO_LINK);
    expect(altitudeHonestyTitle(liveMav())).toBe(HUD_REASON_ALT_WAITING);
    expect(altitudeHonestyTitle(liveMav({ altitude: 12 }))).toBe('');
    expect(airspeedHonestyTitle(liveMav())).toBe(HUD_REASON_SPD_WAITING);
    expect(airspeedHonestyTitle({ connected: false, airspeed: null })).toBe(HUD_REASON_NO_LINK);
  });

  it('keeps real VFR altitude and IAS when present', () => {
    const hud = composeHudTelemetryFields({
      lastVfrHud: {
        airspeed: 18.2,
        groundspeed: 19,
        alt: 33.4,
        climb: -0.4,
        receivedWallMs: 1,
      },
      lastGlobalPos: null,
      lastAttitude: { yawDeg: 10, receivedWallMs: 1 },
    });
    expect(hud.altitude).toBe(33.4);
    expect(hud.airspeed).toBe(18.2);
    expect(hud.climbRate).toBe(-0.4);
    expect(hud.airspeedIsGroundspeedProxy).toBe(false);
    expect(hudFieldHonesty('altitude', liveMav({ altitude: hud.altitude }), hud.altitude).dash).toBe(false);
  });
});

describe('GPS_RAW honesty without invented coordinates', () => {
  it('keeps fix and sats when lat/lon are still 0,0', () => {
    const p = Buffer.alloc(33);
    p.writeUInt8(1, 8);
    p.writeInt32LE(0, 12);
    p.writeInt32LE(0, 16);
    p.writeUInt8(5, 32);
    const g = parseGpsRawInt(p);
    expect(g).not.toBeNull();
    expect(g.lat).toBeNull();
    expect(g.lon).toBeNull();
    expect(g.fixType).toBe(1);
    expect(g.satellites).toBe(5);
    const snap = buildSseMavlinkSnapshot({
      connected: true,
      lastGpsRaw: g,
      getMapTelemetrySnapshot() {
        return { gpsLat: g.lat, gpsLon: g.lon, gpsSource: null };
      },
    });
    expect(snap.gpsFixType).toBe(1);
    expect(snap.gpsSats).toBe(5);
    expect(snap.map.gpsLat).toBeNull();
    expect(snap.map.gpsLon).toBeNull();
    const readout = formatGpsHudReadout({
      connected: true,
      gpsFixType: 1,
      gpsSats: 5,
    });
    expect(readout.text).toContain('אין Fix');
    expect(readout.text).toContain('5');
    expect(readout.dash).toBe(false);
    expect(readout.title).toBe(HUD_REASON_GPS_WAITING);
  });
});

describe('EKF / GPS STATUSTEXT near HUD', () => {
  it('classifies waiting-for-GPS without using the English line as the HUD hint', () => {
    expect(classifyEkfGpsStatusText('EKF3 waiting for GPS config')).toBe(HUD_REASON_EKF_WAIT_GPS);
    expect(classifyEkfGpsStatusText('AHRS: waiting for GPS')).toBe(HUD_REASON_EKF_WAIT_GPS);
    expect(classifyEkfGpsStatusText('GPS: no fix')).toBe(HUD_REASON_EKF_NO_FIX);
    expect(classifyEkfGpsStatusText('EKF3 IMU0 origin set')).toBeNull();
    expect(classifyEkfGpsStatusText('throttle armed')).toBeNull();
    const picked = pickHudEkfGpsHint([
      { text: 'ArduPlane V4.6.0' },
      { text: 'EKF3 waiting for GPS config' },
    ]);
    expect(picked.hint).toBe(HUD_REASON_EKF_WAIT_GPS);
    expect(picked.sourceText).toMatch(/EKF3/);
  });
});

describe('HUD rate-request helper', () => {
  it('requests on first heartbeat, reconnect gap, v2 upgrade, and missing HUD — then stops', () => {
    expect(shouldReRequestHudRates({ lastRequestAt: null })).toBe(true);
    expect(shouldReRequestHudRates({
      lastRequestAt: 1_000,
      lastRequestTxVersion: 1,
      preferredTxVersion: 2,
      now: 1_100,
      requestCount: 1,
    })).toBe(true);
    expect(shouldReRequestHudRates({
      lastRequestAt: 1_000,
      lastRequestTxVersion: 2,
      preferredTxVersion: 2,
      heartbeatGapMs: HUD_RATE_RECONNECT_GAP_MS,
      now: 4_000,
      requestCount: 3,
    })).toBe(true);
    expect(shouldReRequestHudRates({
      lastRequestAt: 1_000,
      lastRequestTxVersion: 2,
      preferredTxVersion: 2,
      heartbeatGapMs: 200,
      missingHud: true,
      now: 1_000 + HUD_RATE_MISSING_RETRY_MS,
      requestCount: 2,
    })).toBe(true);
    expect(shouldReRequestHudRates({
      lastRequestAt: 1_000,
      lastRequestTxVersion: 2,
      preferredTxVersion: 2,
      heartbeatGapMs: 200,
      missingHud: true,
      now: 1_000 + HUD_RATE_MISSING_RETRY_MS,
      requestCount: HUD_RATE_MAX_REQUESTS,
    })).toBe(false);
    expect(shouldReRequestHudRates({
      lastRequestAt: 1_000,
      lastRequestTxVersion: 2,
      preferredTxVersion: 2,
      heartbeatGapMs: 200,
      missingHud: false,
      now: 8_000,
      requestCount: 1,
    })).toBe(false);
    const ids = hudMessageRateTargets().messages.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([
      MSG_SYS_STATUS,
      MSG_ATTITUDE,
      MSG_GLOBAL_POSITION_INT,
      MSG_VFR_HUD,
      MSG_GPS_RAW_INT,
    ]));
    expect(core).toContain('maybeRequestHudRatesOnHeartbeat()');
    expect(core).toContain('conn.maybeRequestHudRatesOnHeartbeat()');
    expect(core).toContain('scheduleHudMessageRatesRetry(2000)');
    const method = core.slice(core.indexOf('maybeRequestHudRatesOnHeartbeat()'), core.indexOf('maybeRequestHudRatesOnHeartbeat()') + 900);
    expect(method).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b|DO_REPOSITION|NAV_LAND|MAV_CMD_COMPONENT_ARM/);
  });
});

describe('Mission UI copy stays in sync with the honesty helper', () => {
  it('uses no-link vs connected-waiting Hebrew on tapes and tiles', () => {
    expect(js).toContain(`const VLC_TOOLTIP_NO_LINK = '${HUD_REASON_NO_LINK}'`);
    expect(js).toContain(`const VLC_TOOLTIP_ALT_WAITING = '${HUD_REASON_ALT_WAITING}'`);
    expect(js).toContain(`const VLC_TOOLTIP_SPD_WAITING = '${HUD_REASON_SPD_WAITING}'`);
    expect(js).toContain('function hudFieldHonestyTitle(');
    expect(js).toContain('function airspeedTileHonestyTitle(');
    expect(js).toContain('pfdHudWaitHint');
    expect(html).toMatch(/id="hudAltitude"[^>]*title="אין קישור"/);
    expect(html).toMatch(/id="hudAirspeed"[^>]*title="אין קישור"/);
    expect(html).toMatch(/id="pfdAltVal"[^>]*title="אין קישור"/);
    expect(html).toMatch(/id="pfdAirspeedVal"[^>]*title="אין קישור"/);
    expect(html).toContain('id="pfdHudWaitHint"');
    expect(js).toContain('classifyEkfGpsStatusText');
    expect(js).toContain('formatGpsHudReadout');
  });
});
