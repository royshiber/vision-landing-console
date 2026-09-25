import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MavlinkConnection,
  buildMavlink2Frame,
  mavlinkCrcExtra,
  parseSysStatus,
  parseGpsRawInt,
  parseVfrHud,
  parseRcChannels,
  parseMemInfo,
  parseMcuStatus,
  parseBatteryStatus,
  parsePowerStatus,
  pickLiveMavlinkConnection,
} from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

const HEX = {
  heartbeat: '000000000103510303',
  sys: '1ffc60130f8040130b801002130009005d000000000000000000000000005f',
  gps: '0000000000000000000000000000000000000000ffffffff',
  rc: '91b40800dc05dc050000dc05',
  vfr: '00000000000000005c8f823f81ac343c6601',
  power: '00',
  battery: '9000000000000000ff7f0900ffffffffffffffffffffffffffffffffffff5d000000005f0000000001',
  mem: '0000ffff503b09',
  mcu: 'a513d50cc10cea0c',
};

function hexBuf(hex) {
  return Buffer.from(hex, 'hex');
}

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

describe('captured FC telemetry payloads', () => {
  it('does not borrow a low-byte CRC extra for MCU_STATUS 11039', () => {
    expect(mavlinkCrcExtra(11039)).toBe(142);
    expect(mavlinkCrcExtra(11039)).not.toBe(mavlinkCrcExtra(31));
  });

  it('decodes the captured SYS_STATUS, MEMINFO, MCU, VFR, RC, GPS, battery, and power bytes', () => {
    const sys = parseSysStatus(hexBuf(HEX.sys));
    expect(sys.load_pct).toBeCloseTo(1.9, 5);
    expect(sys.voltage_V).toBeCloseTo(0.01, 5);
    expect(sys.current_A).toBeCloseTo(0.93, 5);
    expect(sys.remaining_pct).toBe(95);

    const mem = parseMemInfo(hexBuf(HEX.mem));
    expect(mem.freeBytes).toBe(605008);
    expect(mem.freeKB).toBeCloseTo(590.8, 1);

    const mcu = parseMcuStatus(hexBuf(HEX.mcu));
    expect(mcu.tempC).toBeCloseTo(50.29, 2);
    expect(mcu.voltageV).toBeCloseTo(3.285, 3);

    const vfr = parseVfrHud(hexBuf(HEX.vfr));
    expect(vfr.alt).toBeCloseTo(1.0, 1);
    expect(vfr.heading).toBe(358);
    expect(vfr.throttle).toBe(0);

    const rc = parseRcChannels(hexBuf(HEX.rc));
    expect(rc.chan1_raw).toBe(1500);
    expect(rc.chan3_raw).toBe(0);
    expect(rc.chancount).toBe(0);

    const gps = parseGpsRawInt(hexBuf(HEX.gps));
    expect(gps.fixType).toBe(0);
    expect(gps.satellites).toBe(0);
    expect(gps.lat).toBeNull();
    expect(gps.lon).toBeNull();

    const bat = parseBatteryStatus(hexBuf(HEX.battery));
    expect(bat.consumed_mAh).toBe(144);
    expect(bat.remaining_pct).toBe(95);
    expect(bat.temperature_c).toBeNull();

    expect(parsePowerStatus(hexBuf(HEX.power)).vcc_V).toBeNull();
  });

  it('reads a synthetic GPS_RAW_INT fix at the wire offsets', () => {
    const p = Buffer.alloc(30);
    p.writeInt32LE(Math.round(32.01 * 1e7), 8);
    p.writeInt32LE(Math.round(34.78 * 1e7), 12);
    p.writeUInt8(3, 28);
    p.writeUInt8(12, 29);
    const g = parseGpsRawInt(p);
    expect(g.fixType).toBe(3);
    expect(g.satellites).toBe(12);
    expect(g.lat).toBeCloseTo(32.01, 5);
    expect(g.lon).toBeCloseTo(34.78, 5);
    p.writeUInt8(255, 29);
    expect(parseGpsRawInt(p).satellites).toBeNull();
  });

  it('does not treat drop_rate_comm at offset 18 as battery remaining', () => {
    const p = Buffer.alloc(19);
    p.writeInt8(77, 18);
    expect(parseSysStatus(p).remaining_pct).toBe(0);
  });
});

describe('locked FC telemetry and link pick', () => {
  function feed(conn, msgId, hex, sysId = 51, compId = 1) {
    conn._handleData(buildMavlink2Frame(msgId, hexBuf(hex), conn._seq++, sysId, compId));
  }

  it('stores fixture metrics only from the locked autopilot', () => {
    const conn = new MavlinkConnection({ id: 7, name: 'fc', type: 'tcp', host: '127.0.0.1', port: 5770 });
    feed(conn, 1, HEX.sys);
    expect(conn.lastBattery).toBeNull();
    feed(conn, 0, HEX.heartbeat);
    expect(conn.sysId).toBe(51);
    feed(conn, 1, HEX.sys);
    feed(conn, 152, HEX.mem);
    feed(conn, 11039, HEX.mcu);
    feed(conn, 147, HEX.battery);
    feed(conn, 65, HEX.rc);
    feed(conn, 74, HEX.vfr);
    feed(conn, 24, HEX.gps);
    feed(conn, 125, HEX.power);
    const status = conn.getStatus();
    expect(status.sysId).toBe(51);
    expect(status.fcLoadPct).toBeCloseTo(1.9, 5);
    expect(status.fcMemFreeKB).toBeCloseTo(590.8, 1);
    expect(status.fcMemPct).toBeNull();
    expect(status.fcTempC).toBeCloseTo(50.29, 2);
    expect(status.fcMcuVoltageV).toBeCloseTo(3.285, 3);
    expect(status.batteryV).toBeCloseTo(0.01, 5);
    expect(status.batteryPct).toBe(95);
    expect(status.batteryConsumedMah).toBe(144);
    expect(status.batteryCurrentA).toBeCloseTo(0.93, 5);
    expect(status.powerVccV).toBeNull();
    expect(status.gpsFixType).toBe(0);
    expect(status.gpsSats).toBe(0);
    expect(status.rcChannels.chan1_raw).toBe(1500);
    expect(status.rcChannels.chan3_raw).toBe(0);

    const other = hexBuf(HEX.sys);
    other.writeUInt16LE(800, 12);
    conn._handleData(buildMavlink2Frame(1, other, 3, 9, 1));
    expect(conn.getStatus().fcLoadPct).toBeCloseTo(1.9, 5);
  });

  it('prefers a heartbeat-live TCP link over a listening cellular socket', () => {
    const tcp = { id: 1, linkRole: 'radio', connected: true, listening: false, heartbeatCount: 20 };
    const udp = { id: 2, linkRole: 'cellular', connected: false, listening: true, heartbeatCount: 0, sysId: null };
    expect(pickLiveMavlinkConnection([udp, tcp], 2)).toBe(tcp);
    expect(pickLiveMavlinkConnection([udp], null)).toBe(udp);
    const snap = buildSseMavlinkSnapshot(udp);
    expect(snap.sysId).toBeNull();
    expect(snap.connected).toBe(false);
    expect(snap.listening).toBe(true);
  });

  it('passes fresh FC fields through SSE and nulls stale ones', () => {
    const now = Date.now();
    const fresh = buildSseMavlinkSnapshot({
      connected: true,
      sysId: 51,
      heartbeatCount: 4,
      lastBattery: { load_pct: 1.9, voltage_V: 0.01, current_A: 0.93, remaining_pct: 90, receivedWallMs: now },
      lastBatteryStatus: { consumed_mAh: 144, remaining_pct: 95, current_A: 0.93, receivedWallMs: now },
      lastMeminfo: { freeKB: 590.828125, receivedWallMs: now },
      lastMcuStatus: { tempC: 50.29, voltageV: 3.285, receivedWallMs: now },
      lastPowerStatus: { vcc_V: null, receivedWallMs: now },
    });
    expect(fresh.sysId).toBe(51);
    expect(fresh.fcLoadPct).toBeCloseTo(1.9, 5);
    expect(fresh.fcMemFreeKB).toBeCloseTo(590.8, 1);
    expect(fresh.fcMemPct).toBeNull();
    expect(fresh.fcTempC).toBeCloseTo(50.29, 2);
    expect(fresh.fcMcuVoltageV).toBeCloseTo(3.285, 3);
    expect(fresh.batteryV).toBeCloseTo(0.01, 5);
    expect(fresh.batteryPct).toBe(95);
    expect(fresh.batteryConsumedMah).toBe(144);
    expect(fresh.powerVccV).toBeNull();

    const stale = buildSseMavlinkSnapshot({
      connected: true,
      sysId: 51,
      lastBattery: { load_pct: 1.9, voltage_V: 12, remaining_pct: 90, receivedWallMs: now - 6000 },
      lastMeminfo: { freeKB: 590.8, receivedWallMs: now - 6000 },
      lastMcuStatus: { tempC: 50.29, voltageV: 3.285, receivedWallMs: now - 6000 },
    });
    expect(stale.fcLoadPct).toBeNull();
    expect(stale.batteryV).toBeNull();
    expect(stale.fcMemFreeKB).toBeNull();
    expect(stale.fcTempC).toBeNull();
    expect(stale.fcMemPct).toBeNull();
  });

  it('does not turn a missing sysId into 0', () => {
    expect(buildSseMavlinkSnapshot({ connected: false, listening: true, sysId: null }).sysId).toBeNull();
  });
});

describe('status card and HUD keep real FC metrics', () => {
  it('a listening-only snapshot is מנותק, and a live heartbeat shows free KB', () => {
    const src = [
      sliceFunction(js, 'companionFiniteMetric'),
      sliceFunction(js, 'pulseMavlinkLive'),
      sliceFunction(js, 'pulseFcObject'),
      sliceFunction(js, 'pulseCompanionFcLink'),
      sliceFunction(js, 'pulseResolveFcHonesty'),
      sliceFunction(js, 'formatComputerMetric'),
      'return { pulseMavlinkLive, pulseResolveFcHonesty, formatComputerMetric };',
    ].join('\n');
    const ui = new Function(src)();
    const listener = { connected: false, listening: true, sysId: 0, heartbeatCount: 0 };
    expect(ui.pulseMavlinkLive(listener)).toBe(false);
    const down = ui.pulseResolveFcHonesty({}, listener);
    expect(down.labelHe).toBe('מנותק');
    expect(down.gaugeMissing).toBe('--');
    expect(down.showGcsMissingNote).toBe(false);

    const live = ui.pulseResolveFcHonesty({}, {
      connected: true,
      heartbeatCount: 12,
      lastHeartbeatAgeMs: 200,
      fcLoadPct: 1.9,
      fcMemFreeKB: 590.828125,
      fcMemPct: null,
      fcTempC: 50.29,
    });
    expect(live.labelHe).toBe('דופק חי');
    expect(live.showGcsMissingNote).toBe(false);
    expect(live.mem).toBeNull();
    expect(live.memFreeKB).toBeCloseTo(590.8, 1);
    expect(ui.formatComputerMetric(1.9, '%', '--')).toBe('2%');
    expect(ui.formatComputerMetric(live.memFreeKB, 'KBfree', '--')).toBe('591 KB פנוי');
    expect(ui.formatComputerMetric(50.29, 'C', '--')).toBe('50.3°C');
  });

  it('resolveHudMavlink fallback keeps FC metrics from the SSE object', () => {
    const src = [
      'let latestHudMavlink = null;',
      sliceFunction(js, 'isHudMavlinkLive'),
      sliceFunction(js, 'hudSysId'),
      sliceFunction(js, 'hudFiniteOrNull'),
      sliceFunction(js, 'hudFcMetricFields'),
      sliceFunction(js, 'preferHudFcMetrics'),
      sliceFunction(js, 'liveStatusToHudMavlink'),
      sliceFunction(js, 'resolveHudMavlink'),
      `return resolveHudMavlink(${JSON.stringify({
        connected: false,
        fcLoadPct: 1.9,
        fcMemFreeKB: 590.8,
        fcMemPct: null,
        fcTempC: 50.29,
        fcMcuVoltageV: 3.285,
        batteryV: 0.01,
        batteryPct: 95,
        batteryCurrentA: 0.93,
        batteryConsumedMah: 144,
        gpsFixType: 3,
        gpsSats: 12,
        rcChannels: { chan1_raw: 1500, chan3_raw: 0 },
      })}, ${JSON.stringify({
        connected: true,
        heartbeatCount: 4,
        sysId: 51,
        lastHeartbeatAgeMs: 100,
      })});`,
    ].join('\n');
    const hud = new Function(src)();
    expect(hud.fcLoadPct).toBeCloseTo(1.9, 5);
    expect(hud.fcMemFreeKB).toBeCloseTo(590.8, 1);
    expect(hud.fcTempC).toBeCloseTo(50.29, 2);
    expect(hud.fcMcuVoltageV).toBeCloseTo(3.285, 3);
    expect(hud.batteryV).toBeCloseTo(0.01, 5);
    expect(hud.batteryPct).toBe(95);
    expect(hud.batteryConsumedMah).toBe(144);
    expect(hud.gpsFixType).toBe(3);
    expect(hud.gpsSats).toBe(12);
    expect(hud.rcChannels.chan1_raw).toBe(1500);
    expect(hud.sysId).toBe(51);
  });
});
