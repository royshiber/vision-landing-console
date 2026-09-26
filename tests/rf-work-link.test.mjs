import { describe, expect, it } from 'vitest';
import { buildSetMessageIntervalPayload } from '../lib/mavlink-connection.mjs';
import {
  buildRfIntervalPayload,
  rfMessageIntervals,
} from '../lib/rf-mavlink.mjs';
import { chooseWorkPath, planWorkLink, probeHttpUrls } from '../lib/rf-work-link.mjs';

describe('RF work link', () => {
  it('keeps a forced path and falls back to RF only in automatic', () => {
    expect(chooseWorkPath({ mode: 'home', httpResults: [], serialPort: 'COM3' }).path).toBe('home');
    expect(chooseWorkPath({ mode: 'cellular', httpResults: [], serialPort: 'COM3' }).path).toBe('cellular');
    expect(chooseWorkPath({ mode: 'rf', serialPort: '' }).path).toBe('rf');
    const fallback = planWorkLink({ mode: 'auto', httpResults: [], serialPort: 'COM3' });
    expect(fallback).toMatchObject({ path: 'rf', fallback: true, connectSerial: true, reduced: true });
    expect(fallback.reasonHe).toBe('במצב RF אין וידאו');
    const live = planWorkLink({
      mode: 'auto',
      serialPort: 'COM3',
      httpResults: [{ id: 'cellular', ok: true }],
    });
    expect(live).toMatchObject({ path: 'cellular', connectSerial: false, disconnectSerial: true });
    const none = planWorkLink({ mode: 'auto', httpResults: [], serialPort: '' });
    expect(none.path).toBe('none');
  });

  it('classifies a home address and a cellular address', async () => {
    const rows = await probeHttpUrls(
      ['http://192.168.1.20:8787', 'http://100.82.1.4:8787'],
      async () => ({ ok: true }),
    );
    expect(rows.map((row) => row.id)).toEqual(['home', 'cellular']);
  });

  it('asks for one-hertz telemetry with the real command layout', () => {
    const gps = rfMessageIntervals().find((row) => row.id === 24);
    const payload = buildRfIntervalPayload(1, 1, gps.id, gps.intervalUs);
    expect(payload.readUInt16LE(28)).toBe(511);
    expect(payload.readFloatLE(4)).toBe(1000000);
    const shared = buildSetMessageIntervalPayload(1, 1, 24, 1000000);
    expect(shared.readUInt16LE(2)).toBe(511);
    expect(payload.readUInt16LE(2)).not.toBe(511);
  });
});
