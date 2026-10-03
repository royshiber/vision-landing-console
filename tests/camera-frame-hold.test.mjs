import { describe, expect, it } from 'vitest';
import { FRAME_MISS_HOLD_MS, frameMissShowsNoSignal, frameTilePresentation } from '../public/modules/camera-frame-hold.mjs';

describe('single frame miss', () => {
  it('hides אין אות for one miss while a recent frame or a live stream exists', () => {
    const now = 10_000;
    expect(frameMissShowsNoSignal({
      seenAt: now - 500,
      now,
      streaming: false,
      consecutiveMisses: 1,
    })).toBe(false);
    expect(frameMissShowsNoSignal({
      seenAt: 0,
      now,
      streaming: true,
      consecutiveMisses: 1,
    })).toBe(false);
    expect(frameMissShowsNoSignal({
      seenAt: now - 500,
      now,
      streaming: true,
      consecutiveMisses: 2,
    })).toBe(true);
    expect(frameMissShowsNoSignal({
      seenAt: now - FRAME_MISS_HOLD_MS - 1,
      now,
      streaming: false,
      consecutiveMisses: 1,
    })).toBe(true);
    expect(frameMissShowsNoSignal({
      seenAt: 0,
      now,
      streaming: false,
      consecutiveMisses: 1,
    })).toBe(true);
  });

  it('does not leave a live gimbal tile empty after the second miss', () => {
    const now = 10_000;
    const one = frameTilePresentation({
      seenAt: now - 500,
      now,
      streaming: true,
      consecutiveMisses: 1,
      hasPicture: true,
    });
    expect(one).toEqual({ showImage: true, showNote: false });

    const second = frameTilePresentation({
      seenAt: 0,
      now,
      streaming: true,
      consecutiveMisses: 2,
      hasPicture: false,
    });
    expect(second).toEqual({ showImage: false, showNote: true });
    expect(second.showImage || second.showNote).toBe(true);
  });
});
