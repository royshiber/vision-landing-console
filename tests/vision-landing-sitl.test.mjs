/**
 * Vision landing stays inside SITL.
 * A scripted approach is the vehicle. Frames are the real MAVLink bytes.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MavlinkConnection, parseMissionCurrent } from '../lib/mavlink-connection.mjs';
import { createRunwayController } from '../lib/runway-awareness.mjs';
import {
  MAV_CMD_DO_GO_AROUND,
  MAV_CMD_NAV_LAND,
  arduPlaneRepositionMode,
  missionLandingPhase,
  opticalClimbTarget,
  opticalGlideTarget,
  runwayConfidence,
} from '../lib/vision-landing.mjs';

const STRIP = {
  detected: true,
  offset_m: 0,
  offset_norm: 0,
  heading_error_deg: 5,
  confidence: { offset: 0.91, heading: 0.84, along: 0.7 },
  hazards: [],
};

function approach(overrides = {}) {
  return {
    simulator: true,
    connected: true,
    customMode: 10,
    altAglM: 40,
    distToLandM: 700,
    lat: 32.02,
    lon: 34.82,
    missionCurrent: 3,
    missionItems: [
      { seq: 1, command: 16, lat: 32.04, lon: 34.84 },
      { seq: 2, command: 16, lat: 32.02, lon: 34.82 },
      { seq: 3, command: MAV_CMD_NAV_LAND, lat: 32.01, lon: 34.81 },
    ],
    rcChannels: {
      chan1_raw: 1500,
      chan2_raw: 1500,
      chan3_raw: 1500,
      chan4_raw: 1500,
      chan5_raw: 1500,
      chan6_raw: 1500,
      chan7_raw: 1500,
      chan8_raw: 1500,
    },
    ...overrides,
  };
}

function wire(simulator = true) {
  const frames = [];
  const conn = Object.create(MavlinkConnection.prototype);
  conn.frames = frames;
  conn._send = (frame) => { frames.push(frame); };
  conn._seq = 4;
  conn._preferredTxVersion = 2;
  conn.connected = true;
  conn.sysId = 7;
  conn.fcTargetCompId = 1;
  conn.simulatorDetection = () => ({ simulator });
  conn.getStatus = () => ({ simulator });
  return {
    frames,
    conn,
    sendGuidance(cmd) {
      if (!Number.isFinite(Number(conn.lastHeartbeatWallMs))) conn.lastHeartbeatWallMs = Date.now();
      if (!Number.isFinite(Number(conn.lastCustomMode)) && cmd && cmd.expectMode != null && cmd.expectMode !== '') {
        conn.lastCustomMode = Number(cmd.expectMode);
      }
      try {
        let out;
        if (cmd.kind === 'GO_AROUND') out = conn.sendRunwayGoAround(cmd);
        else if (
          cmd.kind === 'ENTER_GUIDED' || cmd.kind === 'ENTER_AUTO' || cmd.kind === 'RTL'
          || cmd.kind === 'REPOSITION' || cmd.kind === 'DO_LAND_START' || cmd.kind === 'SET_CURRENT'
        ) out = conn.sendRunwayOptical(cmd);
        else out = conn.sendRunwayRollOverride(cmd.rollPwm, { release: cmd.release === true, expectMode: cmd.expectMode });
        const ack = typeof conn.ackFor === 'function' ? conn.ackFor(cmd) : undefined;
        if (cmd.kind === 'ENTER_AUTO') {
          const result = ack == null ? 0 : Number(ack.result);
          const named = ack && Object.prototype.hasOwnProperty.call(ack, 'heartbeatMode');
          const hb = named ? Number(ack.heartbeatMode) : 10;
          if ((result === 0 || result === 5) && hb === 10) {
            conn.lastCustomMode = 10;
            conn.lastHeartbeatWallMs = Date.now();
          } else if (named && Number.isFinite(hb)) {
            conn.lastCustomMode = hb;
            conn.lastHeartbeatWallMs = Date.now();
          }
        }
        const body = ack === undefined ? { sent: true } : { sent: true, ack };
        if (ack && Object.prototype.hasOwnProperty.call(ack, 'heartbeatMode')) body.heartbeatMode = ack.heartbeatMode;
        if (out && typeof out.then === 'function') return out.then(() => body);
        return body;
      } catch (err) {
        return { sent: false, reason: err?.code || 'not_sitl' };
      }
    },
  };
}

function session(extraLimits = {}) {
  let now = 50_000;
  const link = wire(true);
  const controller = createRunwayController({
    link,
    now: () => now,
    limits: { holdMs: 2000, ...extraLimits },
  });
  controller.setLevel({ level: 3 });
  return {
    link,
    controller,
    at(ms) { now = ms; },
  };
}

function pymavlinkInstalled() {
  return spawnSync('python3', ['-c', 'import pymavlink'], { encoding: 'utf8' }).status === 0;
}

function decode(frame) {
  const script = [
    'import sys',
    'from pymavlink.dialects.v20 import common as mav',
    'parser = mav.MAVLink(None)',
    'msg = parser.decode(bytearray(bytes.fromhex(sys.argv[1])))',
    'kind = msg.get_type()',
    'if kind == "RC_CHANNELS_OVERRIDE":',
    '    chans = [getattr(msg, f"chan{i}_raw") for i in range(1, 19)]',
    '    print(kind, msg.target_system, msg.target_component, ",".join(str(c) for c in chans))',
    'elif kind == "SET_MODE":',
    '    print(kind, msg.target_system, msg.base_mode, msg.custom_mode)',
    'elif kind == "COMMAND_INT":',
    '    print(kind, msg.target_system, msg.target_component, msg.command, ",".join(str(n) for n in (msg.param2, msg.x, msg.y, msg.z, msg.frame)))',
    'elif kind == "MISSION_SET_CURRENT":',
    '    print(kind, msg.target_system, msg.target_component, msg.seq, "0")',
    'else:',
    '    params = [getattr(msg, f"param{i}") for i in range(1, 8)]',
    '    print(kind, msg.target_system, msg.target_component, msg.command, ",".join(str(p) for p in params))',
  ].join('\n');
  const run = spawnSync('python3', ['-c', script, frame.toString('hex')], { encoding: 'utf8' });
  expect(run.status, run.stderr || run.stdout).toBe(0);
  const [type, target, comp, third, rest] = run.stdout.trim().split(' ');
  if (type === 'RC_CHANNELS_OVERRIDE') {
    return {
      type,
      target: Number(target),
      comp: Number(comp),
      rest: third.split(',').map(Number),
    };
  }
  if (type === 'SET_MODE') {
    return { type, target: Number(target), baseMode: Number(comp), customMode: Number(third) };
  }
  if (type === 'COMMAND_INT') {
    const [param2, lat, lon, alt, frame] = rest.split(',').map(Number);
    return { type, target: Number(target), comp: Number(comp), third: Number(third), param2, lat, lon, alt, frame };
  }
  if (type === 'MISSION_SET_CURRENT') {
    return { type, target: Number(target), comp: Number(comp), third: Number(third) };
  }
  return {
    type,
    target: Number(target),
    comp: Number(comp),
    third: Number(third),
    rest: rest.split(',').map(Number),
  };
}

describe('vision landing phase', () => {
  it('keeps a DO_REPOSITION that arrives in FBWA from changing mode', () => {
    expect(arduPlaneRepositionMode(5, 0)).toEqual({ mode: 5, result: 4 });
    expect(arduPlaneRepositionMode(10, 0)).toEqual({ mode: 10, result: 4 });
    expect(arduPlaneRepositionMode(5, 1)).toEqual({ mode: 15, result: 0 });
    expect(arduPlaneRepositionMode(15, 0)).toEqual({ mode: 15, result: 0 });
  });

  it('climbs at least 30 m and never below the aircraft', () => {
    const low = opticalClimbTarget(STRIP, { lat: 32, lon: 34, altAglM: 20, headingDeg: 90 });
    expect(low.rtl).toBe(false);
    expect(low.altM).toBe(60);
    expect(low.altM).toBeGreaterThan(20);
    const high = opticalClimbTarget(STRIP, { lat: 32, lon: 34, altAglM: 90, headingDeg: 90 });
    expect(high.altM).toBe(120);
    expect(high.altM).toBeGreaterThan(90);
    expect(opticalClimbTarget(STRIP, { lat: 32, lon: 34, altAglM: null, headingDeg: 90 }).rtl).toBe(true);
  });

  it('keeps the 3 degree slope until the early handoff', () => {
    const glide = opticalGlideTarget({
      lat: 32.01 + (400 / 111320),
      lon: 34.81,
      altAglM: 40,
      thresholdLat: 32.01,
      thresholdLon: 34.81,
    });
    const slope = 400 * Math.tan((3 * Math.PI) / 180);
    expect(glide.handoff).toBe(false);
    expect(glide.altM).toBeGreaterThan(slope - 1);
    expect(glide.altM).toBeLessThan(slope + 1);
    const near = opticalGlideTarget({
      lat: 32.01 + (80 / 111320),
      lon: 34.81,
      altAglM: 40,
      thresholdLat: 32.01,
      thresholdLon: 34.81,
    });
    expect(near.handoff).toBe(true);
    expect(near.altM).toBeGreaterThan(4);
    expect(near.altM).toBeLessThan(6);
  });

  it('engages only when the active mission item is NAV_LAND', () => {
    const items = approach().missionItems;
    expect(missionLandingPhase(items, 2).active).toBe(false);
    expect(missionLandingPhase(items, 3).active).toBe(true);
    expect(missionLandingPhase(items, 1).active).toBe(false);
    expect(missionLandingPhase([{ seq: 1, command: 16 }, { seq: 2, command: 16 }], 2).active).toBe(false);
    expect(runwayConfidence(STRIP)).toBeGreaterThanOrEqual(0.7);
    expect(runwayConfidence({ detected: false, confidence: { offset: 1, heading: 1 } })).toBe(0);
    const seq = Buffer.alloc(2);
    seq.writeUInt16LE(2, 0);
    expect(parseMissionCurrent(seq)).toEqual({ seq: 2 });
    expect(parseMissionCurrent(Buffer.alloc(0))).toBeNull();
  });
});

describe('vision landing SITL e2e', () => {
  const PYMAVLINK_SKIP = 'pymavlink is not installed. Install pymavlink to decode the vision-landing frames.';

  it('steers only roll after the confidence dwell on a clean approach', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const offCourse = run.controller.tick({
      estimate: STRIP,
      vehicle: approach({ missionCurrent: 1 }),
    });
    expect(offCourse.sentNow).toBe(0);
    expect(offCourse.vision.labelHe).toBe('ממתין');

    const early = run.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(early.sentNow).toBe(0);
    expect(early.vision.labelHe).toBe('ממתין');
    expect(run.link.frames).toHaveLength(0);

    run.at(51_999);
    const waiting = run.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(waiting.sentNow).toBe(0);
    expect(waiting.vision.state).toBe('waiting');

    run.at(52_000);
    const live = run.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(live.sentNow).toBe(1);
    expect(live.vision.labelHe).toBe('נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה');
    expect(run.link.frames).toHaveLength(1);
    const decoded = decode(run.link.frames[0]);
    expect(decoded.type).toBe('RC_CHANNELS_OVERRIDE');
    expect(decoded.target).toBe(7);
    expect(decoded.comp).toBe(1);
    expect(decoded.rest[0]).toBeGreaterThan(1500);
    expect(decoded.rest[0]).toBeLessThanOrEqual(1900);
    expect(decoded.rest.slice(1).every((value) => value === 0)).toBe(true);

    run.at(53_000);
    const again = run.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(again.sentNow).toBe(1);
    expect(run.link.frames).toHaveLength(2);
    expect(decode(run.link.frames[1]).type).toBe('RC_CHANNELS_OVERRIDE');
  });

  it('releases once when the runway drops below the confidence threshold', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(60_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(62_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.labelHe).toBe('נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה');

    const lost = run.controller.tick({
      estimate: { ...STRIP, detected: false, confidence: { offset: 0.2, heading: 0.2 } },
      vehicle: approach(),
    });
    expect(lost.vision.labelHe).toBe('שוחרר');
    expect(lost.sentNow).toBe(1);
    const decoded = decode(run.link.frames.at(-1));
    expect(decoded.type).toBe('RC_CHANNELS_OVERRIDE');
    expect(decoded.rest.every((value) => value === 0)).toBe(true);

    const again = run.controller.tick({
      estimate: { ...STRIP, detected: false },
      vehicle: approach(),
    });
    expect(again.sentNow).toBe(0);
    expect(run.link.frames.filter((frame) => decode(frame).rest.every((value) => value === 0))).toHaveLength(1);

    const low = run.controller.tick({
      estimate: { ...STRIP, confidence: { offset: 0.4, heading: 0.9 } },
      vehicle: approach(),
    });
    expect(low.sentNow).toBe(0);
    expect(low.vision.labelHe).toBe('שוחרר');
  });

  it('commands one go-around for a hazard and for a large offset below the minimum altitude', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(70_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(72_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.labelHe).toBe('נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה');
    expect(run.link.frames).toHaveLength(1);

    const hazard = run.controller.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'person', label_he: 'אדם' }] },
      vehicle: approach(),
    });
    expect(hazard.vision.labelHe).toBe('סבוב מחדש');
    expect(hazard.sentNow).toBe(2);
    const kinds = run.link.frames.slice(1).map((frame) => decode(frame));
    expect(kinds.map((row) => row.type)).toEqual(['RC_CHANNELS_OVERRIDE', 'COMMAND_LONG']);
    expect(kinds[0].rest.every((value) => value === 0)).toBe(true);
    expect(kinds[1].third).toBe(MAV_CMD_DO_GO_AROUND);
    expect(kinds[1].target).toBe(7);
    expect(kinds[1].comp).toBe(1);
    expect(kinds[1].rest.every((value) => value === 0)).toBe(true);

    const repeat = run.controller.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'person', label_he: 'אדם' }] },
      vehicle: approach(),
    });
    expect(repeat.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(3);

    const fresh = session();
    const wide = fresh.controller.tick({
      estimate: { ...STRIP, offset_m: 18 },
      vehicle: approach({ altAglM: 12 }),
    });
    expect(wide.vision.labelHe).toBe('סבוב מחדש');
    expect(wide.sentNow).toBe(1);
    const abort = decode(fresh.link.frames[0]);
    expect(abort.type).toBe('COMMAND_LONG');
    expect(abort.third).toBe(191);
    fresh.controller.tick({
      estimate: { ...STRIP, offset_m: 18 },
      vehicle: approach({ altAglM: 12 }),
    });
    expect(fresh.link.frames).toHaveLength(1);

    const high = session();
    high.at(80_000);
    const steered = high.controller.tick({
      estimate: { ...STRIP, offset_m: 18, heading_error_deg: 0 },
      vehicle: approach({ altAglM: 40 }),
    });
    expect(steered.sentNow).toBe(0);
    high.at(82_000);
    const later = high.controller.tick({
      estimate: { ...STRIP, offset_m: 18, heading_error_deg: 0 },
      vehicle: approach({ altAglM: 40 }),
    });
    expect(later.vision.labelHe).toBe('נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה');
    expect(decode(high.link.frames[0]).type).toBe('RC_CHANNELS_OVERRIDE');
    expect(decode(high.link.frames[0]).rest[1]).toBe(0);
    expect(decode(high.link.frames[0]).rest[2]).toBe(0);
  });

  it('keeps guiding when the sticks move and cancels once when AUTO is left', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(140_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(142_000);
    const active = run.controller.tick({ estimate: STRIP, vehicle: approach({
      rcChannels: {
        chan1_raw: 1900, chan2_raw: 1200, chan3_raw: 1100, chan4_raw: 1800,
        chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 2000, chan8_raw: 1500,
      },
    }) });
    expect(active.vision.state).toBe('active');
    expect(active.vision.reason).toBe('guide');
    expect(active.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.slice(1).every((value) => value === 0)).toBe(true);

    const before = run.link.frames.length;
    const left = run.controller.tick({ estimate: STRIP, vehicle: approach({ customMode: 5 }) });
    expect(left.vision.state).toBe('released');
    expect(left.vision.reason).toBe('mode');
    expect(left.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach({ customMode: 5 }) }).sentNow).toBe(0);
    expect(run.link.frames.length).toBe(before + 1);
    run.at(146_000);
    const back = run.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(back.vision.state).toBe('released');
    expect(back.sentNow).toBe(0);
    expect(back.vision.labelHe).toBe('שוחרר');
  });

  it('does not engage on the waypoint before NAV_LAND', () => {
    const run = session();
    run.at(10_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach({ missionCurrent: 2 }) });
    run.at(12_000);
    const row = run.controller.tick({ estimate: STRIP, vehicle: approach({ missionCurrent: 2 }) });
    expect(row.vision.state).toBe('waiting');
    expect(row.vision.reason).toBe('phase');
    expect(row.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(0);
  });

  it('releases once when the link drops and ignores RC failsafe', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(30_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(32_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.state).toBe('active');
    const lost = run.controller.tick({ estimate: STRIP, vehicle: approach({ connected: false }) });
    expect(lost.vision.reason).toBe('link');
    expect(lost.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach({ connected: false }) }).sentNow).toBe(0);

    const unhealthy = session();
    const vehicle = approach({
      sysSensors: { present: 0x10000, enabled: 0x10000, health: 0, receivedWallMs: 40_000 },
      rcChannels: {
        chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
        chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1500, chan8_raw: 1500,
        chancount: 0, rssi: 0, time_boot_ms: 40_000,
      },
    });
    unhealthy.at(40_000);
    unhealthy.controller.tick({ estimate: STRIP, vehicle });
    unhealthy.at(42_000);
    const guided = unhealthy.controller.tick({ estimate: STRIP, vehicle });
    expect(guided.vision.state).toBe('active');
    expect(guided.sentNow).toBe(1);
  });

  it('enters GUIDED from the button and hands the flare to AUTO, SITL only', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const threshold = { lat: 32.01, lon: 34.81 };
    const far = approach({
      customMode: 5,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 12_000,
    });
    run.at(10_000);
    run.controller.note({ estimate: STRIP, vehicle: far });
    const early = run.controller.requestOptical(far);
    expect(early.ok).toBe(false);
    expect(early.reason).toBe('no_runway');
    expect(run.link.frames).toHaveLength(0);

    run.at(12_000);
    run.controller.note({ estimate: STRIP, vehicle: far });
    const armed = run.controller.requestOptical(far);
    expect(armed.ok).toBe(true);
    expect(armed.vision.buttonReady).toBe(true);
    expect(run.link.frames).toHaveLength(1);
    const mode = decode(run.link.frames[0]);
    expect(mode.type).toBe('SET_MODE');
    expect(mode.customMode).toBe(15);
    expect(mode.baseMode).toBe(1);

    const guided = { ...far, customMode: 15, altAt: 12_000 };
    const glide = run.controller.tick({ estimate: { ...STRIP, threshold_lat: threshold.lat, threshold_lon: threshold.lon }, vehicle: guided });
    expect(glide.vision.state).toBe('active');
    expect(glide.vision.reason).toBe('glide');
    expect(glide.sentNow).toBe(1);
    const point = decode(run.link.frames.at(-1));
    expect(point.type).toBe('COMMAND_INT');
    expect(point.third).toBe(192);
    expect(point.lat).toBe(Math.round(threshold.lat * 1e7));
    expect(point.lon).toBe(Math.round(threshold.lon * 1e7));
    expect(point.frame).toBe(3);
    expect(point.param2).toBe(0);
    expect(point.alt).toBeGreaterThan(20);
    expect(point.alt).toBeLessThan(40);
    expect(point.alt).not.toBe(0);

    const near = {
      ...guided,
      lat: 32.01 + (50 / 111320),
      altAglM: 12,
      altAt: 12_000,
    };
    const land = run.controller.tick({
      estimate: { ...STRIP, threshold_lat: threshold.lat, threshold_lon: threshold.lon },
      vehicle: near,
    });
    expect(land.vision.reason).toBe('land');
    expect(land.vision.state).toBe('active');
    expect(land.sentNow).toBe(2);
    const jump = run.link.frames.slice(-2).map((frame) => decode(frame));
    expect(jump.map((row) => row.type)).toEqual(['COMMAND_LONG', 'MISSION_SET_CURRENT']);
    expect(jump[0].third).toBe(176);
    expect(jump[0].rest[0]).toBe(1);
    expect(jump[0].rest[1]).toBe(10);
    expect(jump[1].third).toBe(3);
    expect(run.link.frames.map((frame) => decode(frame)).some((row) => row.third === 21)).toBe(false);
    const before = run.link.frames.length;
    const stayed = run.controller.tick({
      estimate: { ...STRIP, threshold_lat: threshold.lat, threshold_lon: threshold.lon },
      vehicle: { ...near, customMode: 10 },
    });
    expect(stayed.vision.state).toBe('active');
    expect(stayed.vision.reason).toBe('land');
    expect(stayed.sentNow).toBe(0);
    expect(run.link.frames.length).toBe(before);

    const left = run.controller.tick({
      estimate: STRIP,
      vehicle: { ...near, customMode: 5 },
    });
    expect(left.vision.reason).toBe('mode');
    expect(left.vision.state).toBe('released');
    expect(left.sentNow).toBe(0);

    const real = wire(false);
    expect(() => real.conn.sendRunwayOptical({ kind: 'ENTER_GUIDED' })).toThrow();
    try {
      real.conn.sendRunwayOptical({ kind: 'ENTER_GUIDED' });
    } catch (err) {
      expect(err.code).toBe('not_sitl');
    }
    expect(real.frames).toHaveLength(0);
    const off = createRunwayController({
      now: () => 20_000,
      limits: { holdMs: 0 },
      link: real,
    });
    off.note({ estimate: STRIP });
    off.setLevel({ level: 3 });
    const refused = off.requestOptical(approach({ simulator: false }));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('not_sitl');
    expect(real.frames).toHaveLength(0);
  });

  it('goes around when the landing jump is rejected and never sends NAV_LAND', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.link.conn.ackFor = (cmd) => {
      if (cmd.kind === 'DO_LAND_START') return { command: 189, result: 3 };
      if (cmd.kind === 'REPOSITION' && Number(cmd.altM) >= 60) return { command: 192, result: 0 };
      return undefined;
    };
    const threshold = { lat: 32.01, lon: 34.81 };
    const items = [
      { seq: 1, command: 16, lat: 32.02, lon: 34.82 },
      { seq: 2, command: 189, lat: 32.015, lon: 34.815 },
      { seq: 3, command: 21, lat: 32.01, lon: 34.81 },
    ];
    const far = approach({
      customMode: 15,
      missionCurrent: 1,
      missionItems: items,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 22_000,
    });
    run.at(20_000);
    run.controller.note({ estimate: STRIP, vehicle: far });
    run.at(22_000);
    expect(run.controller.requestOptical(far).ok).toBe(true);
    const landed = run.controller.tick({
      estimate: { ...STRIP, threshold_lat: threshold.lat, threshold_lon: threshold.lon },
      vehicle: { ...far, lat: 32.01 + (50 / 111320), altAglM: 18, altAt: 22_000 },
    });
    expect(landed.vision.state).toBe('go_around');
    const rows = run.link.frames.map((frame) => decode(frame));
    expect(rows.some((row) => row.third === 21)).toBe(false);
    expect(rows.some((row) => row.type === 'COMMAND_LONG' && row.third === 176)).toBe(true);
    expect(rows.some((row) => row.type === 'COMMAND_LONG' && row.third === 189)).toBe(true);
    expect(rows.some((row) => row.type === 'COMMAND_LONG' && row.third === 191)).toBe(true);
    expect(rows.some((row) => row.type === 'COMMAND_INT')).toBe(false);
  });

  it('climbs out in GUIDED and falls back to RTL when the climb is refused', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.link.conn.ackFor = (cmd) => (
      cmd.kind === 'REPOSITION' ? { command: 192, result: 4 } : undefined
    );
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.02,
      lon: 34.82,
      altAglM: 40,
      altAt: 32_000,
    });
    run.at(30_000);
    run.controller.note({ estimate: STRIP, vehicle });
    run.at(32_000);
    expect(run.controller.requestOptical({ ...vehicle, altAt: 32_000 }).ok).toBe(true);
    const hazard = run.controller.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'person', label_he: 'אדם' }] },
      vehicle,
    });
    expect(hazard.vision.state).toBe('released');
    expect(hazard.vision.labelHe).toBe('שוחרר');
    const rows = run.link.frames.map((frame) => decode(frame));
    expect(rows.some((row) => row.third === 191)).toBe(false);
    const climb = rows.find((row) => row.type === 'COMMAND_INT');
    expect(climb.third).toBe(192);
    expect(climb.alt).toBeGreaterThanOrEqual(60);
    expect(climb.frame).toBe(3);
    expect(climb.alt).not.toBe(0);
    const rtl = rows.find((row) => row.type === 'SET_MODE' && row.customMode === 11);
    expect(rtl).toBeTruthy();
    expect(rtl.baseMode).toBe(1);
  });

  it('releases on a stale altitude and clamps the glide to the floor', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const threshold = { lat: 32.01, lon: 34.81 };
    const seen = { ...STRIP, threshold_lat: threshold.lat, threshold_lon: threshold.lon };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (450 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 42_000,
    });
    run.at(40_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(42_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    const floored = run.controller.tick({ estimate: seen, vehicle });
    expect(floored.vision.reason).toBe('glide');
    const point = decode(run.link.frames.at(-1));
    const slope = 450 * Math.tan((3 * Math.PI) / 180);
    expect(point.third).toBe(192);
    expect(point.param2).toBe(0);
    expect(point.alt).toBeGreaterThan(slope - 1);
    expect(point.alt).toBeLessThan(slope + 1);
    expect(point.alt).toBeLessThan(40);
    expect(point.alt).not.toBe(0);
    expect(run.link.frames.map((frame) => decode(frame)).some((row) => row.alt === 0)).toBe(false);
    const close = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, lat: 32.01 + (80 / 111320), altAglM: 40, altAt: 42_000 },
    });
    expect(close.vision.reason).toBe('land');
    const handed = decode(run.link.frames.at(-2));
    expect(handed.type).toBe('COMMAND_LONG');
    expect(handed.third).toBe(176);
  });

  it('climbs out of a 5 s GUIDED freeze only after the climb is acknowledged', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const dist = 63 / Math.tan((3 * Math.PI) / 180);
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (dist / 111320),
      lon: 34.81,
      altAglM: 80,
      altAt: 42_000,
    });
    run.at(40_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(42_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    const glide = run.controller.tick({ estimate: seen, vehicle });
    expect(glide.vision.state).toBe('active');
    expect(glide.vision.reason).toBe('glide');
    const held = decode(run.link.frames.at(-1));
    expect(held.third).toBe(192);
    expect(held.param2).toBe(0);
    expect(held.alt).toBeGreaterThan(62);
    expect(held.alt).toBeLessThan(64);
    const frames = run.link.frames.length;
    run.at(47_000);
    const frozen = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAt: 42_000 },
    });
    expect(frozen.vision.state).toBe('go_around');
    expect(frozen.vision.labelHe).toBe('סבוב מחדש');
    expect(run.link.frames).toHaveLength(frames + 1);
    const climb = decode(run.link.frames.at(-1));
    expect(climb.type).toBe('COMMAND_INT');
    expect(climb.third).toBe(192);
    expect(climb.param2).toBe(0);
    expect(climb.frame).toBe(3);
    expect(climb.alt).toBeGreaterThanOrEqual(Math.max(vehicle.altAglM + 30, 60));
    expect(climb.alt).toBeGreaterThan(held.alt);
    run.at(48_000);
    const resumed = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAt: 48_000, customMode: 15 },
    });
    expect(resumed.vision.state).toBe('go_around');
    expect(resumed.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(frames + 1);
    const early = run.controller.requestOptical({ ...vehicle, altAt: 48_000, customMode: 15 });
    expect(early.ok).toBe(false);
    expect(early.reason).toBe('go_around');
    expect(run.link.frames).toHaveLength(frames + 1);
    const high = { ...vehicle, altAglM: climb.alt, altAt: 50_000, customMode: 15 };
    run.at(50_000);
    run.controller.note({ estimate: seen, vehicle: high });
    const pressed = run.controller.requestOptical(high);
    expect(pressed.ok).toBe(true);
    expect(pressed.reason).not.toBe('go_around');
  });

  it('does not wait for a climb that a frozen glide never got acknowledged', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    let repositions = 0;
    run.link.conn.ackFor = (cmd) => {
      if (cmd.kind !== 'REPOSITION') return undefined;
      repositions += 1;
      return { command: 192, result: repositions === 1 ? 0 : 4 };
    };
    const dist = 63 / Math.tan((3 * Math.PI) / 180);
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (dist / 111320),
      lon: 34.81,
      altAglM: 80,
      altAt: 42_000,
    });
    run.at(40_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(42_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    expect(run.controller.tick({ estimate: seen, vehicle }).vision.reason).toBe('glide');
    const frames = run.link.frames.length;
    run.at(47_000);
    const frozen = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAt: 42_000 },
    });
    expect(frozen.vision.state).toBe('released');
    expect(frozen.vision.labelHe).toBe('שוחרר');
    const rows = run.link.frames.slice(frames).map((frame) => decode(frame));
    const climb = rows.find((row) => row.type === 'COMMAND_INT' && row.third === 192);
    expect(climb.param2).toBe(0);
    expect(climb.alt).toBeGreaterThanOrEqual(Math.max(vehicle.altAglM + 30, 60));
    const rtl = rows.find((row) => row.type === 'SET_MODE' && row.customMode === 11);
    expect(rtl).toBeTruthy();
    run.at(49_000);
    const stuck = run.controller.requestOptical({ ...vehicle, altAt: 49_000, customMode: 15 });
    expect(stuck.ok).toBe(false);
    expect(stuck.reason).not.toBe('go_around');
    run.at(51_000);
    const pressed = run.controller.requestOptical({ ...vehicle, altAt: 51_000, customMode: 15 });
    expect(pressed.ok).toBe(true);
    expect(pressed.reason).not.toBe('go_around');
  });

  it('stays released when a 5 s freeze cannot send the climb', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 80,
      altAt: 42_000,
    });
    run.at(40_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(42_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    expect(run.controller.tick({ estimate: seen, vehicle }).vision.reason).toBe('glide');
    const frames = run.link.frames.length;
    run.link.conn.lastCustomMode = 15;
    run.link.conn.lastHeartbeatWallMs = Date.now() - 5000;
    run.at(47_000);
    const frozen = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAt: 42_000 },
    });
    expect(frozen.vision.state).toBe('released');
    expect(frozen.vision.labelHe).toBe('שוחרר');
    expect(frozen.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(frames);
    run.link.conn.lastHeartbeatWallMs = Date.now();
    run.at(49_000);
    const stuck = run.controller.requestOptical({ ...vehicle, altAt: 49_000, customMode: 15 });
    expect(stuck.ok).toBe(false);
    expect(stuck.reason).not.toBe('go_around');
    run.at(51_000);
    const pressed = run.controller.requestOptical({ ...vehicle, altAt: 51_000, customMode: 15 });
    expect(pressed.ok).toBe(true);
    expect(pressed.reason).not.toBe('go_around');
  });

  it('releases a stale heartbeat after the AUTO handover and requires a new press', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const near = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (80 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 50_000,
    });
    run.at(48_000);
    run.controller.note({ estimate: seen, vehicle: near });
    run.at(50_000);
    expect(run.controller.requestOptical({ ...near, lat: 32.01 + (700 / 111320) }).ok).toBe(true);
    const land = run.controller.tick({ estimate: seen, vehicle: near });
    expect(land.vision.reason).toBe('land');
    expect(land.vision.state).toBe('active');
    const stayed = run.controller.tick({
      estimate: seen,
      vehicle: { ...near, customMode: 10, altAt: 50_000 },
    });
    expect(stayed.vision.state).toBe('active');
    expect(stayed.vision.reason).toBe('land');
    expect(stayed.sentNow).toBe(0);
    const frames = run.link.frames.length;
    run.link.conn.lastCustomMode = 10;
    run.link.conn.lastHeartbeatWallMs = Date.now() - 2000;
    const lost = run.controller.tick({
      estimate: seen,
      vehicle: { ...near, customMode: 10, altAt: 50_000 },
    });
    expect(lost.vision.state).toBe('released');
    expect(lost.vision.reason).toBe('stale');
    expect(lost.vision.labelHe).toBe('שוחרר');
    expect(lost.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(frames);
    run.link.conn.lastHeartbeatWallMs = Date.now();
    run.link.conn.lastCustomMode = 10;
    const back = run.controller.tick({
      estimate: seen,
      vehicle: { ...near, customMode: 10, altAt: 50_000 },
    });
    expect(back.vision.state).toBe('released');
    expect(back.vision.reason).toBe('stale');
    expect(back.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(frames);
    const againVehicle = { ...near, lat: 32.01 + (700 / 111320), customMode: 10 };
    const refused = run.controller.requestOptical({ ...againVehicle, altAt: 50_000 });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('no_runway');
    run.at(52_000);
    const pressed = run.controller.requestOptical({ ...againVehicle, altAt: 52_000 });
    expect(pressed.ok).toBe(true);
    expect(run.link.frames).toHaveLength(frames + 1);
  });

  it('sends nothing after a mode change and stays released after link loss', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 52_000,
    });
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    run.at(50_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(52_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    expect(run.controller.tick({ estimate: seen, vehicle }).vision.reason).toBe('glide');
    const before = run.link.frames.length;
    run.link.conn.lastCustomMode = 5;
    const flipped = run.controller.tick({ estimate: seen, vehicle });
    expect(flipped.sentNow).toBe(0);
    expect(flipped.vision.state).toBe('released');
    expect(flipped.vision.reason).toBe('mode');
    expect(run.link.frames).toHaveLength(before);

    const again = session();
    again.at(60_000);
    const live = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 62_000,
    });
    again.at(60_000);
    again.controller.note({ estimate: seen, vehicle: live });
    again.at(62_000);
    expect(again.controller.requestOptical(live).ok).toBe(true);
    expect(again.controller.tick({ estimate: seen, vehicle: live }).sentNow).toBe(1);
    const sent = again.link.frames.length;
    const lost = again.controller.tick({ estimate: seen, vehicle: { ...live, connected: false } });
    expect(lost.vision.reason).toBe('link');
    expect(lost.vision.state).toBe('released');
    expect(lost.sentNow).toBe(0);
    const back = again.controller.tick({ estimate: seen, vehicle: live });
    expect(back.vision.state).toBe('released');
    expect(back.sentNow).toBe(0);
    expect(again.link.frames).toHaveLength(sent);
    const earlyPress = again.controller.requestOptical({ ...live, altAt: 62_000 });
    expect(earlyPress.ok).toBe(false);
    expect(earlyPress.reason).toBe('no_runway');
    again.at(64_000);
    const pressed = again.controller.requestOptical({ ...live, altAt: 64_000 });
    expect(pressed.ok).toBe(true);
    expect(again.link.frames).toHaveLength(sent + 1);
    expect(decode(again.link.frames.at(-1)).customMode).toBe(15);
  });

  it('greys the button below level 3 and when the mission has no landing item', () => {
    const run = session();
    const vehicle = approach({ customMode: 5, missionCurrent: 1, altAt: 72_000 });
    run.at(70_000);
    run.controller.note({ estimate: STRIP, vehicle });
    run.at(72_000);
    run.controller.setLevel({ level: 2 });
    const low = run.controller.requestOptical(vehicle);
    expect(low.ok).toBe(false);
    expect(low.reason).toBe('level');
    expect(low.messageHe).toBe('רמה 3 נדרשת לנחיתה אופטית');
    expect(run.link.frames).toHaveLength(0);

    run.controller.setLevel({ level: 3 });
    const bare = approach({
      customMode: 5,
      missionCurrent: 1,
      altAt: 72_000,
      missionItems: [{ seq: 1, command: 16, lat: 32.02, lon: 34.82 }],
    });
    run.at(72_000);
    run.controller.note({ estimate: STRIP, vehicle: bare });
    const missing = run.controller.requestOptical(bare);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('no_land');
    expect(missing.messageHe).toBe('אין נחיתה במשימה');
    expect(run.link.frames).toHaveLength(0);
  });

  it('greys the button below 50 m, inside the handoff, and while landed state is 4', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const legal = approach({
      customMode: 5,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 80,
      relativeAltM: 80,
      altAt: 12_000,
      landedState: 1,
    });
    run.at(10_000);
    run.controller.note({ estimate: seen, vehicle: legal });
    run.at(12_000);
    const ready = run.controller.note({ estimate: seen, vehicle: legal });
    expect(ready.vision.buttonReady).toBe(true);
    expect(ready.vision.blockHe).toBeNull();

    const low = { ...legal, relativeAltM: 12 };
    const lowStatus = run.controller.note({ estimate: seen, vehicle: low });
    expect(lowStatus.vision.buttonReady).toBe(false);
    expect(lowStatus.vision.blockHe).toBe('נמוך מדי להפעלה');
    const lowPress = run.controller.requestOptical(low);
    expect(lowPress.ok).toBe(false);
    expect(lowPress.reason).toBe('too_low');
    expect(lowPress.messageHe).toBe('נמוך מדי להפעלה');

    const close = { ...legal, relativeAltM: 80, lat: 32.01 + (80 / 111320) };
    expect(run.controller.note({ estimate: seen, vehicle: close }).vision.blockHe).toBe('נמוך מדי להפעלה');
    expect(run.controller.requestOptical(close).reason).toBe('too_low');

    const grounded = { ...legal, relativeAltM: 80, landedState: 4 };
    expect(run.controller.note({ estimate: seen, vehicle: grounded }).vision.buttonReady).toBe(false);
    expect(run.controller.requestOptical(grounded).messageHe).toBe('נמוך מדי להפעלה');
    expect(run.link.frames).toHaveLength(0);

    const far = { ...legal, customMode: 15, relativeAltM: 80, landedState: null };
    expect(run.controller.requestOptical(far).ok).toBe(true);
    const near = {
      ...far,
      lat: 32.01 + (80 / 111320),
      altAglM: 12,
      relativeAltM: 12,
    };
    const handed = run.controller.tick({ estimate: seen, vehicle: near });
    expect(handed.vision.reason).toBe('land');
    run.link.conn.lastCustomMode = 10;
    run.link.conn.lastHeartbeatWallMs = Date.now() - 2000;
    const stalled = run.controller.tick({
      estimate: seen,
      vehicle: { ...near, customMode: 10 },
    });
    expect(stalled.vision.state).toBe('released');
    expect(stalled.vision.labelHe).toBe('שוחרר');
    expect(stalled.vision.blockHe).toBe('נמוך מדי להפעלה');
    expect(stalled.vision.buttonReady).toBe(false);
    run.at(14_000);
    run.link.conn.lastHeartbeatWallMs = Date.now();
    const after = run.controller.note({
      estimate: seen,
      vehicle: { ...near, customMode: 10, altAt: 14_000 },
    });
    expect(after.vision.buttonReady).toBe(false);
    expect(after.vision.blockHe).toBe('נמוך מדי להפעלה');
    const again = run.controller.requestOptical({ ...near, customMode: 10, altAt: 14_000 });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('too_low');
    expect(again.messageHe).toBe('נמוך מדי להפעלה');
  });

  it('sends nothing when the heartbeat is FBWA or stale, even if the tick still says GUIDED', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 82_000,
    });
    run.at(80_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(82_000);
    expect(run.controller.requestOptical({ ...vehicle, altAt: 82_000 }).ok).toBe(true);
    expect(run.controller.tick({ estimate: seen, vehicle: { ...vehicle, altAt: 82_000 } }).vision.reason).toBe('glide');
    const glide = decode(run.link.frames.at(-1));
    expect(glide.third).toBe(192);
    expect(glide.param2).toBe(0);
    const before = run.link.frames.length;
    run.link.conn.lastCustomMode = 5;
    run.link.conn.lastHeartbeatWallMs = Date.now() - 800;
    const late = run.controller.tick({ estimate: seen, vehicle });
    expect(late.sentNow).toBe(0);
    expect(late.vision.state).toBe('released');
    expect(late.vision.reason).toBe('mode');
    expect(run.link.frames).toHaveLength(before);
    const direct = run.link.sendGuidance({
      kind: 'REPOSITION', lat: 32.01, lon: 34.81, altM: 30, expectMode: 15,
    });
    expect(direct.sent).toBe(false);
    expect(direct.reason).toBe('mode_changed');
    expect(run.link.frames).toHaveLength(before);

    const stale = session();
    stale.at(90_000);
    stale.controller.note({ estimate: seen, vehicle: { ...vehicle, altAt: 90_000 } });
    stale.at(92_000);
    expect(stale.controller.requestOptical({ ...vehicle, altAt: 92_000 }).ok).toBe(true);
    const held = stale.link.frames.length;
    stale.link.conn.lastCustomMode = 15;
    stale.link.conn.lastHeartbeatWallMs = Date.now() - 2000;
    const quiet = stale.controller.tick({ estimate: seen, vehicle: { ...vehicle, altAt: 92_000 } });
    expect(quiet.sentNow).toBe(0);
    expect(quiet.vision.state).toBe('released');
    expect(quiet.vision.reason).toBe('stale');
    expect(quiet.vision.labelHe).toBe('שוחרר');
    expect(stale.link.frames).toHaveLength(held);
    stale.link.conn.lastHeartbeatWallMs = Date.now();
    stale.link.conn.lastCustomMode = 15;
    const returned = stale.controller.tick({ estimate: seen, vehicle: { ...vehicle, altAt: 92_000 } });
    expect(returned.vision.state).toBe('released');
    expect(returned.sentNow).toBe(0);
    expect(stale.link.frames).toHaveLength(held);
    const earlyPress = stale.controller.requestOptical({ ...vehicle, altAt: 92_000 });
    expect(earlyPress.ok).toBe(false);
    expect(earlyPress.reason).toBe('no_runway');
    stale.at(94_000);
    const pressed = stale.controller.requestOptical({ ...vehicle, altAt: 94_000 });
    expect(pressed.ok).toBe(true);
    expect(stale.link.frames).toHaveLength(held + 1);
    expect(decode(stale.link.frames.at(-1)).customMode).toBe(15);
  });

  it('releases once when the heartbeat goes stale and does not resume', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(30_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach({ altAt: 30_000 }) });
    run.at(32_000);
    const guided = run.controller.tick({ estimate: STRIP, vehicle: approach({ altAt: 32_000 }) });
    expect(guided.vision.state).toBe('active');
    expect(guided.sentNow).toBe(1);
    const before = run.link.frames.length;
    run.link.conn.lastCustomMode = 10;
    run.link.conn.lastHeartbeatWallMs = Date.now() - 2000;
    const lost = run.controller.tick({ estimate: STRIP, vehicle: approach({ altAt: 32_000 }) });
    expect(lost.vision.state).toBe('released');
    expect(lost.vision.reason).toBe('stale');
    expect(lost.vision.labelHe).toBe('שוחרר');
    expect(lost.sentNow).toBe(1);
    expect(run.link.frames).toHaveLength(before + 1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    run.link.conn.lastHeartbeatWallMs = Date.now();
    run.link.conn.lastCustomMode = 10;
    const back = run.controller.tick({ estimate: STRIP, vehicle: approach({ altAt: 32_000 }) });
    expect(back.vision.state).toBe('released');
    expect(back.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(before + 1);
    const again = run.controller.tick({ estimate: STRIP, vehicle: approach({ altAt: 32_000 }) });
    expect(again.vision.state).toBe('released');
    expect(again.sentNow).toBe(0);
  });

  it('goes around when AUTO is refused or the next heartbeat is not AUTO', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const near = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (80 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 102_000,
    });
    const run = session();
    run.link.conn.ackFor = (cmd) => (
      cmd.kind === 'ENTER_AUTO' ? { command: 176, result: 4, heartbeatMode: 15 } : undefined
    );
    run.at(100_000);
    run.controller.note({ estimate: seen, vehicle: near });
    run.at(102_000);
    expect(run.controller.requestOptical({ ...near, lat: 32.01 + (700 / 111320) }).ok).toBe(true);
    const refused = run.controller.tick({ estimate: seen, vehicle: near });
    expect(refused.vision.state).toBe('go_around');
    const refusedRows = run.link.frames.map((frame) => decode(frame));
    expect(refusedRows.some((row) => row.third === 176)).toBe(true);
    expect(refusedRows.some((row) => row.type === 'MISSION_SET_CURRENT')).toBe(false);
    const climb = refusedRows.find((row) => row.type === 'COMMAND_INT' && row.third === 192);
    expect(climb.alt).toBeGreaterThanOrEqual(Math.max(near.altAglM + 30, 60));
    expect(climb.alt).toBeGreaterThan(near.altAglM);

    const missed = session();
    missed.link.conn.ackFor = (cmd) => (
      cmd.kind === 'ENTER_AUTO' ? { command: 176, result: 0, heartbeatMode: 5 } : undefined
    );
    missed.at(110_000);
    missed.controller.note({ estimate: seen, vehicle: { ...near, altAt: 112_000 } });
    missed.at(112_000);
    expect(missed.controller.requestOptical({
      ...near,
      lat: 32.01 + (700 / 111320),
      altAt: 112_000,
    }).ok).toBe(true);
    const stayed = missed.controller.tick({ estimate: seen, vehicle: { ...near, altAt: 112_000 } });
    expect(stayed.vision.state).toBe('released');
    expect(stayed.sentNow).toBe(1);
    const stayedRows = missed.link.frames.map((frame) => decode(frame));
    expect(stayedRows.some((row) => row.type === 'MISSION_SET_CURRENT')).toBe(false);
    expect(stayedRows.filter((row) => row.type === 'COMMAND_INT')).toHaveLength(0);
  });

  it('jumps to the mission downloaded just before handover', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const calls = [];
    let now = 120_000;
    const link = wire(true);
    link.refreshMission = () => {
      calls.push('handover');
      return {
        ok: true,
        items: [
          { seq: 4, command: 16, lat: 32.02, lon: 34.82 },
          { seq: 9, command: 21, lat: 32.01, lon: 34.81 },
        ],
      };
    };
    const controller = createRunwayController({ link, now: () => now, limits: { holdMs: 2000 } });
    controller.setLevel({ level: 3 });
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (80 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 120_000,
      missionItems: [
        { seq: 1, command: 16, lat: 32.02, lon: 34.82 },
        { seq: 3, command: 21, lat: 32.01, lon: 34.81 },
      ],
    });
    controller.note({ estimate: seen, vehicle });
    now = 122_000;
    expect(controller.requestOptical({
      ...vehicle,
      lat: 32.01 + (700 / 111320),
      altAt: 122_000,
    }).ok).toBe(true);
    const land = controller.tick({ estimate: seen, vehicle: { ...vehicle, altAt: 122_000 } });
    expect(calls).toEqual(['handover']);
    expect(land.vision.reason).toBe('land');
    const jump = decode(link.frames.at(-1));
    expect(jump.type).toBe('MISSION_SET_CURRENT');
    expect(jump.third).toBe(9);
  });

  it('stays active when disarmed or landed while still flying', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 132_000,
      armed: true,
    });
    run.at(130_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(132_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    expect(run.controller.tick({ estimate: seen, vehicle }).vision.state).toBe('active');
    const before = run.link.frames.length;
    const down = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...vehicle,
        armed: false,
        altAt: 132_000,
        groundspeedMps: 18,
        groundspeedAt: 132_000,
        relativeAltM: 40,
        relativeAltAt: 132_000,
      },
    });
    expect(down.vision.state).toBe('active');
    expect(down.vision.reason).not.toBe('idle');
    expect(down.sentNow).toBeGreaterThan(0);
    expect(run.link.frames.length).toBeGreaterThan(before);
    const again = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...vehicle,
        landedState: 1,
        armed: true,
        altAt: 132_000,
        groundspeedMps: 18,
        groundspeedAt: 132_000,
        relativeAltM: 40,
        relativeAltAt: 132_000,
      },
    });
    expect(again.vision.state).toBe('active');
    expect(again.vision.reason).not.toBe('idle');
  });

  it('returns to idle after groundspeed and relative altitude stay low', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 180_000,
      armed: true,
      landedState: null,
    });
    run.at(178_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(180_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    expect(run.controller.tick({ estimate: seen, vehicle }).vision.state).toBe('active');
    const low = {
      ...vehicle,
      altAglM: 0.6,
      altAt: 180_000,
      groundspeedMps: 1.4,
      groundspeedAt: 180_000,
      relativeAltM: 0.6,
      relativeAltAt: 180_000,
    };
    const early = run.controller.tick({ estimate: seen, vehicle: low });
    expect(early.vision.state).toBe('active');
    expect(early.vision.reason).not.toBe('idle');
    const fast = run.controller.tick({
      estimate: seen,
      vehicle: { ...low, groundspeedMps: 15, groundspeedAt: 180_000, relativeAltAt: 180_000, altAt: 180_000 },
    });
    expect(fast.vision.reason).not.toBe('idle');
    run.at(182_000);
    const restarted = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...low,
        groundspeedAt: 182_000,
        relativeAltAt: 182_000,
        altAt: 182_000,
      },
    });
    expect(restarted.vision.reason).not.toBe('idle');
    run.at(184_000);
    const midway = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...low,
        groundspeedMps: 3.9,
        relativeAltM: -1.15,
        groundspeedAt: 184_000,
        relativeAltAt: 184_000,
        altAt: 184_000,
      },
    });
    expect(midway.vision.reason).not.toBe('idle');
    run.at(185_000);
    const before = run.link.frames.length;
    const down = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...low,
        groundspeedMps: 3.9,
        relativeAltM: -1.15,
        groundspeedAt: 185_000,
        relativeAltAt: 185_000,
        altAt: 185_000,
      },
    });
    expect(down.vision.state).toBe('waiting');
    expect(down.vision.labelHe).toBe('ממתין');
    expect(down.vision.reason).toBe('idle');
    expect(down.vision.optical).toBe(false);
    expect(down.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(before);
    const missing = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAt: 185_000, groundspeedMps: null, relativeAltM: null },
    });
    expect(missing.vision.reason).not.toBe('idle');

    const inAir = session();
    const flying = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 1.2,
      altAt: 200_000,
      armed: true,
      landedState: 2,
      groundspeedMps: 1.2,
      groundspeedAt: 200_000,
      relativeAltM: 1.2,
      relativeAltAt: 200_000,
    });
    inAir.at(198_000);
    inAir.controller.note({ estimate: seen, vehicle: flying });
    inAir.at(200_000);
    expect(inAir.controller.requestOptical({ ...flying, relativeAltM: 80, altAglM: 80 }).ok).toBe(true);
    expect(inAir.controller.tick({ estimate: seen, vehicle: flying }).vision.state).toBe('active');
    inAir.at(203_000);
    const stillAir = inAir.controller.tick({
      estimate: seen,
      vehicle: {
        ...flying,
        altAt: 203_000,
        groundspeedAt: 203_000,
        relativeAltAt: 203_000,
      },
    });
    expect(stillAir.vision.state).toBe('active');
    expect(stillAir.vision.reason).not.toBe('idle');
  });

  it('idles on an ArduPlane touchdown and stays active through the glide', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const glide = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 210_000,
      armed: true,
      landedState: 4,
      groundspeedMps: 18,
      groundspeedAt: 210_000,
      relativeAltM: 40,
      relativeAltAt: 210_000,
    });
    run.at(208_000);
    run.controller.note({ estimate: seen, vehicle: glide });
    run.at(210_000);
    expect(run.controller.requestOptical({ ...glide, landedState: null, relativeAltM: 80 }).ok).toBe(true);
    const flying = run.controller.tick({ estimate: seen, vehicle: glide });
    expect(flying.vision.state).toBe('active');
    expect(flying.vision.reason).toBe('glide');
    const lowFast = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...glide,
        altAglM: 2,
        altAt: 210_000,
        landedState: null,
        groundspeedMps: 15,
        groundspeedAt: 210_000,
        relativeAltM: 2,
        relativeAltAt: 210_000,
      },
    });
    expect(lowFast.vision.reason).not.toBe('idle');
    run.at(214_000);
    const stillFlying = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...glide,
        altAglM: 2,
        altAt: 214_000,
        landedState: null,
        groundspeedMps: 15,
        groundspeedAt: 214_000,
        relativeAltM: 2,
        relativeAltAt: 214_000,
      },
    });
    expect(stillFlying.vision.state).toBe('active');
    expect(stillFlying.vision.reason).not.toBe('idle');
    const touch = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...glide,
        altAglM: -1.15,
        altAt: 214_000,
        landedState: 4,
        groundspeedMps: 15,
        groundspeedAt: 214_000,
        relativeAltM: -1.15,
        relativeAltAt: 214_000,
      },
    });
    expect(touch.vision.state).toBe('active');
    expect(touch.vision.reason).not.toBe('idle');
    expect(touch.sentNow).toBeGreaterThan(0);
    const flare = run.controller.tick({
      estimate: seen,
      vehicle: {
        ...glide,
        altAglM: 1.79,
        altAt: 214_000,
        landedState: 4,
        groundspeedMps: 18.6,
        groundspeedAt: 214_000,
        relativeAltM: 1.79,
        relativeAltAt: 214_000,
      },
    });
    expect(flare.vision.state).toBe('active');
    expect(flare.vision.reason).toBe('glide');
    expect(flare.vision.reason).not.toBe('idle');

    const roll = session();
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 220_000,
      armed: true,
      landedState: null,
    });
    roll.at(218_000);
    roll.controller.note({ estimate: seen, vehicle });
    roll.at(220_000);
    expect(roll.controller.requestOptical(vehicle).ok).toBe(true);
    expect(roll.controller.tick({ estimate: seen, vehicle }).vision.state).toBe('active');
    const once = {
      ...vehicle,
      altAglM: -1.15,
      altAt: 220_000,
      groundspeedMps: 3.9,
      groundspeedAt: 220_000,
      relativeAltM: -1.15,
      relativeAltAt: 220_000,
    };
    expect(roll.controller.tick({ estimate: seen, vehicle: once }).vision.reason).not.toBe('idle');
    roll.at(223_000);
    const down = roll.controller.tick({
      estimate: seen,
      vehicle: { ...once, altAt: 223_000, groundspeedAt: 223_000, relativeAltAt: 223_000 },
    });
    expect(down.vision.reason).toBe('idle');
    expect(down.vision.state).toBe('waiting');
    const edge = roll.controller.tick({
      estimate: seen,
      vehicle: {
        ...once,
        altAt: 223_000,
        groundspeedMps: 5,
        groundspeedAt: 223_000,
        relativeAltM: 2.9,
        relativeAltAt: 223_000,
        landedState: null,
      },
    });
    expect(edge.vision.reason).not.toBe('idle');
    const highState = roll.controller.tick({
      estimate: seen,
      vehicle: {
        ...vehicle,
        altAt: 223_000,
        landedState: 4,
        relativeAltM: 40,
        relativeAltAt: 223_000,
        groundspeedMps: 18,
        groundspeedAt: 223_000,
      },
    });
    expect(highState.vision.reason).not.toBe('idle');
    expect(down.vision.buttonReady).toBe(false);
    const airborne = roll.controller.tick({
      estimate: seen,
      vehicle: {
        ...vehicle,
        altAt: 223_000,
        altAglM: 40,
        landedState: 4,
        groundspeedMps: 18.6,
        groundspeedAt: 223_000,
        relativeAltM: 40,
        relativeAltAt: 223_000,
      },
    });
    expect(airborne.vision.state).not.toBe('active');
    expect(airborne.vision.buttonReady).toBe(false);
    const refused = roll.controller.requestOptical({
      ...vehicle,
      altAt: 223_000,
      altAglM: 80,
      groundspeedMps: 18.6,
      groundspeedAt: 223_000,
      relativeAltM: 80,
      relativeAltAt: 223_000,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('no_runway');
    roll.at(225_000);
    const again = roll.controller.requestOptical({
      ...vehicle,
      altAt: 225_000,
      altAglM: 80,
      groundspeedMps: 18.6,
      groundspeedAt: 225_000,
      relativeAltM: 80,
      relativeAltAt: 225_000,
    });
    expect(again.ok).toBe(true);
  });

  it('allows a new press after the climb and after a takeover', () => {
    const run = session();
    const seen = { ...STRIP, threshold_lat: 32.01, threshold_lon: 34.81 };
    const hazard = { ...seen, hazards: [{ kind: 'vehicle' }] };
    const vehicle = approach({
      customMode: 15,
      missionCurrent: 1,
      lat: 32.01 + (700 / 111320),
      lon: 34.81,
      altAglM: 40,
      altAt: 190_000,
      headingDeg: 90,
    });
    run.at(188_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(190_000);
    expect(run.controller.requestOptical({ ...vehicle, altAt: 190_000 }).ok).toBe(true);
    const around = run.controller.tick({
      estimate: hazard,
      vehicle: { ...vehicle, altAt: 190_000 },
    });
    expect(around.vision.state).toBe('go_around');
    run.at(192_000);
    const during = run.controller.requestOptical({
      ...vehicle,
      altAglM: 50,
      altAt: 192_000,
    });
    expect(during.ok).toBe(false);
    expect(during.reason).toBe('go_around');
    const climbing = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAglM: 50, altAt: 192_000 },
    });
    expect(climbing.vision.state).toBe('go_around');
    run.at(194_000);
    const ready = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAglM: 70, altAt: 194_000 },
    });
    expect(ready.vision.state).toBe('go_around');
    expect(ready.vision.labelHe).toBe('סבוב מחדש');
    const again = run.controller.requestOptical({ ...vehicle, altAglM: 70, altAt: 194_000 });
    expect(again.ok).toBe(true);
    expect(again.sentNow).toBe(1);
    const resumed = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, customMode: 15, altAglM: 70, altAt: 194_000 },
    });
    expect(resumed.vision.state).toBe('active');
    const took = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, customMode: 5, altAglM: 80, altAt: 194_000 },
    });
    expect(took.vision.state).toBe('released');
    run.at(196_000);
    const next = run.controller.note({
      estimate: seen,
      vehicle: { ...vehicle, customMode: 5, altAglM: 80, altAt: 196_000 },
    });
    expect(next.vision.state).toBe('released');
    expect(next.vision.labelHe).toBe('שוחרר');
    run.at(198_000);
    const pressed = run.controller.requestOptical({
      ...vehicle,
      customMode: 5,
      altAglM: 80,
      altAt: 198_000,
    });
    expect(pressed.ok).toBe(true);
    expect(pressed.reason).not.toBe('go_around');
  });

  it('requests EXTENDED_SYS_STATE on SITL only', () => {
    function commandLong(frame) {
      expect(frame[0]).toBe(0xfd);
      const msgId = frame[7] + (frame[8] << 8) + (frame[9] << 16);
      expect(msgId).toBe(76);
      const payload = frame.subarray(10, 10 + frame[1]);
      return {
        param1: payload.readFloatLE(0),
        param2: payload.readFloatLE(4),
        command: payload.readUInt16LE(28),
      };
    }
    const sitl = wire(true);
    expect(sitl.conn.requestExtendedSysState()).toBe(true);
    expect(sitl.frames).toHaveLength(1);
    const cmd = commandLong(sitl.frames[0]);
    expect(cmd.command).toBe(511);
    expect(cmd.param1).toBe(245);
    expect(cmd.param2).toBe(1_000_000);
    const real = wire(false);
    expect(real.conn.requestExtendedSysState()).toBe(false);
    expect(real.frames).toHaveLength(0);
  });

  it('refuses the mode guard when the heartbeat is older than 1.5 s', () => {
    const link = wire(true);
    link.conn.lastCustomMode = 15;
    link.conn.lastHeartbeatWallMs = Date.now() - 1600;
    expect(() => link.conn._assertExpectMode(15)).toThrow(/stale heartbeat/);
    try {
      link.conn._assertExpectMode(15);
    } catch (err) {
      expect(err.code).toBe('stale_heartbeat');
    }
    const sent = link.sendGuidance({
      kind: 'REPOSITION',
      lat: 32.01,
      lon: 34.81,
      altM: 40,
      expectMode: 15,
    });
    expect(sent.sent).toBe(false);
    expect(sent.reason).toBe('stale_heartbeat');
    expect(link.frames).toHaveLength(0);
    link.conn.lastHeartbeatWallMs = Date.now();
    expect(() => link.conn._assertExpectMode(15)).not.toThrow();
  });

  it('names a mission with no landing item instead of waiting', () => {
    const run = session();
    const bare = approach({
      customMode: 10,
      missionCurrent: 1,
      altAt: 140_000,
      missionItems: [{ seq: 1, command: 16, lat: 32.02, lon: 34.82 }],
    });
    run.at(140_000);
    const noted = run.controller.note({ estimate: STRIP, vehicle: bare });
    expect(noted.vision.hasLand).toBe(false);
    expect(noted.vision.labelHe).toBe('אין נחיתה במשימה');
    expect(noted.vision.labelHe).not.toBe('ממתין');
    const ticked = run.controller.tick({ estimate: STRIP, vehicle: bare });
    expect(ticked.vision.labelHe).toBe('אין נחיתה במשימה');
    expect(ticked.sentNow).toBe(0);
    const approachOnly = run.controller.tick({
      estimate: STRIP,
      vehicle: approach({ customMode: 10, missionCurrent: 1, altAt: 140_000 }),
    });
    expect(approachOnly.vision.hasLand).toBe(true);
    expect(approachOnly.vision.labelHe).toBe('ממתין');
  });

  it('stays silent off SITL and keeps level 4 locked', () => {
    const calls = [];
    const controller = createRunwayController({
      now: () => 200_000,
      limits: { holdMs: 0 },
      link: { sendGuidance(cmd) { calls.push(cmd); return { sent: true }; } },
    });
    controller.setLevel({ level: 3 });
    const off = controller.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'vehicle', label_he: 'רכב' }] },
      vehicle: approach({ simulator: false }),
    });
    expect(off.sentNow).toBe(0);
    expect(off.vision.labelHe).toBe('ממתין');
    expect(off.decision.reason).toBe('hazard');
    expect(calls).toEqual([]);

    const locked = createRunwayController({
      now: () => 200_000,
      limits: { holdMs: 0 },
      link: { sendGuidance() { throw new Error('should not send'); } },
    });
    const refused = locked.setLevel({ level: 4, confirm: true, phrase: 'מאשר' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('level4_locked');
    expect(locked.tick({ estimate: STRIP, vehicle: approach() }).sentNow).toBe(0);
  });
});
