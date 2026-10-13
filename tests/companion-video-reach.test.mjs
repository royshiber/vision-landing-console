import { beforeEach, describe, expect, it } from 'vitest';
import {
  companionHttpVideoHealthy,
  noteCompanionVideoFrame,
  recentCompanionVideoFrame,
  resetCompanionVideoReachForTests,
  resolveOperatorVideoAvailability,
} from '../lib/companion-video-reach.mjs';
import { resetDualLinkRuntimeForTests, snapshotDualLink } from '../lib/dual-link-runtime.mjs';

describe('companion video reachability', () => {
  beforeEach(() => {
    resetCompanionVideoReachForTests();
    resetDualLinkRuntimeForTests();
  });

  it('treats a recent cam0 frame as cellular video when the MAVLink role is not cellular', () => {
    noteCompanionVideoFrame('cam0', 1_000);
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      streamPresent: false,
      recentFrame: recentCompanionVideoFrame({ now: 5_000 }),
    });
    expect(video.available).toBe(true);
    expect(video.path).toBe('cellular');
    expect(video.neverRadio).toBe(true);
    expect(video.radioSatisfies).toBe(false);
    expect(video.reason).toBe('cellular_connected');
    expect(video.reason).not.toBe('cellular_disconnected');
    expect(video.via).toBe('frame');
  });

  it('stays cellular_disconnected when there is no frame and no camera health', () => {
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      streamPresent: false,
      companion: { jetson: 'reachable', health: { ok: true } },
      recentFrame: null,
    });
    expect(video.available).toBe(false);
    expect(video.reason).toBe('cellular_disconnected');
    expect(video.via).toBe(null);
    expect(video.radioSatisfies).toBe(false);
    expect(companionHttpVideoHealthy({ jetson: 'reachable' })).toBe(false);
  });

  it('uses companion HTTP camera health without a MAVLink cellular link', () => {
    const companion = {
      jetson: 'reachable',
      health: { vision: { camera_ok: true } },
    };
    expect(companionHttpVideoHealthy(companion)).toBe(true);
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      streamPresent: false,
      companion,
    });
    expect(video.available).toBe(true);
    expect(video.via).toBe('health');
    expect(video.path).toBe('cellular');
    expect(video.neverRadio).toBe(true);
    expect(video.reason).toBe('cellular_connected');
  });

  it('keeps modem_absent when there is no frame or health evidence', () => {
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: false,
      companion: { jetson: 'unreachable' },
    });
    expect(video.available).toBe(false);
    expect(video.reason).toBe('modem_absent');
    expect(video.via).toBe(null);
  });

  it('ignores a stale frame and does not let radio satisfy video', () => {
    noteCompanionVideoFrame('cam0', 0);
    expect(recentCompanionVideoFrame({ now: 20_000, maxAgeMs: 12_000 })).toBe(null);
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      recentFrame: recentCompanionVideoFrame({ now: 20_000 }),
    });
    expect(video.available).toBe(false);
    expect(video.reason).toBe('cellular_disconnected');
    expect(video.radioSatisfies).toBe(false);
    expect(video.path).not.toBe('radio');
  });

  it('snapshot follows a recent frame instead of the radio MAVLink role', () => {
    const before = snapshotDualLink({ env: { CELLULAR_MODEM_MOCK: 'present' } });
    expect(before.video.available).toBe(false);
    expect(before.video.reason).toBe('cellular_disconnected');
    noteCompanionVideoFrame('cam0', Date.now());
    const after = snapshotDualLink({ env: { CELLULAR_MODEM_MOCK: 'present' } });
    expect(after.video.available).toBe(true);
    expect(after.video.via).toBe('frame');
    expect(after.video.path).toBe('cellular');
    expect(after.video.neverRadio).toBe(true);
    expect(after.video.radioSatisfies).toBe(false);
    expect(after.video.reason).toBe('cellular_connected');
  });
});
