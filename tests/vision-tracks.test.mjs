import { describe, expect, it } from 'vitest';
import { framePoint, hitTrack, mediaFit, unwrapTracks } from '../public/modules/vision-tracks.mjs';

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
});
