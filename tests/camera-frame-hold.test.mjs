import { describe, expect, it } from 'vitest';
import { FRAME_MISS_HOLD_MS, frameMissShowsNoSignal } from '../public/modules/camera-frame-hold.mjs';

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
});
