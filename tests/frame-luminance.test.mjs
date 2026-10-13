import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jpegFrameIsBlank, samplesLookBlank } from '../lib/frame-luminance.mjs';

describe('flat frame check', () => {
  it('treats a low luminance variance as no picture', () => {
    expect(samplesLookBlank(Array.from({ length: 24 }, () => 4))).toBe(true);
    expect(samplesLookBlank([0, 40, 90, 140, 200, 12, 250, 30, 80, 180, 20, 220, 60, 160, 10, 240])).toBe(false);
  });

  it('marks a black or grey JPEG blank and leaves a real picture alone', () => {
    const black = readFileSync(new URL('./fixtures/black-64.jpg', import.meta.url));
    const gray = readFileSync(new URL('./fixtures/gray-32.jpg', import.meta.url));
    const varied = readFileSync(new URL('./fixtures/varied-64.jpg', import.meta.url));
    expect(jpegFrameIsBlank(black)).toBe(true);
    expect(jpegFrameIsBlank(gray)).toBe(true);
    expect(jpegFrameIsBlank(varied)).toBe(false);
    expect(jpegFrameIsBlank(Buffer.from([1, 2, 3, 4]))).toBe(false);
  });
});
