import { describe, expect, it } from 'vitest';
import {
  MODEM_BARS_ONLY_HE,
  barsFromSignalIcon,
  networkLabelFrom,
  operatorNameFrom,
  qualityFromCompanionSignal,
  summarizeCommLinks,
} from '../lib/comm-links.mjs';

const partner = { short: 'Partner', full: 'Partner' };

function cellRow(uplink) {
  const snap = summarizeCommLinks({
    modemPresent: true,
    uplinkControl: true,
    uplinks: {
      wifi: { enabled: true, up: false },
      cellular: { enabled: true, up: true, ...uplink },
    },
  });
  return snap.rows.find((row) => row.id === 'cellular');
}

describe('cellular bars fall back to the modem icon', () => {
  it('keeps dBm bars when rsrp or rssi exist and ignores signal-para', () => {
    const q = qualityFromCompanionSignal({
      rsrp: -78,
      rssi: null,
      signal_icon: 2,
      signal_max: 5,
      network_label: 'LTE',
      operator: partner,
      rscp: -145,
      ecio: -32,
    });
    expect(q.known).toBe(true);
    expect(q.bars).toBe(4);
    expect(q.percent).toBeNull();
    expect(q.tooltipHe).toMatch(/-78/);
    expect(q.tooltipHe).toMatch(/דציבל/);
    expect(q.tooltipHe).not.toContain(MODEM_BARS_ONLY_HE);
    expect(q.networkLabel).toBe('LTE');
    expect(q.operator).toBe('Partner');
    expect(qualityFromCompanionSignal({ rssi: -70, signal_icon: 1 }).bars).toBe(3);
    expect(qualityFromCompanionSignal({ rscp: -145, ecio: -32 }).known).toBe(false);
  });

  it('maps a full icon and a partial icon onto four bars', () => {
    expect(barsFromSignalIcon(5, 5)).toBe(4);
    expect(barsFromSignalIcon(2, 5)).toBe(2);
    expect(barsFromSignalIcon(1, 5)).toBe(1);
    expect(barsFromSignalIcon(0, 5)).toBe(0);
    expect(barsFromSignalIcon(5, null)).toBe(4);
    const full = qualityFromCompanionSignal({
      rssi: '',
      rsrp: null,
      signal_icon: 5,
      signal_max: 5,
      network_type: '101',
      operator: partner,
    });
    expect(full.known).toBe(true);
    expect(full.bars).toBe(4);
    expect(full.percent).toBeNull();
    expect(full.tooltipHe).toContain(MODEM_BARS_ONLY_HE);
    expect(full.tooltipHe).toContain('5 מתוך 5');
    expect(full.networkLabel).toBe('LTE');
    expect(full.operator).toBe('Partner');
    const partial = qualityFromCompanionSignal({ signal_icon: 2, signal_max: 5 });
    expect(partial.bars).toBe(2);
    expect(partial.tooltipHe).toContain('2 מתוך 5');
    expect(partial.percent).toBeNull();
  });

  it('stays empty when neither dBm nor an icon exists', () => {
    const q = qualityFromCompanionSignal({
      rssi: null,
      rsrp: null,
      rsrq: null,
      sinr: null,
      signal_icon: null,
      signal_max: null,
      rscp: -145,
      ecio: -32,
    });
    expect(q.known).toBe(false);
    expect(q.bars).toBe(0);
    expect(q.percent).toBeNull();
    expect(q.networkLabel).toBeUndefined();
    expect(q.operator).toBeUndefined();
    expect(networkLabelFrom({ network_type: '999' })).toBeNull();
    expect(networkLabelFrom({ network_type: '1011' })).toBe('LTE+');
    expect(networkLabelFrom({ network_type: '3' })).toBe('EDGE');
    expect(operatorNameFrom({ operator: { short: '', full: 'Partner' } })).toBe('Partner');
    expect(operatorNameFrom({ operator: { short: null, full: null } })).toBeNull();
  });

  it('paints the connect row from the uplink cellular block', () => {
    const dbm = cellRow({
      signal: { rssi: null, rsrp: -78, rsrq: null, sinr: null },
      signal_icon: 2,
      signal_max: 5,
      network_label: 'LTE',
      operator: partner,
    });
    expect(dbm.quality.bars).toBe(4);
    expect(dbm.quality.tooltipHe).toMatch(/דציבל/);
    expect(dbm.quality.networkLabel).toBe('LTE');
    expect(dbm.quality.operator).toBe('Partner');

    const full = cellRow({
      signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
      signal_icon: 5,
      signal_max: 5,
      network_type: '101',
      operator: partner,
    });
    expect(full.quality.known).toBe(true);
    expect(full.quality.bars).toBe(4);
    expect(full.quality.percent).toBeNull();
    expect(full.quality.tooltipHe).toContain(MODEM_BARS_ONLY_HE);
    expect(full.quality.networkLabel).toBe('LTE');
    expect(full.quality.operator).toBe('Partner');

    const partial = cellRow({
      signal: { rssi: '', rsrp: '', rsrq: '', sinr: '' },
      signal_icon: 2,
      signal_max: 5,
      network_label: 'LTE',
      operator: { short: 'Partner', full: 'Partner Communications' },
    });
    expect(partial.quality.bars).toBe(2);
    expect(partial.quality.operator).toBe('Partner');

    const empty = cellRow({
      signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
      signal_icon: null,
      signal_max: null,
      network_label: null,
      operator: { short: null, full: null },
    });
    expect(empty.quality.known).toBe(false);
    expect(empty.quality.bars).toBe(0);
    expect(empty.quality.networkLabel).toBeUndefined();
    expect(empty.quality.operator).toBeUndefined();
  });
});
