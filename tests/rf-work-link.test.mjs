import { describe, expect, it } from 'vitest';
import {
  activePathLabelHe,
  chooseWorkPath,
  planWorkLink,
  probeHttpUrls,
  RF_REDUCED_REASON_HE,
} from '../lib/rf-work-link.mjs';
import {
  buildRfRequestDataStreamPayload,
  buildRfSetMessageIntervalPayload,
  hudMessageRateTargets,
  RF_STREAM_INTERVAL_US,
  RF_STREAM_RATE_HZ,
} from '../lib/mavlink-connection.mjs';

describe('RF work link', () => {
  it('keeps one chosen path and falls back to RF only when every HTTP URL fails', () => {
    expect(chooseWorkPath({ mode: 'home', httpResults: [], serialPort: 'COM4' }).path).toBe('home');
    expect(chooseWorkPath({ mode: 'cellular', httpResults: [{ id: 'home', ok: true }], serialPort: 'COM4' }).path).toBe('cellular');
    const forced = chooseWorkPath({ mode: 'rf', httpResults: [{ id: 'home', ok: true }], serialPort: 'COM4' });
    expect(forced.path).toBe('rf');
    expect(forced.reduced).toBe(true);
    expect(forced.reasonHe).toBe(RF_REDUCED_REASON_HE);
    const autoHttp = chooseWorkPath({
      mode: 'auto',
      httpResults: [{ id: 'home', ok: false }, { id: 'cellular', ok: true }],
      serialPort: 'COM4',
    });
    expect(autoHttp.path).toBe('cellular');
    expect(autoHttp.reduced).toBe(false);
    const autoRf = chooseWorkPath({
      mode: 'auto',
      httpResults: [{ id: 'home', ok: false }, { id: 'cellular', ok: false }],
      serialPort: 'COM4',
    });
    expect(autoRf.path).toBe('rf');
    expect(autoRf.fallback).toBe(true);
    expect(planWorkLink({ mode: 'auto', httpResults: [], serialPort: '' }).path).toBe('none');
    expect(activePathLabelHe('rf')).toBe('נתיב פעיל: RF');
  });

  it('treats a failed probe as down and a 200 as up', async () => {
    const rows = await probeHttpUrls(
      ['http://192.168.1.20:8081', 'http://100.82.1.5:8081'],
      async (url) => ({ ok: url.includes('192.168') }),
    );
    expect(rows.map((row) => [row.id, row.ok])).toEqual([
      ['home', true],
      ['cellular', false],
    ]);
  });

  it('asks the radio for a low little-endian stream rate', () => {
    const normal = hudMessageRateTargets();
    const rf = hudMessageRateTargets('rf');
    const position = rf.streams.find((row) => row.name === 'POSITION');
    expect(position.rateHz).toBe(RF_STREAM_RATE_HZ);
    expect(position.rateHz).toBeLessThan(normal.streams.find((row) => row.name === 'POSITION').rateHz);
    expect(rf.messages.find((row) => row.name === 'VFR_HUD').intervalUs).toBe(RF_STREAM_INTERVAL_US);
    const stream = buildRfRequestDataStreamPayload(1, 1, 6, 1);
    expect(stream.readUInt16LE(0)).toBe(1);
    expect(stream.readUInt16LE(0)).not.toBe(4);
    const interval = buildRfSetMessageIntervalPayload(1, 1, 74, RF_STREAM_INTERVAL_US);
    expect(interval.readFloatLE(4)).toBe(RF_STREAM_INTERVAL_US);
    expect(interval.readUInt16LE(28)).toBe(511);
  });
});
