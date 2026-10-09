import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { framePoint, hitTrack, mediaFit, placeMenuBox, unwrapTracks, visionAskSnapshot } from '../public/modules/vision-tracks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('vision track hit testing', () => {
  it('unwraps the proxy envelope and keeps a bare payload', () => {
    expect(unwrapTracks({ ok: true, lane: 'NEW', data: { tracks: [] } })).toEqual({ tracks: [] });
    expect(unwrapTracks({ tracks: [1] })).toEqual({ tracks: [1] });
  });

  it('hits the topmost box and misses the gaps', () => {
    const tracks = [
      { id: 1, bbox: [10, 10, 20, 20] },
      { id: 2, bbox: [15, 15, 20, 20] },
    ];
    expect(hitTrack(tracks, 16, 16).id).toBe(2);
    expect(hitTrack(tracks, 12, 12).id).toBe(1);
    expect(hitTrack(tracks, 0, 0)).toBeNull();
  });

  it('maps a contained click back into frame pixels', () => {
    const media = { naturalWidth: 320, naturalHeight: 180 };
    const fit = mediaFit(media, 640, 360);
    const point = framePoint(fit.x + 40, fit.y + 60, fit, 320, 180);
    expect(point.x).toBeCloseTo(20, 4);
    expect(point.y).toBeCloseTo(30, 4);
  });

  it('keeps a tall menu inside 1280x720 when the click is near the bottom', () => {
    const box = placeMenuBox({ x: 400, y: 365, menuW: 240, menuH: 420, viewW: 1280, viewH: 720 });
    expect(box.top).toBeGreaterThanOrEqual(8);
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.top + box.height).toBeLessThanOrEqual(712);
    expect(box.left + box.width).toBeLessThanOrEqual(1272);
    expect(box.height).toBe(420);
    expect(box.scrolls).toBe(false);
  });

  it('caps a menu taller than the viewport and marks the internal scroll', () => {
    const box = placeMenuBox({ x: 1200, y: 680, menuW: 240, menuH: 900, viewW: 1280, viewH: 720 });
    expect(box.height).toBe(704);
    expect(box.maxHeight).toBe(704);
    expect(box.scrolls).toBe(true);
    expect(box.top).toBe(8);
    expect(box.top + box.height).toBeLessThanOrEqual(712);
    expect(box.left + box.width).toBeLessThanOrEqual(1272);
    expect(box.left).toBeGreaterThanOrEqual(8);
  });

  it('shapes a live detection snapshot for the ask request', () => {
    const snap = visionAskSnapshot({
      enabled: true,
      stream: true,
      backend: 'cpu',
      reason_he: '',
      tracks: [
        { id: 7, class: 'person', label_he: 'אדם', confidence: 0.91, bbox: [8, 10, 18, 30] },
        { id: 8, class: 'car', label_he: 'רכב', confidence: 0.64, bbox: [50, 28, 30, 16] },
      ],
      lock: { id: 7, class: 'person', label_he: 'אדם' },
      gimbal_steer: { enabled: false, sent: false, flight_commands: false },
    });
    expect(snap.enabled).toBe(true);
    expect(snap.stream).toBe(true);
    expect(snap.model).toBe(true);
    expect(snap.tracks).toEqual([
      { id: 7, class: 'person', label_he: 'אדם' },
      { id: 8, class: 'car', label_he: 'רכב' },
    ]);
    const colored = visionAskSnapshot({
      enabled: true,
      stream: true,
      backend: 'cpu',
      tracks: [{ id: 7, class: 'person', label_he: 'אדם', color_he: 'אדום' }],
    });
    expect(colored.tracks).toEqual([{ id: 7, class: 'person', label_he: 'אדם', color_he: 'אדום' }]);
    expect(snap.lock).toEqual({ id: 7 });
    expect(snap.gimbal_steer).toBeUndefined();
  });

  it('fails when no camera stage marker is present', () => {
    const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');
    const source = readFileSync(path.join(root, 'public/modules/vision-tracks.mjs'), 'utf8');
    const stages = [...html.matchAll(/data-camera-stage="([^"]+)"/g)].map((match) => match[1]);
    expect(stages.filter((stage) => stage === 'cam0').length).toBeGreaterThan(0);
    expect(stages).toEqual(expect.arrayContaining(['cam0', 'cam1', 'cam3', 'horizon']));
    expect(source).toContain('[data-camera-stage]');
    expect(source).not.toContain("getElementById('cam0Stage')");
    expect(source).not.toContain("getElementById('cam1Stage')");
    expect(source).not.toContain("getElementById('pfdHorizonStage')");
    expect(source).not.toContain('#gimbalScreen .gimbal-screen-stage');
  });
});
