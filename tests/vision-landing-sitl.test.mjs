/**
 * Vision landing stays inside SITL.
 * A scripted approach is the vehicle. Frames are the real MAVLink bytes.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MavlinkConnection, parseMissionCurrent } from '../lib/mavlink-connection.mjs';
import { createRunwayController } from '../lib/runway-awareness.mjs';
import { vehicleFromConnection } from '../lib/routes/runway-awareness-api.mjs';
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

  it('does not cancel on a roll echo, a guidance step, or pitch throttle and yaw', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const steer = { ...STRIP, heading_error_deg: 15, offset_m: 0 };
    run.at(140_000);
    run.controller.tick({ estimate: steer, vehicle: approach() });
    run.at(142_000);
    const active = run.controller.tick({ estimate: steer, vehicle: approach() });
    expect(active.vision.state).toBe('active');
    expect(active.vision.takeoverCh).toBe(7);
    expect(decode(run.link.frames.at(-1)).rest[0]).toBe(1560);

    const echoChannels = {
      chan1_raw: 1560,
      chan2_raw: 1500,
      chan3_raw: 1500,
      chan4_raw: 1500,
      chan5_raw: 1500,
      chan6_raw: 1500,
      chan7_raw: 1500,
      chan8_raw: 1500,
    };
    const echo = run.controller.tick({
      estimate: steer,
      vehicle: approach({ rcChannels: echoChannels }),
    });
    expect(echo.vision.state).toBe('active');
    expect(echo.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest[0]).toBe(1560);

    const stepped = run.controller.tick({
      estimate: { ...STRIP, heading_error_deg: 5, offset_m: 0 },
      vehicle: approach({ rcChannels: echoChannels }),
    });
    expect(stepped.vision.state).toBe('active');
    expect(stepped.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest[0]).toBe(1520);
    expect(decode(run.link.frames.at(-1)).rest.slice(1).every((value) => value === 0)).toBe(true);

    const moved = run.controller.tick({
      estimate: STRIP,
      vehicle: approach({
        rcChannels: { ...echoChannels, chan1_raw: 1560, chan2_raw: 1900, chan3_raw: 1100, chan4_raw: 1800 },
      }),
    });
    expect(moved.vision.state).toBe('active');
    expect(moved.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest[0]).toBe(1520);
    expect(decode(run.link.frames.at(-1)).rest.slice(1).every((value) => value === 0)).toBe(true);
  });

  it('cancels once when the takeover switch crosses 1700 or the mode changes', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    run.at(90_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(92_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.labelHe).toBe('פעיל');
    const before = run.link.frames.length;
    const flipped = run.controller.tick({
      estimate: STRIP,
      vehicle: approach({
        rcChannels: {
          chan1_raw: 1560, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1700, chan8_raw: 1500,
        },
      }),
    });
    expect(flipped.vision.labelHe).toBe('שוחרר');
    expect(flipped.vision.reason).toBe('switch');
    expect(flipped.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(run.controller.tick({
      estimate: STRIP,
      vehicle: approach({
        rcChannels: {
          chan1_raw: 1560, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1800, chan8_raw: 1500,
        },
      }),
    }).sentNow).toBe(0);
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
    expect(changed.vision.reason).toBe('mode');
    expect(changed.sentNow).toBe(1);
    expect(mode.controller.tick({ estimate: STRIP, vehicle: approach({ customMode: 0 }) }).sentNow).toBe(0);

    const custom = session({ takeoverCh: 6 });
    custom.at(110_000);
    custom.controller.tick({ estimate: STRIP, vehicle: approach() });
    custom.at(112_000);
    const armed = custom.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(armed.vision.takeoverCh).toBe(6);
    expect(armed.vision.state).toBe('active');
    const other = custom.controller.tick({
      estimate: STRIP,
      vehicle: approach({
        rcChannels: {
          chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 1900, chan8_raw: 1500,
        },
      }),
    });
    expect(other.vision.state).toBe('active');
    const own = custom.controller.tick({
      estimate: STRIP,
      vehicle: approach({
        rcChannels: {
          chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1700, chan7_raw: 1500, chan8_raw: 1500,
        },
      }),
    });
    expect(own.vision.labelHe).toBe('שוחרר');
    expect(own.sentNow).toBe(1);
    expect(custom.controller.tick({ estimate: STRIP, vehicle: approach() }).sentNow).toBe(0);
  });

  it('manual arm keeps pitch throttle and yaw, and the switch still cancels once', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const run = session();
    const offApproach = (overrides = {}) => approach({ missionCurrent: 1, ...overrides });
    run.controller.setManualArm(true);
    run.at(120_000);
    run.controller.tick({ estimate: STRIP, vehicle: offApproach() });
    run.at(122_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: offApproach() }).vision.labelHe).toBe('פעיל');
    const sticks = {
      chan1_raw: 1700,
      chan2_raw: 1900,
      chan3_raw: 1100,
      chan4_raw: 1800,
      chan5_raw: 1900,
      chan6_raw: 1100,
      chan7_raw: 1500,
      chan8_raw: 1200,
    };
    const moved = run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: sticks }),
    });
    expect(moved.vision.state).toBe('active');
    expect(decode(run.link.frames.at(-1)).rest[0]).toBeGreaterThan(1500);
    expect(decode(run.link.frames.at(-1)).rest.slice(1).every((value) => value === 0)).toBe(true);
    const before = run.link.frames.length;
    const cancel = run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: { ...sticks, chan7_raw: 1700 } }),
    });
    expect(cancel.vision.labelHe).toBe('שוחרר');
    expect(cancel.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(run.controller.tick({
      estimate: STRIP,
      vehicle: offApproach({ rcChannels: { ...sticks, chan7_raw: 1700 } }),
    }).sentNow).toBe(0);
    expect(run.link.frames.length).toBe(before + 1);
  });

  it('refuses to activate when the takeover switch has no valid RC', () => {
    const cases = [
      () => {
        const vehicle = approach();
        delete vehicle.rcChannels;
        return vehicle;
      },
      () => approach({
        rcChannels: {
          chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 0, chan8_raw: 1500,
        },
      }),
      () => approach({
        rcChannels: {
          chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan7_raw: 65535, chan8_raw: 1500,
        },
      }),
      () => approach({
        rcChannels: {
          chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1500, chan4_raw: 1500,
          chan5_raw: 1500, chan6_raw: 1500, chan8_raw: 1500,
        },
      }),
    ];
    for (const build of cases) {
      const run = session();
      const vehicle = build();
      run.at(10_000);
      run.controller.tick({ estimate: STRIP, vehicle });
      run.at(12_000);
      const blocked = run.controller.tick({ estimate: STRIP, vehicle });
      expect(blocked.vision.labelHe).toBe('ממתין');
      expect(blocked.vision.reason).toBe('no_switch');
      expect(blocked.sentNow).toBe(0);
      expect(run.link.frames).toHaveLength(0);
    }

    const run = session();
    run.at(20_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(22_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.state).toBe('active');
    const lostVehicle = approach();
    delete lostVehicle.rcChannels;
    const lost = run.controller.tick({ estimate: STRIP, vehicle: lostVehicle });
    expect(lost.vision.labelHe).toBe('ממתין');
    expect(lost.vision.reason).toBe('no_switch');
    expect(lost.sentNow).toBe(1);
    expect(run.controller.tick({ estimate: STRIP, vehicle: lostVehicle }).sentNow).toBe(0);
    run.at(24_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.state).toBe('waiting');
    run.at(26_000);
    const resumed = run.controller.tick({ estimate: STRIP, vehicle: approach() });
    expect(resumed.vision.state).toBe('active');
    expect(resumed.sentNow).toBe(1);
  });

  it('treats RC loss as an invalid switch before activation and while guiding', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const live = (boot, patch = {}) => approach({
      rcChannels: {
        chan1_raw: 1500,
        chan2_raw: 1500,
        chan3_raw: 1500,
        chan4_raw: 1500,
        chan5_raw: 1500,
        chan6_raw: 1500,
        chan7_raw: 1500,
        chan8_raw: 1500,
        chancount: 16,
        rssi: 200,
        time_boot_ms: boot,
        ...patch,
      },
    });
    const blocked = (patch) => {
      const run = session();
      const vehicle = live(8_000, patch);
      run.at(10_000);
      run.controller.tick({ estimate: STRIP, vehicle });
      run.at(12_000);
      const row = run.controller.tick({ estimate: STRIP, vehicle });
      expect(row.vision.labelHe).toBe('ממתין');
      expect(row.vision.reason).toBe('no_switch');
      expect(row.sentNow).toBe(0);
      expect(run.link.frames).toHaveLength(0);
    };
    blocked({ chancount: 0 });
    blocked({ rssi: 0 });

    const frozen = session();
    const stuck = live(8_000);
    frozen.at(10_000);
    frozen.controller.tick({ estimate: STRIP, vehicle: stuck });
    frozen.at(11_100);
    const held = frozen.controller.tick({ estimate: STRIP, vehicle: stuck });
    expect(held.vision.reason).toBe('no_switch');
    expect(held.vision.labelHe).toBe('ממתין');
    expect(held.sentNow).toBe(0);
    frozen.at(13_000);
    expect(frozen.controller.tick({ estimate: STRIP, vehicle: stuck }).sentNow).toBe(0);
    expect(frozen.link.frames).toHaveLength(0);

    const clock = session();
    clock.at(20_000);
    clock.controller.tick({ estimate: STRIP, vehicle: live(9_000) });
    clock.at(21_100);
    const drifted = clock.controller.tick({
      estimate: STRIP,
      vehicle: live(9_000, { chan8_raw: 1600 }),
    });
    expect(drifted.vision.reason).toBe('no_switch');
    expect(drifted.sentNow).toBe(0);

    const moving = session();
    moving.at(15_000);
    moving.controller.tick({ estimate: STRIP, vehicle: live(15_000) });
    moving.at(17_000);
    const guided = moving.controller.tick({ estimate: STRIP, vehicle: live(17_000) });
    expect(guided.vision.state).toBe('active');
    expect(guided.sentNow).toBe(1);

    const during = (patch, boot) => {
      const run = session();
      run.at(30_000);
      run.controller.tick({ estimate: STRIP, vehicle: live(30_000) });
      run.at(32_000);
      expect(run.controller.tick({ estimate: STRIP, vehicle: live(32_000) }).vision.state).toBe('active');
      const vehicle = live(boot, patch);
      const lost = run.controller.tick({ estimate: STRIP, vehicle });
      expect(lost.vision.labelHe).toBe('ממתין');
      expect(lost.vision.reason).toBe('no_switch');
      expect(lost.sentNow).toBe(1);
      expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
      expect(run.controller.tick({ estimate: STRIP, vehicle }).sentNow).toBe(0);
    };
    during({ chancount: 0 }, 33_000);
    during({ rssi: 0 }, 33_000);

    const active = session();
    active.at(40_000);
    active.controller.tick({ estimate: STRIP, vehicle: live(40_000) });
    active.at(42_000);
    expect(active.controller.tick({ estimate: STRIP, vehicle: live(42_000) }).vision.state).toBe('active');
    const same = live(42_000);
    active.at(43_100);
    const lost = active.controller.tick({ estimate: STRIP, vehicle: same });
    expect(lost.vision.reason).toBe('no_switch');
    expect(lost.sentNow).toBe(1);
    expect(decode(active.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(active.controller.tick({ estimate: STRIP, vehicle: same }).sentNow).toBe(0);
  });

  it('drops RC older than 500 ms and releases once', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const now = 1_700_000_000_000;
    const rc = approach().rcChannels;
    const fresh = vehicleFromConnection({
      connected: true,
      lastRcChannels: rc,
      lastRcAt: now - 500,
    }, now);
    expect(fresh.rcChannels).toBe(rc);
    const aged = vehicleFromConnection({
      connected: true,
      lastRcChannels: { ...rc, receivedWallMs: now - 100 },
      lastRcAt: now - 501,
    }, now);
    expect(aged.rcChannels).toBeNull();
    const wall = vehicleFromConnection({
      connected: true,
      lastRcChannels: { ...rc, receivedWallMs: now - 700 },
    }, now);
    expect(wall.rcChannels).toBeNull();
    expect(vehicleFromConnection({ connected: true, lastRcChannels: rc }, now).rcChannels).toBeNull();

    const run = session();
    run.at(50_000);
    run.controller.tick({ estimate: STRIP, vehicle: approach() });
    run.at(52_000);
    expect(run.controller.tick({ estimate: STRIP, vehicle: approach() }).vision.state).toBe('active');
    const vehicle = vehicleFromConnection({
      connected: true,
      simulatorDetection: () => ({ simulator: true }),
      lastCustomMode: 10,
      lastRcChannels: rc,
      lastRcAt: now - 700,
      lastGlobalPos: { relativeAltM: 40, lat: 32.02, lon: 34.82 },
      missionItems: approach().missionItems,
      missionCurrent: 2,
    }, now);
    expect(vehicle.simulator).toBe(true);
    expect(vehicle.rcChannels).toBeNull();
    const lost = run.controller.tick({ estimate: STRIP, vehicle });
    expect(lost.vision.labelHe).toBe('ממתין');
    expect(lost.vision.reason).toBe('no_switch');
    expect(lost.sentNow).toBe(1);
    expect(decode(run.link.frames.at(-1)).rest.every((value) => value === 0)).toBe(true);
    expect(run.controller.tick({ estimate: STRIP, vehicle }).sentNow).toBe(0);
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
