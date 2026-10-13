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
    noteCompanionVideoFrame('cam0', { seq: 1, capturedAt: 1_000, now: 1_000 });
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
      health: { at: Date.now(), vision: { camera_ok: true } },
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
    noteCompanionVideoFrame('cam0', { seq: 1, capturedAt: 1_000, now: 1_000 });
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
    const now = Date.now();
    noteCompanionVideoFrame('cam0', { seq: 2, capturedAt: now, now });
    const after = snapshotDualLink({ env: { CELLULAR_MODEM_MOCK: 'present' } });
    expect(after.video.available).toBe(true);
    expect(after.video.via).toBe('frame');
    expect(after.video.path).toBe('cellular');
    expect(after.video.neverRadio).toBe(true);
    expect(after.video.radioSatisfies).toBe(false);
    expect(after.video.reason).toBe('cellular_connected');
  });

  it('does not keep a frozen frame available after the pull fails for 30s', async () => {
    const { createLatestFrameShelf } = await import('../lib/camera-latest-jpeg.mjs');
    let pulls = 0;
    let now = 1_000_000;
    const shelf = createLatestFrameShelf({
      now: () => now,
      waitMs: 20,
      pull: async () => {
        pulls += 1;
        if (pulls === 1) {
          return { bytes: Buffer.from([1, 2, 3, 4]), frameSeq: 7, capturedAt: now };
        }
        throw new Error('pull failed');
      },
    });
    const first = await shelf.take({ waitMs: 50 });
    expect(noteCompanionVideoFrame('cam0', {
      seq: first.sourceSeq,
      capturedAt: first.capturedAt,
      now,
    })).toBe(true);
    now += 30_000;
    const again = await shelf.take({ since: first.sourceSeq, waitMs: 80 });
    expect(again.sourceSeq).toBe(first.sourceSeq);
    expect(noteCompanionVideoFrame('cam0', {
      seq: again.sourceSeq,
      capturedAt: again.capturedAt,
      now,
    })).toBe(false);
    expect(recentCompanionVideoFrame({ camId: 'cam0', now })).toBe(null);
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      recentFrame: recentCompanionVideoFrame({ camId: 'cam0', now }),
    });
    expect(video.available).toBe(false);
    expect(video.reason).toBe('cellular_disconnected');
  });

  it('rejects a new sequence whose capture time is already older than 12s', () => {
    const t0 = 5_000_000;
    expect(noteCompanionVideoFrame('cam0', { seq: 3, capturedAt: t0, now: t0 })).toBe(true);
    expect(noteCompanionVideoFrame('cam0', { seq: 4, capturedAt: t0, now: t0 + 30_000 })).toBe(false);
    expect(recentCompanionVideoFrame({ now: t0 + 30_000 })).toBe(null);
  });

  it('does not treat a stale or failed camera as live when camera_ok is true', () => {
    const fresh = Date.now();
    expect(companionHttpVideoHealthy({
      jetson: 'reachable',
      health: { at: fresh - 30_000, vision: { camera_ok: true } },
    }, fresh)).toBe(false);
    expect(companionHttpVideoHealthy({
      jetson: 'reachable',
      health: { vision: { camera_ok: true } },
    }, fresh)).toBe(false);
    expect(companionHttpVideoHealthy({
      jetson: 'reachable',
      health: { at: fresh, vision: { camera_ok: true, state: 'error' } },
    }, fresh)).toBe(false);
    const video = resolveOperatorVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      companion: {
        jetson: 'reachable',
        health: { at: fresh, cameras: [{ camera_ok: true, state: 'failed' }] },
      },
    });
    expect(video.available).toBe(false);
  });
});
