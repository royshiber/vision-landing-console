import { describe, expect, it } from 'vitest';
import {
  AUTO_CONNECT_BAUD_ORDER,
  scoreUsbFcHint,
  classifySerialAccessError,
  buildAutoConnectFailureSuggestion,
} from '../lib/auto-connect-utils.mjs';

describe('auto-connect-utils', () => {
  it('orders common FC baud rates with 115200 first', () => {
    expect(AUTO_CONNECT_BAUD_ORDER[0]).toBe(115200);
    expect(AUTO_CONNECT_BAUD_ORDER.includes(57600)).toBe(true);
  });

  it('scoreUsbFcHint boosts Silicon Labs FTDI-ish manufacturer strings', () => {
    const low = scoreUsbFcHint({ manufacturer: 'Canon Inc.' });
    const high = scoreUsbFcHint({ manufacturer: 'Silicon Labs CP2102' });
    expect(high > low).toBe(true);
  });

  it('scoreUsbFcHint adds weight for FTDI VID', () => {
    const a = scoreUsbFcHint({ vendorId: '0403', manufacturer: '' });
    const b = scoreUsbFcHint({ vendorId: '9999', manufacturer: '' });
    expect(a > b).toBe(true);
  });

  it('classifySerialAccessError detects Windows COM access denied', () => {
    const r = classifySerialAccessError(`Opening COM7: Access denied`);
    expect(r.code).toBe('port_busy');
    expect(String(r.heMessage || '')).toMatch(/יציאה תפוסה|Mission Planner/i);
  });

  it('buildAutoConnectFailureSuggestion highlights COM busy checklist', () => {
    const s = buildAutoConnectFailureSuggestion([
      { ok: false, phase: 'activate', code: 'port_busy' },
    ]);
    expect(s.checklist.some((x) => /Mission Planner|QGroundControl/i.test(x))).toBe(true);
    expect(/חסמו|ווינדוס/.test(s.headline)).toBe(true);
  });
});
