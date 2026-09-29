/**
 * Automated SITL guardrails for follow-target.
 * A scripted ArduPlane vehicle (home, fence, mode, RC) is the stand-in the
 * console controller flies. No command leaves this process. A live arduplane
 * binary is optional and runs only with RUN_SITL_E2E=1.
 */
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { registerFollowTargetApi } from '../lib/routes/follow-target-api.mjs';
import {
  FOLLOW_LIMITS,
  createFollowController,
  destinationPoint,
  distanceM,
  followTargetFlagOn,
  planFollow,
} from '../lib/follow-target.mjs';

const HOME = { lat: 32.0853, lon: 34.7818 };

function at(bearing, distance) {
  return destinationPoint(HOME.lat, HOME.lon, bearing, distance);
}

function vehicle(overrides = {}) {
  const aircraft = at(0, 400);
  return {
    connected: true,
    simulator: true,
    lat: aircraft.lat,
    lon: aircraft.lon,
    altAglM: 120,
    homeLat: HOME.lat,
    homeLon: HOME.lon,
    customMode: 15,
    params: {},
    rcChannels: { chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1500, chan8_raw: 1500 },
    ...overrides,
  };
}

function harness({ enabled = true, t = 1_000_000 } = {}) {
  const calls = { fly: [], rtl: [] };
  let on = enabled;
  let time = t;
  const link = {
    flyTo(lat, lon, altM) { calls.fly.push({ lat, lon, altM }); },
    rtl() { calls.rtl.push(time); },
  };
  const controller = createFollowController({
    link,
    enabled: () => on,
    now: () => time,
  });
  return {
    calls,
    controller,
    setEnabled(v) { on = v; },
    setTime(v) { time = v; },
    time: () => time,
  };
}

function commands(calls) {
  return { fly: calls.fly.length, rtl: calls.rtl.length };
}

describe('follow-target SITL guardrails', () => {
  it('is off unless FOLLOW_TARGET_SITL is explicitly on', () => {
    expect(followTargetFlagOn({})).toBe(false);
    expect(followTargetFlagOn({ FOLLOW_TARGET_SITL: '0' })).toBe(false);
    expect(followTargetFlagOn({ FOLLOW_TARGET_SITL: '1' })).toBe(true);
    expect(FOLLOW_LIMITS.minAglM).toBe(60);
    expect(FOLLOW_LIMITS.maxHomeM).toBe(2000);
    expect(FOLLOW_LIMITS.orbitRadiusM).toBe(150);
    expect(FOLLOW_LIMITS.targetLossMs).toBe(60_000);
  });

  it('sends no command when the flag is off', () => {
    const h = harness({ enabled: false });
    const target = at(0, 500);
    const result = h.controller.selectTarget({ lat: target.lat, lon: target.lon, altM: 80, source: 'map' }, vehicle());
    expect(result.ok).toBe(false);
    expect(result.messageHe).toMatch(/כבוי/);
    expect(commands(h.calls)).toEqual({ fly: 0, rtl: 0 });
    h.controller.tick(vehicle());
    expect(commands(h.calls)).toEqual({ fly: 0, rtl: 0 });
  });

  it('sends no command to a real vehicle even when the flag is on', () => {
    const h = harness();
    const target = at(0, 500);
    const result = h.controller.selectTarget(
      { lat: target.lat, lon: target.lon, altM: 80, source: 'map' },
      vehicle({ simulator: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.messageHe).toMatch(/סימולטור/);
    expect(commands(h.calls)).toEqual({ fly: 0, rtl: 0 });
    h.controller.tick(vehicle({ simulator: false }));
    expect(commands(h.calls)).toEqual({ fly: 0, rtl: 0 });
  });

  it('rejects altitude under 60 m AGL and never sends it', () => {
    const h = harness();
    const target = at(0, 500);
    const result = h.controller.selectTarget(
      { lat: target.lat, lon: target.lon, altM: 59, source: 'map' },
      vehicle(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('below_agl');
    expect(h.calls.fly.every((c) => c.altM >= 60)).toBe(true);
    expect(commands(h.calls).fly).toBe(0);
  });

  it('rejects a target beyond 2 km from home', () => {
    const h = harness();
    const target = at(0, 2100);
    const aircraft = at(0, 400);
    const result = h.controller.selectTarget(
      { lat: target.lat, lon: target.lon, altM: 80, source: 'map' },
      vehicle({ lat: aircraft.lat, lon: aircraft.lon }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('beyond_home');
    expect(commands(h.calls)).toEqual({ fly: 0, rtl: 0 });
  });

  it('rejects a target outside the existing geofence radius and polygon', () => {
    const h = harness();
    const outsideRadius = at(0, 500);
    const radius = h.controller.selectTarget(
      { lat: outsideRadius.lat, lon: outsideRadius.lon, altM: 80, source: 'map' },
      vehicle({ params: { FENCE_ENABLE: 1, FENCE_TYPE: 2, FENCE_RADIUS: 300 } }),
    );
    expect(radius.ok).toBe(false);
    expect(radius.reasons).toContain('beyond_geofence');

    const outsidePoly = at(0, 1200);
    const polygon = [45, 135, 225, 315].map((bearing) => destinationPoint(HOME.lat, HOME.lon, bearing, 700));
    const poly = h.controller.selectTarget(
      { lat: outsidePoly.lat, lon: outsidePoly.lon, altM: 80, source: 'map' },
      vehicle({
        params: { FENCE_ENABLE: 1, FENCE_TYPE: 4, fencePolygon: polygon },
      }),
    );
    expect(poly.ok).toBe(false);
    expect(poly.reasons).toContain('outside_polygon');
    expect(commands(h.calls)).toEqual({ fly: 0, rtl: 0 });
  });

  it('rejects an altitude the geofence cannot contain', () => {
    const h = harness();
    const target = at(0, 200);
    const result = h.controller.selectTarget(
      { lat: target.lat, lon: target.lon, altM: 60, source: 'map' },
      vehicle({ params: { FENCE_ENABLE: 1, FENCE_TYPE: 1, FENCE_ALT_MAX: 50 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('fence_alt');
    expect(commands(h.calls).fly).toBe(0);
  });

  it('orbits at 150 m, at least 60 m AGL, inside home and the fence', () => {
    const h = harness();
    const target = at(0, 1900);
    const aircraft = at(0, 1700);
    const result = h.controller.selectTarget(
      { lat: target.lat, lon: target.lon, altM: 70, source: 'map' },
      vehicle({
        lat: aircraft.lat,
        lon: aircraft.lon,
        params: { FENCE_ENABLE: 1, FENCE_TYPE: 11, FENCE_RADIUS: 2000, FENCE_ALT_MIN: 80 },
      }),
    );
    expect(result.ok).toBe(true);
    expect(h.calls.fly).toHaveLength(1);
    const sent = h.calls.fly[0];
    expect(sent.altM).toBeGreaterThanOrEqual(80);
    expect(sent.altM).toBeGreaterThanOrEqual(60);
    const radius = distanceM(target.lat, target.lon, sent.lat, sent.lon);
    expect(radius).toBeGreaterThan(148);
    expect(radius).toBeLessThan(152);
    expect(distanceM(HOME.lat, HOME.lon, sent.lat, sent.lon)).toBeLessThanOrEqual(2000);
    expect(distanceM(HOME.lat, HOME.lon, sent.lat, sent.lon)).toBeLessThanOrEqual(2000);
  });

  it('commands RTL once after 60 s without a target and not before', () => {
    const h = harness({ t: 10_000 });
    const target = at(90, 300);
    h.controller.selectTarget({ lat: target.lat, lon: target.lon, altM: 90, source: 'map' }, vehicle());
    h.setTime(10_000 + 59_999);
    h.controller.tick(vehicle());
    expect(h.calls.rtl).toHaveLength(0);
    h.setTime(10_000 + 60_000);
    const lost = h.controller.tick(vehicle());
    expect(lost.state).toBe('rtl');
    expect(h.calls.rtl).toHaveLength(1);
    h.setTime(10_000 + 120_000);
    h.controller.tick(vehicle());
    expect(h.calls.rtl).toHaveLength(1);
    expect(h.calls.fly.every((c) => c.altM >= 60)).toBe(true);
  });

  it('resets the loss timer when the target is seen again', () => {
    const h = harness({ t: 5_000 });
    const target = at(90, 300);
    const body = { lat: target.lat, lon: target.lon, altM: 90, source: 'detection' };
    h.controller.selectTarget(body, vehicle());
    h.setTime(5_000 + 50_000);
    h.controller.selectTarget(body, vehicle());
    h.setTime(5_000 + 60_000);
    h.controller.tick(vehicle());
    expect(h.calls.rtl).toHaveLength(0);
    h.setTime(5_000 + 50_000 + 60_000);
    h.controller.tick(vehicle());
    expect(h.calls.rtl).toHaveLength(1);
  });

  it('cancels immediately on an RC mode change and sends nothing more', () => {
    const h = harness();
    const target = at(90, 300);
    h.controller.selectTarget({ lat: target.lat, lon: target.lon, altM: 90, source: 'map' }, vehicle());
    const before = commands(h.calls);
    expect(before.fly).toBe(1);
    const moved = vehicle({
      rcChannels: { chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1500, chan8_raw: 1800 },
    });
    const cancelled = h.controller.tick(moved);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.messageHe).toMatch(/שלט RC/);
    h.controller.tick(moved);
    h.controller.tick(vehicle());
    expect(commands(h.calls)).toEqual({ fly: before.fly, rtl: 0 });
  });

  it('cancels immediately when the flight mode leaves GUIDED', () => {
    const h = harness();
    const target = at(90, 300);
    h.controller.selectTarget({ lat: target.lat, lon: target.lon, altM: 90, source: 'map' }, vehicle({ customMode: 15 }));
    const before = h.calls.fly.length;
    const cancelled = h.controller.tick(vehicle({ customMode: 5 }));
    expect(cancelled.cancelled).toBe('mode');
    expect(h.calls.rtl).toHaveLength(0);
    h.controller.tick(vehicle({ customMode: 5 }));
    expect(h.calls.fly).toHaveLength(before);
  });

  it('drops a live track when the link stops being a simulator', () => {
    const h = harness();
    const target = at(90, 300);
    h.controller.selectTarget({ lat: target.lat, lon: target.lon, altM: 90, source: 'map' }, vehicle());
    const dropped = h.controller.tick(vehicle({ simulator: false }));
    expect(dropped.state).toBe('cancelled');
    expect(h.calls.rtl).toHaveLength(0);
    const fly = h.calls.fly.length;
    h.controller.tick(vehicle({ simulator: false }));
    expect(h.calls.fly).toHaveLength(fly);
  });

  it('holds the waypoint until the link reports GUIDED', () => {
    const calls = { fly: 0, prep: 0 };
    const target = at(90, 300);
    const controller = createFollowController({
      enabled: () => true,
      link: {
        prepare() {
          calls.prep += 1;
          return calls.prep > 1;
        },
        flyTo() { calls.fly += 1; },
      },
    });
    controller.selectTarget({ lat: target.lat, lon: target.lon, altM: 90, source: 'map' }, vehicle());
    expect(calls.fly).toBe(0);
    controller.tick(vehicle());
    expect(calls.prep).toBe(2);
    expect(calls.fly).toBe(1);
  });

  it('plans a legal orbit only', () => {
    const target = at(0, 600);
    const aircraft = at(0, 400);
    const plan = planFollow({
      vehicle: vehicle({ lat: aircraft.lat, lon: aircraft.lon }),
      target: { lat: target.lat, lon: target.lon, altM: 60 },
    });
    expect(plan.ok).toBe(true);
    expect(plan.altM).toBeGreaterThanOrEqual(60);
    expect(distanceM(target.lat, target.lon, plan.waypoint.lat, plan.waypoint.lon)).toBeCloseTo(150, 0);
  });
});

describe('follow-target API stays idle for a real link', () => {
  const servers = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it('rejects the target and reports the sim-only banner', async () => {
    const calls = { fly: 0, rtl: 0 };
    const app = express();
    app.use(express.json());
    registerFollowTargetApi(app, {
      followLoop: false,
      getVehicle: () => vehicle({ simulator: false, connected: true }),
      followController: createFollowController({
        enabled: () => true,
        link: {
          flyTo() { calls.fly += 1; },
          rtl() { calls.rtl += 1; },
        },
      }),
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = server.address().port;
    const status = await fetch(`http://127.0.0.1:${port}/api/follow-target/status`).then((r) => r.json());
    expect(status.simulatorOnly).toBe(true);
    expect(status.bannerHe).toMatch(/סימולטור/);
    const target = at(90, 300);
    const posted = await fetch(`http://127.0.0.1:${port}/api/follow-target/target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: target.lat, lon: target.lon, altM: 80, source: 'map' }),
    });
    expect(posted.status).toBe(409);
    expect(calls).toEqual({ fly: 0, rtl: 0 });
  });
});
