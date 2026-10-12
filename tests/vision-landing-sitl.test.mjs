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
    missionCurrent: 2,
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
    sendGuidance(cmd) {
      try {
        if (cmd.kind === 'GO_AROUND') {
          conn.sendRunwayGoAround();
          return { sent: true };
        }
        conn.sendRunwayRollOverride(cmd.rollPwm, { release: cmd.release === true });
        return { sent: true };
      } catch (err) {
        return { sent: false, reason: err?.code || 'not_sitl' };
      }
    },
  };
}

function session() {
  let now = 50_000;
  const link = wire(true);
  const controller = createRunwayController({
    link,
    now: () => now,
    limits: { holdMs: 2000 },
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
  return {
    type,
    target: Number(target),
    comp: Number(comp),
    third: Number(third),
    rest: rest.split(',').map(Number),
  };
}

describe('vision landing phase', () => {
  it('accepts only the approach item or the land item after NAV_LAND', () => {
    const items = approach().missionItems;
    expect(missionLandingPhase(items, 2).active).toBe(true);
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
    expect(live.vision.labelHe).toBe('פעיל');
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
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.labelHe).toBe('פעיל');

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
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.labelHe).toBe('פעיל');
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
    expect(later.vision.labelHe).toBe('פעיל');
    expect(decode(high.link.frames[0]).type).toBe('RC_CHANNELS_OVERRIDE');
    expect(decode(high.link.frames[0]).rest[1]).toBe(0);
    expect(decode(high.link.frames[0]).rest[2]).toBe(0);
  });

  it('cancels immediately when the pilot moves the sticks or the mode changes', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(90_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(92_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.labelHe).toBe('פעיל');
    const before = run.link.frames.length;

    const touched = run.controller.tick({
      estimate: STRIP,
      vehicle: approach({
        rcChannels: {
          chan1_raw: 1600, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1500, chan8_raw: 1500,
        },
      }),
    });
    expect(touched.vision.labelHe).toBe('שוחרר');
    expect(touched.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    run.at(95_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).sentNow).toBe(0);
    expect(run.link.frames.length).toBe(before + 1);

    const mode = session();
    mode.at(100_000);
    mode.controller.tick({ estimate: STRIP, vehicle: approach() });
    mode.at(102_000);
    expect(mode.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.state).toBe('active');
    const changed = mode.controller.tick({
      estimate: STRIP,
      vehicle: approach({ customMode: 0 }),
    });
    expect(changed.vision.labelHe).toBe('שוחרר');
    expect(changed.sentNow).toBe(1);
    expect(mode.controller.tick({ estimate: STRIP, vehicle: approach({ customMode: 0 }) }).sentNow).toBe(0);
  });

  it('manual arm keeps guiding through pitch throttle and yaw, and cancels on roll', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const offApproach = (overrides = {}) => approach({ missionCurrent: 1, ...overrides });
    run.controller.setManualArm(true);
    run.at(120_000);
    run.controller.tick({ estimate: STRIP, vehicle: offApproach() });
    run.at(122_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: offApproach() }).vision.labelHe).toBe('פעיל');

    const sticks = {
      chan1_raw: 1500,
      chan2_raw: 1900,
      chan3_raw: 1100,
      chan4_raw: 1800,
      chan5_raw: 1900,
      chan6_raw: 1100,
      chan7_raw: 1800,
      chan8_raw: 1200,
    };
    const moved = run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: sticks }),
    });
    expect(moved.vision.state).toBe('active');
    expect(decode(run.link.frames.at(-1)).rest[0]).toBeGreaterThan(1500);
    expect(decode(run.link.frames.at(-1)).rest.slice(1).every((value) => value === 0)).toBe(true);

    const inside = run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: { ...sticks, chan1_raw: 1539 } }),
    });
    expect(inside.vision.state).toBe('active');

    const roll = run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: { ...sticks, chan1_raw: 1540 } }),
    });
    expect(roll.vision.labelHe).toBe('שוחרר');
    expect(roll.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: { ...sticks, chan1_raw: 1540 } }),
    }).sentNow).toBe(0);
  });

  it('can be armed from the console, and it stays silent off SITL and at level 4', () => {
    let now = 110_000;
    const calls = [];
    const controller = createRunwayController({
      now: () => now,
      limits: { holdMs: 2000 },
      link: { sendGuidance(cmd) { calls.push(cmd); return { sent: true }; } },
    });
    controller.setLevel({ level: 3 });
    const early = approach({ missionCurrent: 1 });
    controller.setManualArm(true);
    controller.tick({ estimate: STRIP, vehicle: early });
    now = 112_000;
    const armed = controller.tick({ estimate: STRIP, vehicle: early });
    expect(armed.vision.manualArm).toBe(true);
    expect(armed.vision.labelHe).toBe('פעיל');
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('ROLL_OVERRIDE');
    expect(calls[0].release).toBeUndefined();

    const blocked = createRunwayController({
      now: () => 200_000,
      limits: { holdMs: 0 },
      link: { sendGuidance(cmd) { throw new Error('should not send'); } },
    });
    blocked.setLevel({ level: 3 });
    const off = blocked.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'vehicle', label_he: 'רכב' }] },
      vehicle: approach({ simulator: false }),
    });
    expect(off.sentNow).toBe(0);
    expect(off.vision.labelHe).toBe('ממתין');
    expect(off.decision.reason).toBe('hazard');

    const locked = createRunwayController({
      now: () => 200_000,
      limits: { holdMs: 0 },
      link: { sendGuidance(cmd) { throw new Error('should not send'); } },
    });
    const refused = locked.setLevel({ level: 4, confirm: true, phrase: 'מאשר' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('level4_locked');
    expect(locked.tick({ estimate: STRIP, vehicle: approach() }).sentNow).toBe(0);
  });
});
