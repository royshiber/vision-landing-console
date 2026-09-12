import { describe, it, expect } from 'vitest';
import {
  pickActiveLink,
  summarizeDualLink,
  liveStatusToLinkState,
  cellularConnectGate,
  annotatedVideoAvailability,
  hebrewPillLabel,
  chipStateFromLink,
  ANNOTATED_VIDEO_PATH,
} from '../lib/dual-link.mjs';
import { probeHuaweiE3372 } from '../lib/cellular-modem.mjs';

describe('dual-link state machine', () => {
  it('allows radio-only, cellular-only, or both, and picks the active command link', () => {
    expect(pickActiveLink({ radio: 'connected', cellular: 'disconnected' })).toBe('radio');
    expect(pickActiveLink({ radio: 'disconnected', cellular: 'connected' })).toBe('cellular');
    expect(pickActiveLink({ radio: 'connected', cellular: 'connected', preferred: 'cellular' })).toBe('cellular');
    expect(pickActiveLink({ radio: 'connected', cellular: 'connected', preferred: 'radio' })).toBe('radio');
    expect(pickActiveLink({ radio: 'disconnected', cellular: 'modem_absent' })).toBeNull();
  });

  it('defaults the active pick to radio when both are up and no preference is set', () => {
    expect(pickActiveLink({ radio: 'connected', cellular: 'connected' })).toBe('radio');
  });

  it('summarizes Hebrew chips and the topbar pill', () => {
    const both = summarizeDualLink({
      radio: 'connected',
      cellular: 'connected',
      preferred: 'cellular',
      modemPresent: true,
    });
    expect(both.canSelectActive).toBe(true);
    expect(both.active).toBe('cellular');
    expect(both.radioLabelHe).toBe('רדיו טלמטריה');
    expect(both.cellularLabelHe).toMatch(/סלולר/);
    expect(both.pillLabelHe).toBe('שני קישורים · סלולר פעיל');
    expect(hebrewPillLabel({ radio: 'disconnected', cellular: 'disconnected' })).toBe('מנותק');
  });

  it('never offers radio as the annotated video path', () => {
    expect(ANNOTATED_VIDEO_PATH).toBe('cellular');
    const radioOnly = annotatedVideoAvailability({ cellular: 'disconnected', modemPresent: true });
    expect(radioOnly.available).toBe(false);
    expect(radioOnly.path).toBe('cellular');
    expect(radioOnly.neverRadio).toBe(true);
    expect(radioOnly.radioSatisfies).toBe(false);
    expect(radioOnly.reasonHe).toMatch(/לא עוברת ברדיו/);
    const cellUpNoStream = annotatedVideoAvailability({ cellular: 'connected', modemPresent: true });
    expect(cellUpNoStream.available).toBe(false);
    expect(cellUpNoStream.reason).toBe('stream_absent');
    expect(cellUpNoStream.path).toBe('cellular');
    const live = annotatedVideoAvailability({
      cellular: 'connected',
      modemPresent: true,
      streamPresent: true,
    });
    expect(live.available).toBe(true);
    expect(live.path).toBe('cellular');
    const absent = annotatedVideoAvailability({ cellular: 'connected', modemPresent: false });
    expect(absent.available).toBe(false);
    expect(absent.reason).toBe('modem_absent');
  });

  it('maps live MAVLink status onto link states including modem absent', () => {
    expect(liveStatusToLinkState({ connected: true })).toBe('connected');
    expect(liveStatusToLinkState({ listening: true, connected: false })).toBe('listening');
    expect(liveStatusToLinkState(null, { role: 'cellular', modemPresent: false })).toBe('modem_absent');
    expect(liveStatusToLinkState(
      { listening: true, connected: true },
      { role: 'cellular', modemPresent: false },
    )).toBe('modem_absent');
    expect(chipStateFromLink('modem_absent')).toBe('absent');
    expect(chipStateFromLink('connected')).toBe('on');
  });

  it('blocks remote cellular sockets when the modem is unplugged, but allows loopback mock', () => {
    expect(cellularConnectGate({ modemPresent: false, host: '10.0.0.8' })).toMatchObject({
      allowed: false,
      state: 'modem_absent',
    });
    expect(cellularConnectGate({ modemPresent: false, host: '127.0.0.1' }).allowed).toBe(true);
    expect(cellularConnectGate({ modemPresent: true, host: '10.0.0.8' }).allowed).toBe(true);
  });
});

describe('Huawei E3372 probe', () => {
  it('defaults to unplugged and honors the mock-present env flag', () => {
    const absent = probeHuaweiE3372({ env: {}, existsSync: () => false });
    expect(absent.present).toBe(false);
    expect(absent.reason).toBe('modem_absent');
    expect(absent.reasonHe).toMatch(/מודם לא מחובר/);
    const mock = probeHuaweiE3372({ env: { CELLULAR_MODEM_MOCK: 'present' } });
    expect(mock.present).toBe(true);
    expect(mock.transport).toBe('mock');
  });
});
