import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { state } = vi.hoisted(() => ({ state: { conn: null } }));

vi.mock('../lib/mavlink-connection.mjs', async () => {
  const actual = await vi.importActual('../lib/mavlink-connection.mjs');
  return {
    ...actual,
    getActiveConnection: () => state.conn,
  };
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('ARM DISARM command frame', () => {
  it('writes normal arm and disarm and never the force value', async () => {
    const {
      ARM_DISARM_FORCE_MAGIC,
      MAV_CMD_COMPONENT_ARM_DISARM,
      assertNotForceDisarm,
      buildArmDisarmPayload,
      isVehicleFlying,
      prearmFailureText,
    } = await import('../lib/arm-disarm.mjs');
    const arm = buildArmDisarmPayload(1, 1, true);
    const disarm = buildArmDisarmPayload(1, 1, false);
    expect(arm.readFloatLE(0)).toBe(1);
    expect(disarm.readFloatLE(0)).toBe(0);
    expect(arm.readFloatLE(4)).toBe(0);
    expect(disarm.readFloatLE(4)).toBe(0);
    expect(arm.readFloatLE(4)).not.toBe(ARM_DISARM_FORCE_MAGIC);
    expect(arm.readUInt16LE(28)).toBe(MAV_CMD_COMPONENT_ARM_DISARM);
    expect(arm.readUInt16LE(28)).toBe(400);
    expect(arm[30]).toBe(1);
    expect(arm[31]).toBe(1);
    expect(arm[32]).toBe(0);
    expect(() => assertNotForceDisarm(21196)).toThrow(/force disarm blocked/);
    expect(isVehicleFlying({ lastLandedState: 4, lastLandedStateAt: Date.now() })).toBe(false);
    expect(isVehicleFlying({ lastLandedState: 1, lastLandedStateAt: Date.now() })).toBe(false);
    expect(isVehicleFlying({ lastLandedState: 2, lastLandedStateAt: Date.now() - 6000 })).toBe(false);
    expect(isVehicleFlying({ lastLandedState: 2, lastLandedStateAt: Date.now() })).toBe(true);
    expect(isVehicleFlying({ lastLandedState: 3, lastLandedStateAt: Date.now() })).toBe(true);
    const { flightStateForDisarm } = await import('../lib/arm-disarm.mjs');
    expect(flightStateForDisarm({}).needsSecondConfirm).toBe(true);
    expect(flightStateForDisarm({}).uncertain).toBe(true);
    expect(flightStateForDisarm({ lastLandedState: null, lastLandedStateAt: Date.now() }).uncertain).toBe(true);
    expect(flightStateForDisarm({ lastLandedState: 2, lastLandedStateAt: Date.now() - 6000 }).uncertain).toBe(true);
    expect(flightStateForDisarm({ lastLandedState: 1, lastLandedStateAt: Date.now() }).needsSecondConfirm).toBe(false);
    expect(prearmFailureText([{ text: 'hello' }, { text: 'PreArm: Need GPS' }])).toBe('PreArm: Need GPS');
    expect(prearmFailureText(['ok'])).toBe(null);
  });

  it('sends command 400 on the existing connection and keeps voice blocked', async () => {
    const { MavlinkConnection } = await import('../lib/mavlink-connection.mjs');
    const { applyAskFlightOp } = await import('../lib/flight-actions-service.mjs');
    const conn = new MavlinkConnection({ id: 91, name: 'arm', type: 'udp', port: 1 });
    conn.connected = true;
    conn.lastBaseMode = 81;
    const frames = [];
    conn._send = (frame) => { frames.push(frame); };
    const pending = conn.sendComponentArmDisarm({ arm: true, timeoutMs: 300 });
    conn.emit('statustext', { text: 'PreArm: Need GPS' });
    conn.emit('command-ack', { command: 400, result: 4 });
    const out = await pending;
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame[5]).toBe(76);
    expect(frame.readFloatLE(6)).toBe(1);
    expect(frame.readFloatLE(10)).toBe(0);
    expect(frame.readFloatLE(10)).not.toBe(21196);
    expect(frame.readUInt16LE(34)).toBe(400);
    expect(out.ack.result).toBe(4);
    expect(out.texts).toContain('PreArm: Need GPS');
    conn.connected = false;
    try {
      conn.sendComponentArmDisarm({ arm: false });
      throw new Error('expected no telemetry');
    } catch (err) {
      expect(err.code).toBe('no_telemetry');
    }
    conn.connected = true;
    expect(() => conn.setArduPlaneMode(11, { reason: 'ARM' })).toThrow(/blocked/);
    const sendComponentArmDisarm = vi.fn();
    const voice = await applyAskFlightOp(null, {
      kind: 'DISARM',
      mavConn: { connected: true, setArduPlaneMode: vi.fn(), sendDoLandStart: vi.fn(), sendComponentArmDisarm },
    });
    expect(voice.blocked).toBe(true);
    expect(voice.sent).toBe(false);
    expect(voice.error).toBe('blocked_arm');
    expect(sendComponentArmDisarm).not.toHaveBeenCalled();
  });
});

describe('ARM DISARM http', () => {
  let server;
  let base;

  afterEach(async () => {
    state.conn = null;
    if (server) await close(server);
    server = null;
  });

  async function start() {
    const { registerArmDisarmApi } = await import('../lib/routes/arm-disarm-api.mjs');
    const app = express();
    app.use(express.json());
    registerArmDisarmApi(app);
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  }

  async function post(body) {
    const res = await fetch(`${base}/api/mavlink/arm-disarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }

  it('refuses force, missing telemetry, and disarm in the air before a second confirm', async () => {
    await start();
    const send = vi.fn(async () => ({ ack: { result: 0 }, texts: [] }));
    state.conn = null;
    let res = await post({ action: 'arm' });
    expect(res.status).toBe(422);
    expect(res.data.sent).toBe(false);
    expect(res.data.error).toBe('no_telemetry');
    state.conn = {
      connected: false,
      lastBaseMode: 81,
      statusTexts: [],
      sendComponentArmDisarm: send,
    };
    res = await post({ action: 'disarm', param2: 21196 });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('force_disarm_blocked');
    expect(send).not.toHaveBeenCalled();
    state.conn = {
      connected: true,
      lastBaseMode: 209,
      lastLandedState: 2,
      lastLandedStateAt: Date.now(),
      statusTexts: [],
      sendComponentArmDisarm: send,
    };
    res = await post({ action: 'disarm' });
    expect(res.status).toBe(409);
    expect(res.data.sent).toBe(false);
    expect(res.data.error).toBe('flying');
    expect(send).not.toHaveBeenCalled();
    res = await post({ action: 'arm', force: true });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ ack: { result: 4 }, texts: ['PreArm: Need GPS'] });
    res = await post({ action: 'arm' });
    expect(res.data.sent).toBe(true);
    expect(res.data.ok).toBe(false);
    expect(res.data.prearm).toBe('PreArm: Need GPS');
    expect(send).toHaveBeenCalledWith({ arm: true });
    res = await post({ action: 'disarm', confirmFlying: true });
    expect(res.data.sent).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ arm: false });
    state.conn = {
      connected: true,
      lastBaseMode: 209,
      lastLandedState: null,
      lastLandedStateAt: null,
      statusTexts: [],
      sendComponentArmDisarm: send,
    };
    res = await post({ action: 'disarm' });
    expect(res.status).toBe(409);
    expect(res.data.sent).toBe(false);
    expect(res.data.error).toBe('flight_state_unknown');
    expect(res.data.flightStateUnknown).toBe(true);
    expect(res.data.message).toMatch(/מצב הטיסה לא ידוע/);
    expect(send).toHaveBeenCalledTimes(2);
    state.conn.lastLandedState = 1;
    state.conn.lastLandedStateAt = Date.now() - 6000;
    res = await post({ action: 'disarm' });
    expect(res.status).toBe(409);
    expect(res.data.error).toBe('flight_state_unknown');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('ARM DISARM ui contract', () => {
  it('keeps Hebrew labels, a hold, and no force value in the page', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
    const js = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
    const css = fs.readFileSync(path.join(repoRoot, 'public/styles.css'), 'utf8');
    expect(html).toContain('id="flightArmBtn"');
    expect(html).toContain('חימוש ARM');
    expect(html).toContain('נטרול DISARM');
    expect(html).toContain('אין חיבור לבקר הטיסה');
    expect(html).not.toContain('21196');
    expect(html).toContain('אשרו חימוש');
    expect(html).toContain('אשרו נטרול');
    expect(js).toContain('openFlightArmDialog');
    expect(js).toContain('FLIGHT_ARM_HOLD_MS = 1500');
    expect(js).toContain('initFlightArmControls();');
    expect(js).not.toContain('21196');
    const armCss = css.slice(css.indexOf('#flightArmRow'), css.indexOf('#flightArmRow') + 1800);
    expect(armCss).toMatch(/font-size:\s*clamp\(11px/);
    expect(armCss).not.toMatch(/text-overflow:\s*ellipsis/);
  });
});
