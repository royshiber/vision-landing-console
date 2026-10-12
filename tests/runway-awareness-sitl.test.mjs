/**
 * Runway awareness stays silent at levels 0–2, and the roll override
 * leaves the process only when the link is a simulator.
 */
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { MavlinkConnection } from '../lib/mavlink-connection.mjs';
import { registerRunwayAwarenessApi } from '../lib/routes/runway-awareness-api.mjs';
import {
  authorizeRunway,
  computeGuidance,
  createRunwayController,
  rollPwmFromEstimate,
} from '../lib/runway-awareness.mjs';

const STRIP = {
  detected: true,
  offset_px: 12,
  offset_m: 2,
  offset_norm: 0.1,
  heading_error_deg: 4,
  progress: 0.4,
  confidence: { offset: 0.9, heading: 0.8, along: 0.7 },
  hazards: [],
};

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function appFor(controller) {
  const app = express();
  app.use(express.json());
  registerRunwayAwarenessApi(app, { controller, loop: false, env: {} });
  return app;
}

async function postLevel(base, body) {
  const res = await fetch(`${base}/api/runway/level`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('runway awareness geometry', () => {
  it('rolls right for a nose-right heading and left for a right offset', () => {
    const heading = rollPwmFromEstimate({ detected: true, heading_error_deg: 5, offset_m: 0 });
    const offset = rollPwmFromEstimate({ detected: true, heading_error_deg: 0, offset_m: 3 });
    expect(heading).toBeGreaterThan(1500);
    expect(offset).toBeLessThan(1500);
    expect(computeGuidance(STRIP).kind).toBe('ROLL_OVERRIDE');
    expect(rollPwmFromEstimate({ detected: false })).toBeNull();
  });

  it('refuses every level except a clean SITL guidance tick', () => {
    expect(authorizeRunway({ level: 0, sitl: true }).allow).toBe(false);
    expect(authorizeRunway({ level: 1, sitl: true }).reason).toBe('observe_only');
    expect(authorizeRunway({ level: 2, sitl: true }).reason).toBe('observe_only');
    expect(authorizeRunway({ level: 3, sitl: false }).reason).toBe('not_sitl');
    expect(authorizeRunway({ level: 3, sitl: true, hazards: [{ kind: 'person' }] }).reason).toBe('hazard');
    expect(authorizeRunway({ level: 3, sitl: true }).allow).toBe(true);
    expect(authorizeRunway({ level: 4, sitl: true, unlock: true, confirmed: false }).reason).toBe('level4_locked');
  });
});

describe('runway awareness SITL command gate', () => {
  const servers = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it('sends zero commands at levels 0, 1 and 2 even against SITL', async () => {
    const calls = [];
    const controller = createRunwayController({
      env: {},
      link: { sendGuidance(cmd) { calls.push(cmd); return { sent: true }; } },
    });
    const server = await listen(appFor(controller));
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const sitl = { simulator: true, connected: true };

    for (const level of [0, 1, 2]) {
      const posted = await postLevel(base, { level });
      expect(posted.status).toBe(200);
      expect(posted.body.ok).toBe(true);
      const ticked = controller.tick({ estimate: STRIP, vehicle: sitl });
      expect(ticked.sentNow).toBe(0);
      expect(ticked.decision.allow).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(controller.commandsSent()).toBe(0);

    const read = await fetch(`${base}/api/runway/awareness`);
    const body = await read.json();
    expect(body.commandsSent).toBe(0);
    expect(body.allowSend).toBe(false);
    expect(body.flightCommands).toBe(false);
    expect(calls).toEqual([]);
  });

  it('sends one roll override at level 3 only while SITL is detected', async () => {
    const calls = [];
    const controller = createRunwayController({
      env: {},
      link: { sendGuidance(cmd) { calls.push(cmd); return { sent: true }; } },
    });
    const server = await listen(appFor(controller));
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    await postLevel(base, { level: 3 });
    const live = await fetch(`${base}/api/runway/awareness`);
    await live.json();
    expect(calls).toEqual([]);

    const blocked = controller.tick({
      estimate: STRIP,
      vehicle: { simulator: false, connected: true },
    });
    expect(blocked.sentNow).toBe(0);
    expect(blocked.decision.reason).toBe('not_sitl');

    const sent = controller.tick({
      estimate: STRIP,
      vehicle: { simulator: true, connected: true },
    });
    expect(sent.sentNow).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('ROLL_OVERRIDE');
    expect(calls[0].rollPwm).toBeGreaterThanOrEqual(1100);
    expect(calls[0].rollPwm).toBeLessThanOrEqual(1900);

    const hazard = controller.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'person', label_he: 'אדם' }] },
      vehicle: { simulator: true, connected: true },
    });
    expect(hazard.decision.reason).toBe('hazard');
    expect(hazard.sentNow).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].release).toBe(true);
    expect(calls[1].rollPwm).toBe(0);
    controller.tick({
      estimate: { ...STRIP, hazards: [{ kind: 'person', label_he: 'אדם' }] },
      vehicle: { simulator: true, connected: true },
    });
    expect(calls).toHaveLength(2);
  });

  it('releases the override once when the level drops or the link drops, and never off SITL', async () => {
    const calls = [];
    const controller = createRunwayController({
      env: {},
      link: { sendGuidance(cmd) { calls.push(cmd); return { sent: true }; } },
    });
    const sitl = { simulator: true, connected: true };
    controller.setLevel({ level: 3 });
    controller.tick({ estimate: STRIP, vehicle: sitl });
    expect(calls).toHaveLength(1);
    expect(calls[0].release).toBeUndefined();

    controller.setLevel({ level: 1 });
    const dropped = controller.tick({ estimate: STRIP, vehicle: sitl });
    expect(dropped.sentNow).toBe(1);
    expect(calls[1]).toMatchObject({ release: true, rollPwm: 0 });
    controller.tick({ estimate: STRIP, vehicle: sitl });
    expect(calls).toHaveLength(2);

    controller.setLevel({ level: 3 });
    controller.tick({ estimate: STRIP, vehicle: sitl });
    const denied = controller.tick({
      estimate: STRIP,
      vehicle: { simulator: false, connected: true },
    });
    expect(denied.sentNow).toBe(0);
    expect(calls.filter((cmd) => cmd.release).length).toBe(1);

    controller.setLevel({ level: 3 });
    controller.tick({ estimate: STRIP, vehicle: sitl });
    const lost = controller.tick({
      estimate: STRIP,
      vehicle: { simulator: true, connected: false },
    });
    expect(lost.sentNow).toBe(1);
    expect(calls.at(-1)).toMatchObject({ release: true, rollPwm: 0 });
    controller.tick({
      estimate: STRIP,
      vehicle: { simulator: true, connected: false },
    });
    expect(calls.filter((cmd) => cmd.release).length).toBe(2);
  });

  it('keeps level 4 locked, and a confirmed unlock still sends nothing off SITL', async () => {
    const lockedCalls = [];
    const locked = createRunwayController({
      env: {},
      link: { sendGuidance(cmd) { lockedCalls.push(cmd); return { sent: true }; } },
    });
    const lockedServer = await listen(appFor(locked));
    servers.push(lockedServer);
    const lockedBase = `http://127.0.0.1:${lockedServer.address().port}`;
    const refused = await postLevel(lockedBase, { level: 4, confirm: true, phrase: 'מאשר' });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe('level4_locked');
    expect(refused.body.messageHe).toMatch(/נעולה/);
    locked.tick({ estimate: STRIP, vehicle: { simulator: true, connected: true } });
    expect(lockedCalls).toEqual([]);
    expect(locked.status().level).toBe(0);

    const calls = [];
    const controller = createRunwayController({
      env: { VLC_RUNWAY_LEVEL4_UNLOCK: '1' },
      link: { sendGuidance(cmd) { calls.push(cmd); return { sent: true }; } },
    });
    const server = await listen(appFor(controller));
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const missing = await postLevel(base, { level: 4, confirm: true, phrase: 'כן' });
    expect(missing.status).toBe(403);
    const accepted = await postLevel(base, { level: 4, confirm: true, phrase: 'מאשר' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.level).toBe(4);
    const offSim = controller.tick({
      estimate: STRIP,
      vehicle: { simulator: false, connected: true },
    });
    expect(offSim.sentNow).toBe(0);
    expect(offSim.decision.reason).toBe('not_sitl');
    expect(calls).toEqual([]);
    const onSim = controller.tick({
      estimate: STRIP,
      vehicle: { simulator: true, connected: true },
    });
    expect(onSim.sentNow).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe('RC_CHANNELS_OVERRIDE stays inside SITL', () => {
  function link(simulator) {
    const frames = [];
    const conn = Object.create(MavlinkConnection.prototype);
    conn.frames = frames;
    conn._send = (frame) => { frames.push(frame); };
    conn._seq = 3;
    conn._preferredTxVersion = 2;
    conn.connected = true;
    conn.sysId = 1;
    conn.fcTargetCompId = 1;
    conn.simulatorDetection = () => ({ simulator });
    conn.getStatus = () => ({ simulator });
    return conn;
  }

  it('throws and writes no frame when the vehicle is not a simulator', () => {
    const conn = link(false);
    expect(() => conn.sendRunwayRollOverride(1600)).toThrowError(expect.objectContaining({ code: 'not_sitl' }));
    expect(conn.frames).toHaveLength(0);
  });

  const PYMAVLINK_SKIP = 'pymavlink is not installed. Install pymavlink to decode RC_CHANNELS_OVERRIDE wire order.';

  function pymavlinkInstalled() {
    const run = spawnSync('python3', ['-c', 'import pymavlink'], { encoding: 'utf8' });
    return run.status === 0;
  }

  function pymavlinkDecode(frame) {
    const script = [
      'import sys',
      'from pymavlink.dialects.v20 import common as mav',
      'parser = mav.MAVLink(None)',
      'msg = parser.decode(bytearray(bytes.fromhex(sys.argv[1])))',
      'chans = [getattr(msg, f"chan{i}_raw") for i in range(1, 19)]',
      'print(msg.get_type(), msg.target_system, msg.target_component, ",".join(str(c) for c in chans))',
    ].join('\n');
    const run = spawnSync('python3', ['-c', script, frame.toString('hex')], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const [type, target, comp, chans] = run.stdout.trim().split(' ');
    return {
      type,
      target: Number(target),
      comp: Number(comp),
      channels: chans.split(',').map(Number),
    };
  }

  it('writes one roll override and pymavlink reads the wire order', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    for (const version of [1, 2]) {
      const conn = link(true);
      conn._preferredTxVersion = version;
      conn.sysId = 7;
      conn.fcTargetCompId = 1;
      const frame = conn.sendRunwayRollOverride(1500);
      expect(conn.frames).toHaveLength(1);
      const decoded = pymavlinkDecode(frame);
      expect(decoded.type).toBe('RC_CHANNELS_OVERRIDE');
      expect(decoded.target).toBe(7);
      expect(decoded.comp).toBe(1);
      expect(decoded.channels[0]).toBe(1500);
      expect(decoded.channels.slice(1).every((value) => value === 0)).toBe(true);
      expect(decoded.target).not.toBe(220);
      expect(decoded.comp).not.toBe(5);
    }
  });

  it('releases every channel with one all-zero override', (ctx) => {
    ctx.skip(!pymavlinkInstalled(), PYMAVLINK_SKIP);
    const conn = link(true);
    conn.connected = false;
    conn.sysId = 7;
    conn.fcTargetCompId = 1;
    const frame = conn.sendRunwayRollOverride(1500, { release: true });
    const decoded = pymavlinkDecode(frame);
    expect(decoded.target).toBe(7);
    expect(decoded.comp).toBe(1);
    expect(decoded.channels.every((value) => value === 0)).toBe(true);
    expect(() => conn.sendRunwayRollOverride(1500)).toThrowError(expect.objectContaining({ code: 'no_link' }));
    expect(conn.frames).toHaveLength(1);
  });
});
