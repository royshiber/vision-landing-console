import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAssistContext } from '../lib/assist/assist-context.mjs';
import { FRAME_SYNC_TOLERANCE_MS, assembleVisionAsk, cacheCoversAsk, decodeTracksHeader, encodeTracksHeader, fillVisionAsk, framePoint, hitDrawnBox, hitTrack, mediaFit, placeMenuBox, placeTrackCaption, selectFrameTracks, TRACK_POLL_MS, trackCaption, tracksMatchFrame, unwrapTracks, visionAskSnapshot, VISION_ASK_WAIT_MS, waitForVisionAsk } from '../public/modules/vision-tracks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('vision track hit testing', () => {
  it('unwraps the proxy envelope and keeps a bare payload', () => {
    expect(unwrapTracks({ ok: true, lane: 'NEW', data: { tracks: [] } })).toEqual({ tracks: [] });
    expect(unwrapTracks({ tracks: [1] })).toEqual({ tracks: [1] });
  });

  it('hits the last drawn box in layer pixels', () => {
    const boxes = [
      { id: 1, x: 10, y: 12, w: 40, h: 30 },
      { id: 2, x: 80, y: 20, w: 50, h: 24 },
    ];
    expect(hitDrawnBox(boxes, 90, 30).id).toBe(2);
    expect(hitDrawnBox(boxes, 12, 14).id).toBe(1);
    expect(hitDrawnBox(boxes, 0, 0)).toBeNull();
    expect(trackCaption({ id: 2, label_he: 'אדם', confidence: 0.9 })).toBe('אדם · #2 · 90%');
    const left = placeTrackCaption(0, 90, 200);
    expect(left.x).toBe(0);
    expect(left.right).toBeLessThanOrEqual(200);
    const edge = placeTrackCaption(180, 90, 200);
    expect(edge.x).toBeGreaterThanOrEqual(0);
    expect(edge.right).toBeLessThanOrEqual(200);
    const wide = placeTrackCaption(0, 240, 200);
    expect(wide.right).toBe(200);
    expect(wide.right - wide.x).toBe(240);
    expect(TRACK_POLL_MS).toBeGreaterThanOrEqual(150);
    expect(TRACK_POLL_MS).toBeLessThanOrEqual(200);
  });

  it('keeps tracks for the frame on screen when a newer poll arrives', () => {
    const frame1 = { frame_seq: 1, tracks: [{ id: 1 }, { id: 3 }] };
    const frame2 = { frame_seq: 2, tracks: [{ id: 1 }] };
    const book = new Map([[1, frame1], [2, frame2]]);
    expect(selectFrameTracks(frame2, book, 1)).toEqual(frame1);
    expect(selectFrameTracks(frame2, book, 2)).toEqual(frame2);
    expect(selectFrameTracks({ tracks: [{ id: 9 }] }, book, 2).tracks).toEqual([{ id: 9 }]);
    expect(selectFrameTracks(frame2, book, 0)).toEqual(frame2);
    const late = { frame_seq: 9, captured_at: 5000, tracks: [{ id: 4, label_he: 'משאית' }] };
    const emptyBook = new Map();
    expect(selectFrameTracks(late, emptyBook, 11, 5000 + FRAME_SYNC_TOLERANCE_MS)).toEqual(late);
    expect(selectFrameTracks(late, emptyBook, 11, 5000 + FRAME_SYNC_TOLERANCE_MS + 1)).toBeNull();
    expect(selectFrameTracks(late, emptyBook, 11, 0)).toBeNull();
  });

  it('round-trips the tracks that ride with a frame', () => {
    const payload = {
      ok: true,
      enabled: true,
      camera: 'cam0',
      stream: true,
      frame_seq: 7,
      captured_at: 1700000000200,
      frame_width: 320,
      frame_height: 180,
      tracks: [{ id: 2, label_he: 'אדם', confidence: 0.9, bbox: [1, 2, 3, 4] }],
      lock: null,
      reason_he: '',
      flight_commands: false,
    };
    const header = encodeTracksHeader(payload);
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    const back = decodeTracksHeader(header);
    expect(back.frame_seq).toBe(7);
    expect(back.tracks[0].label_he).toBe('אדם');
    expect(tracksMatchFrame(back, 7, back.captured_at)).toBe(true);
    expect(tracksMatchFrame(back, 8, back.captured_at + FRAME_SYNC_TOLERANCE_MS + 5)).toBe(false);
    let matched = 0;
    for (let seq = 1; seq <= 40; seq += 1) {
      const row = decodeTracksHeader(encodeTracksHeader({ ...payload, frame_seq: seq, captured_at: 1000 + seq }));
      if (tracksMatchFrame(row, seq, row.captured_at)) matched += 1;
    }
    expect(matched / 40).toBeGreaterThanOrEqual(0.95);
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
    const missing = visionAskSnapshot({
      ok: false,
      enabled: false,
      stream: false,
      tracks: [],
      reason_he: 'אין נתון על זרם המצלמות',
    });
    expect(missing.enabled).toBeUndefined();
    expect(missing.stream).toBeUndefined();
    expect(missing.reason_he).toBe('אין נתון על זרם המצלמות');
  });

  it('snapshots every camera and waits once when the cache is empty', async () => {
    const cam = (id, tracks) => ({
      camera: id,
      enabled: true,
      stream: true,
      backend: 'cpu',
      tracks,
      lock: null,
    });
    const cache = new Map([
      ['cam0', cam('cam0', [{ id: 1, class: 'person', label_he: 'אדם' }])],
      ['cam1', cam('cam1', [])],
      ['cam3', cam('cam3', [{ id: 4, class: 'car', label_he: 'רכב' }])],
    ]);
    cache.get('cam3').selected_camera = 'cam3';
    const snap = assembleVisionAsk(cache);
    expect(cacheCoversAsk(cache)).toBe(true);
    expect(Object.keys(snap.cameras).sort()).toEqual(['cam0', 'cam1', 'cam3']);
    expect(snap.camera).toBe('cam3');
    expect(snap.tracks.map((row) => row.label_he)).toEqual(['רכב']);
    expect(snap.streams).toEqual({ cam0: true, cam1: true, cam3: true });
    expect(snap).not.toEqual({});

    const partial = new Map([['cam0', cam('cam0', [{ id: 1, class: 'person', label_he: 'אדם' }])]]);
    const kept = fillVisionAsk(assembleVisionAsk(partial), snap);
    expect(kept.cameras.cam3.tracks.map((row) => row.label_he)).toEqual(['רכב']);
    expect(kept.cameras.cam0.tracks.map((row) => row.label_he)).toEqual(['אדם']);

    const empty = new Map();
    let pulls = 0;
    const started = Date.now();
    const ready = await waitForVisionAsk({
      read: () => empty,
      refresh() {
        pulls += 1;
        return new Promise((resolve) => setTimeout(() => {
          empty.set('cam0', cam('cam0', []));
          empty.set('cam1', cam('cam1', []));
          empty.set('cam3', cam('cam3', [{ id: 9, class: 'person', label_he: 'אדם' }]));
          resolve();
        }, 40));
      },
      lastGood: null,
      waitMs: VISION_ASK_WAIT_MS,
      settled: false,
    });
    expect(pulls).toBe(1);
    expect(Date.now() - started).toBeLessThan(VISION_ASK_WAIT_MS);
    expect(ready.cameras.cam3.tracks[0].label_he).toBe('אדם');

    const late = new Map();
    const fallback = await waitForVisionAsk({
      read: () => late,
      refresh() {
        return new Promise((resolve) => setTimeout(resolve, 200));
      },
      lastGood: snap,
      waitMs: 40,
      settled: false,
    });
    expect(fallback.cameras.cam0).toBeTruthy();
    expect(fallback.cameras.cam3).toBeTruthy();
    expect(fallback.streams.cam3).toBe(true);

    const keptOnServer = buildAssistContext({ vision: snap });
    expect(Object.keys(keptOnServer.vision.cameras).sort()).toEqual(['cam0', 'cam1', 'cam3']);
    expect(keptOnServer.vision.cameras.cam3.tracks[0].label_he).toBe('רכב');
    expect(keptOnServer.vision.streams.cam3).toBe(true);
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
