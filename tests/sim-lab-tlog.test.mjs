import { describe, it, expect } from 'vitest';
import { buildMavlink1Frame, parseHeartbeat } from '../lib/mavlink-connection.mjs';
import { buildReplaySamplesFromBuffer } from '../lib/sim-lab-tlog.mjs';

const MSG_HEARTBEAT = 0;
const MSG_ATTITUDE = 30;
const MSG_STATUSTEXT = 253;

function hbPayload(customMode = 0, baseMode = 0) {
  const p = Buffer.alloc(9);
  p.writeUInt32LE(customMode & 0xffffffff, 0);
  p[4] = 1; // fixed wing
  p[5] = 3; // ArduPilot
  p[6] = baseMode & 0xff;
  p[7] = 3;
  p[8] = 3;
  return p;
}

function attitudePayload(timeBootMs) {
  const p = Buffer.alloc(28);
  p.writeUInt32LE(timeBootMs | 0, 0);
  p.writeFloatLE(-0.1, 4);
  p.writeFloatLE(0.06, 8);
  p.writeFloatLE(0.87, 12);
  return p;
}

function statustextPayload(text, severity = 4) {
  const b = Buffer.from(text, 'utf8');
  const p = Buffer.alloc(1 + Math.min(50, b.length));
  p.writeUInt8(severity & 0xff, 0);
  b.copy(p, 1, 0, Math.min(50, b.length));
  return p;
}

describe('sim-lab SITL tlog replay analyzer', () => {
  it('buildReplaySamplesFromBuffer extracts STATUSTEXT + ARM heartbeat edges with sampleIndexApprox hints', () => {
    let seq = 0;
    const buf = Buffer.concat([
      buildMavlink1Frame(MSG_ATTITUDE, attitudePayload(6000), seq++),
      buildMavlink1Frame(MSG_HEARTBEAT, hbPayload(0, 0), seq++),
      buildMavlink1Frame(MSG_ATTITUDE, attitudePayload(6180), seq++),
      buildMavlink1Frame(MSG_STATUSTEXT, statustextPayload('SITL: arm motors'), seq++),
      buildMavlink1Frame(MSG_HEARTBEAT, hbPayload(0, 0x80 /* MAV_ARMED */), seq++),
      buildMavlink1Frame(MSG_ATTITUDE, attitudePayload(6280), seq++),
    ]);

    const parsed = buildReplaySamplesFromBuffer(buf, { maxSamples: 5000, minStepMs: 40 });
    expect(parsed.samples.length).toBeGreaterThanOrEqual(2);

    const kinds = (parsed.replayEvents || []).map((e) => e.kind).filter(Boolean);
    expect(kinds).toContain('statustext');
    expect(kinds).toContain('arm');

    const stEv = parsed.replayEvents.find((e) => e.kind === 'statustext');
    expect(stEv?.sampleIndexApprox).toBeGreaterThanOrEqual(0);

    expect(parseHeartbeat(hbPayload(0, 0x80))).toMatchObject({ customMode: 0 });
    expect(parsed.replayEvents.length).toBeLessThanOrEqual(400);
  });

  it('replay flight_mode events use ArduPlane mode names in Hebrew labels', () => {
    let seq = 0;
    const buf = Buffer.concat([
      buildMavlink1Frame(MSG_ATTITUDE, attitudePayload(1000), seq++),
      buildMavlink1Frame(MSG_HEARTBEAT, hbPayload(5, 0), seq++),
      buildMavlink1Frame(MSG_HEARTBEAT, hbPayload(10, 0), seq++),
    ]);
    const parsed = buildReplaySamplesFromBuffer(buf, { maxSamples: 100, minStepMs: 40 });
    const fm = (parsed.replayEvents || []).filter((e) => e.kind === 'flight_mode');
    expect(fm.length).toBe(1);
    expect(fm[0].label).toContain('AUTO');
    expect(fm[0].label).toContain('10');

    let seq2 = 0;
    const buf2 = Buffer.concat([
      buildMavlink1Frame(MSG_ATTITUDE, attitudePayload(2000), seq2++),
      buildMavlink1Frame(MSG_HEARTBEAT, hbPayload(0, 0), seq2++),
      buildMavlink1Frame(MSG_HEARTBEAT, hbPayload(99999, 0), seq2++),
    ]);
    const p2 = buildReplaySamplesFromBuffer(buf2, { maxSamples: 100, minStepMs: 40 });
    const fm2 = (p2.replayEvents || []).filter((e) => e.kind === 'flight_mode');
    expect(fm2.length).toBe(1);
    expect(fm2[0].label).toContain('99999');
    expect(fm2[0].label).toContain('לא מוכר');
  });
});
