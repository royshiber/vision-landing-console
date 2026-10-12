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
  missionLandingPhase,
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
      try {
        let out;
        if (cmd.kind === 'GO_AROUND') out = conn.sendRunwayGoAround(cmd);
        else if (
          cmd.kind === 'ENTER_GUIDED' || cmd.kind === 'ENTER_AUTO' || cmd.kind === 'RTL'
          || cmd.kind === 'REPOSITION' || cmd.kind === 'DO_LAND_START' || cmd.kind === 'SET_CURRENT'
        ) out = conn.sendRunwayOptical(cmd);
        else out = conn.sendRunwayRollOverride(cmd.rollPwm, { release: cmd.release === true, expectMode: cmd.expectMode });
        const ack = typeof conn.ackFor === 'function' ? conn.ackFor(cmd) : undefined;
        if (out && typeof out.then === 'function') {
          return out.then(() => (ack === undefined ? { sent: true } : { sent: true, ack }));
        }
        return ack === undefined ? { sent: true } : { sent: true, ack };
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
    '    print(kind, msg.target_system, msg.target_component, msg.command, ",".join(str(n) for n in (msg.x, msg.y, msg.z, msg.frame)))',
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
    const [lat, lon, alt, frame] = rest.split(',').map(Number);
    return { type, target: Number(target), comp: Number(comp), third: Number(third), lat, lon, alt, frame };
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
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.state).toBe('released');
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
    expect(jump.map((row) => row.type)).toEqual(['SET_MODE', 'MISSION_SET_CURRENT']);
    expect(jump[0].customMode).toBe(10);
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
    expect(rows.some((row) => row.type === 'SET_MODE' && row.customMode === 10)).toBe(true);
    expect(rows.some((row) => row.type === 'COMMAND_LONG' && row.third === 189)).toBe(true);
    const climb = rows.find((row) => row.type === 'COMMAND_INT' && row.third === 192);
    expect(climb.alt).toBeGreaterThanOrEqual(60);
    expect(climb.alt).not.toBe(0);
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
    expect(hazard.vision.labelHe).toBe('סבוב מחדש');
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
      lat: 32.01 + (200 / 111320),
      lon: 34.81,
      altAglM: 12,
      altAt: 42_000,
    });
    run.at(40_000);
    run.controller.note({ estimate: seen, vehicle });
    run.at(42_000);
    expect(run.controller.requestOptical(vehicle).ok).toBe(true);
    const stale = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAt: 42_000 - 5_000 },
    });
    expect(stale.vision.reason).toBe('alt');
    expect(stale.vision.state).toBe('released');
    expect(stale.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(1);
    const missing = run.controller.tick({
      estimate: seen,
      vehicle: { ...vehicle, altAglM: null, altAt: 42_000 },
    });
    expect(missing.vision.reason).toBe('alt');
    expect(missing.sentNow).toBe(0);
    expect(run.link.frames).toHaveLength(1);
    const floored = run.controller.tick({ estimate: seen, vehicle });
    expect(floored.vision.reason).toBe('glide');
    const point = decode(run.link.frames.at(-1));
    expect(point.third).toBe(192);
    expect(point.alt).toBeGreaterThanOrEqual(15);
    expect(point.alt).not.toBe(0);
    expect(run.link.frames.map((frame) => decode(frame)).some((row) => row.alt === 0)).toBe(false);
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
    const pressed = again.controller.requestOptical({ ...live, altAt: 62_000 });
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
