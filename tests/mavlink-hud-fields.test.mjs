import { describe, it, expect } from 'vitest';
import {
  composeHudTelemetryFields,
  HUD_MAX_SOURCE_SPREAD_MS,
  HUD_MAX_BOOT_SKEW_MS,
} from '../lib/mavlink-hud-fields.mjs';

const baseWall = 1_000_000;

describe('composeHudTelemetryFields', () => {
  it('falls back from GLOBAL_POSITION when VFR missing (proxy IAS)', () => {
    const mavConn = {
      lastVfrHud: null,
      lastGlobalPos: {
        relativeAltM: 55,
        groundspeedMs: 22,
        hdgDeg: 180,
        timeBootMs: 100,
        receivedWallMs: baseWall,
      },
      lastAttitude: { yawDeg: -90, timeBootMs: 100, receivedWallMs: baseWall },
    };
    const h = composeHudTelemetryFields(mavConn);
    expect(h.altitude).toBe(55);
    expect(h.groundspeed).toBe(22);
    expect(h.heading).toBe(180);
    expect(h.airspeed).toBe(22);
    expect(h.airspeedIsGroundspeedProxy).toBe(true);
    expect(h.hudTimeSkewWarn).toBe(false);
  });

  it('uses attitude yaw when no heading elsewhere', () => {
    const mavConn = {
      lastVfrHud: { receivedWallMs: baseWall },
      lastGlobalPos: { lat: 1, lon: 2, receivedWallMs: baseWall },
      lastAttitude: { yawDeg: -90, receivedWallMs: baseWall },
    };
    const h = composeHudTelemetryFields(mavConn);
    expect(h.heading).toBe(270);
    expect(h.airspeedIsGroundspeedProxy).toBe(false);
  });

  it('prefers pitot/VFR airspeed and never marks proxy', () => {
    const mavConn = {
      lastVfrHud: {
        airspeed: 28,
        groundspeed: 31,
        receivedWallMs: baseWall,
      },
      lastGlobalPos: {
        groundspeedMs: 99,
        relativeAltM: 10,
        receivedWallMs: baseWall,
      },
      lastAttitude: { yawDeg: 0, receivedWallMs: baseWall },
    };
    const h = composeHudTelemetryFields(mavConn);
    expect(h.airspeed).toBe(28);
    expect(h.groundspeed).toBe(31);
    expect(h.airspeedIsGroundspeedProxy).toBe(false);
  });

  it('sets hudTimeSkewWarn when receive timestamps diverge', () => {
    const mavConn = {
      lastVfrHud: { groundspeed: 20, receivedWallMs: baseWall },
      lastGlobalPos: {
        relativeAltM: 40,
        groundspeedMs: 20,
        receivedWallMs: baseWall + HUD_MAX_SOURCE_SPREAD_MS + 80,
      },
      lastAttitude: {
        yawDeg: 0,
        pitchDeg: 1,
        rollDeg: 0,
        receivedWallMs: baseWall,
      },
    };
    const h = composeHudTelemetryFields(mavConn);
    expect(h.hudTimeSkewWarn).toBe(true);
    expect(h.hudTimeSkewMs).toBeGreaterThan(HUD_MAX_SOURCE_SPREAD_MS);
  });

  it('blocks blending GLOBAL nav fields when boot timestamps diverge', () => {
    const mavConn = {
      lastVfrHud: null,
      lastGlobalPos: {
        relativeAltM: 99,
        groundspeedMs: 18,
        hdgDeg: 45,
        timeBootMs: 500_000,
        receivedWallMs: baseWall,
      },
      lastAttitude: {
        yawDeg: 200,
        timeBootMs: 500_000 + HUD_MAX_BOOT_SKEW_MS + 400,
        receivedWallMs: baseWall,
      },
    };
    const h = composeHudTelemetryFields(mavConn);
    expect(h.groundspeed).toBeNull();
    expect(h.airspeed).toBeNull();
    expect(h.airspeedIsGroundspeedProxy).toBe(false);
    expect(h.altitude).toBe(99);
    expect(h.heading).toBe(200);
  });
});
