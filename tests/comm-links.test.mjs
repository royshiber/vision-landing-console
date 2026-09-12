import { describe, it, expect } from 'vitest';
import {
  COMM_LINK_IDS,
  commActionLabel,
  hebrewConnectAction,
  qualityFromCompanionSignal,
  qualityFromMavlinkRssi,
  qualityFromTrustedPercent,
  snapshotRcLink,
  summarizeCommLinks,
} from '../lib/comm-links.mjs';
import { hebrewPillLabel, hebrewLinkRole } from '../lib/dual-link.mjs';

describe('four-link communications model', () => {
  it('locks four rows and Hebrew connect verbs by state', () => {
    expect([...COMM_LINK_IDS]).toEqual(['cellular', 'radio', 'home', 'rc']);
    expect(hebrewConnectAction(false)).toBe('התחבר');
    expect(hebrewConnectAction(true)).toBe('התנתק');
    expect(commActionLabel({ id: 'rc', action: 'status', connected: false })).toBe('סטטוס');
    expect(commActionLabel({ id: 'radio', action: 'connect', connected: false })).toBe('התחבר');
    expect(commActionLabel({ id: 'cellular', action: 'connect', connected: true })).toBe('התנתק');
  });

  it('never invents a percentage when the metric is missing or invalid', () => {
    expect(qualityFromTrustedPercent(null).known).toBe(false);
    expect(qualityFromTrustedPercent(null).percent).toBeNull();
    expect(qualityFromTrustedPercent(140).known).toBe(false);
    expect(qualityFromMavlinkRssi(255).known).toBe(false);
    expect(qualityFromMavlinkRssi(null).percent).toBeNull();
    expect(qualityFromCompanionSignal(null).known).toBe(false);
    expect(qualityFromCompanionSignal({ rsrp: -95 }).known).toBe(false);
    expect(qualityFromCompanionSignal({ rssi: 255 }).known).toBe(false);
  });

  it('shows a percent only from a finite trusted field', () => {
    const pct = qualityFromTrustedPercent(72, 'עוצמת אות מודם');
    expect(pct).toMatchObject({ known: true, percent: 72, bars: 3, sourceHe: 'עוצמת אות מודם' });
    const rssi = qualityFromMavlinkRssi(190, 'עוצמת אות שלט');
    expect(rssi.known).toBe(true);
    expect(rssi.percent).toBe(Math.round((190 / 254) * 100));
    const csq = qualityFromCompanionSignal({ csq: 22 }, 'עוצמת אות מודם');
    expect(csq.known).toBe(true);
    expect(csq.percent).toBe(Math.round((22 / 31) * 100));
  });

  it('summarizes four honest rows including modem-absent cellular', () => {
    const snap = summarizeCommLinks({
      radio: 'connected',
      cellular: 'disconnected',
      modemPresent: false,
      companion: { jetson: 'off', hint_he: 'חברו מחשב משימה בלחיצה.' },
    });
    expect(snap.rows).toHaveLength(4);
    expect(snap.rows.map((r) => r.id)).toEqual(['cellular', 'radio', 'home', 'rc']);
    expect(snap.rows[0].hintHe).toBe('מודם לא מחובר');
    expect(snap.rows[0].quality.known).toBe(false);
    expect(snap.rows[0].quality.percent).toBeNull();
    expect(snap.rows[0].actionHe).toBe('התחבר');
    expect(snap.rows[1].nameHe).toBe('רדיו טלמטריה');
    expect(snap.rows[1].connected).toBe(true);
    expect(snap.rows[1].actionHe).toBe('התנתק');
    expect(snap.rows[1].quality.percent).toBeNull();
    expect(snap.rows[3].actionHe).toBe('סטטוס');
    expect(snap.rows[3].hintHe).toBe('אין ערוצי שלט');
    expect(snap.pillLabelHe).toBe('מחובר · רדיו פעיל');
  });

  it('keeps RC percent only from a fresh RC_CHANNELS rssi', () => {
    const live = snapshotRcLink([{ hasRcChannels: true, rcRssi: 180, rcAgeMs: 200 }]);
    expect(live.state).toBe('live');
    expect(live.quality.known).toBe(true);
    expect(live.quality.sourceHe).toBe('עוצמת אות שלט');
    const stale = snapshotRcLink([{ hasRcChannels: true, rcRssi: 180, rcAgeMs: 9000 }]);
    expect(stale.state).toBe('off');
    expect(stale.quality.known).toBe(false);
    const invalid = snapshotRcLink([{ hasRcChannels: true, rcRssi: 255, rcAgeMs: 100 }]);
    expect(invalid.state).toBe('live');
    expect(invalid.quality.percent).toBeNull();
  });

  it('uses the locked short pill names', () => {
    expect(hebrewLinkRole('radio')).toBe('רדיו טלמטריה');
    expect(hebrewPillLabel({
      radio: 'connected',
      cellular: 'connected',
      active: 'radio',
      bothConnected: true,
    })).toBe('שני קישורים · רדיו פעיל');
  });
});
