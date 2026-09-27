import { describe, expect, it } from 'vitest';
import {
  distanceMFromCorners,
  FOV_DEFAULTS,
  intrinsicsFromFov,
  parseFov,
  readStoredFov,
  writeStoredFov,
} from '../public/modules/camera-fov.mjs';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
  };
}

describe('camera field of view', () => {
  it('defaults to 120 and 79 and rejects values outside 20..180', () => {
    const storage = memoryStorage();
    expect(readStoredFov(storage, 'cam0')).toBe(FOV_DEFAULTS.cam0);
    expect(readStoredFov(storage, 'cam1')).toBe(FOV_DEFAULTS.cam1);
    expect(parseFov(19).ok).toBe(false);
    expect(parseFov(181).ok).toBe(false);
    expect(parseFov(20).ok).toBe(true);
    expect(parseFov(180).ok).toBe(true);
    expect(writeStoredFov(storage, 'cam0', 19).ok).toBe(false);
    expect(readStoredFov(storage, 'cam0')).toBe(120);
    expect(writeStoredFov(storage, 'cam1', 90).ok).toBe(true);
    expect(readStoredFov(storage, 'cam1')).toBe(90);
    expect(readStoredFov(storage, 'cam0')).toBe(120);
  });

  it('derives focal length from the saved degrees instead of 800', () => {
    const k = intrinsicsFromFov(1280, 800, 120);
    const expected = 640 / Math.tan((120 * Math.PI / 180) / 2);
    expect(k.fx).toBeCloseTo(expected, 6);
    expect(k.fy).toBeCloseTo(expected, 6);
    expect(k.fx).not.toBeCloseTo(800, 0);
    const corners = [[0, 0], [100, 0], [100, 80], [0, 80]];
    const distance = distanceMFromCorners(corners, 1280, 120, 0.16);
    const hardcoded = distanceMFromCorners(corners, 1280, 120, 0.16);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeCloseTo((k.fx * 0.16) / 90, 5);
    expect(hardcoded).toBe(distance);
    expect(intrinsicsFromFov(1280, 800, 79).fx).not.toBeCloseTo(k.fx, 0);
  });
});
