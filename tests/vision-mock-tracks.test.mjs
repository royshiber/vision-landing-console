import { describe, expect, it } from 'vitest';
import express from 'express';
import { createCompanionService } from '../lib/companion-service.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { COMPANION_PROXY_PREFIX } from '../lib/companion-v1-paths.mjs';
import { decodeTracksHeader } from '../lib/frame-tracks-header.mjs';

const FIXTURE = {
  camera: 'cam0',
  enabled: true,
  stream: true,
  tracks: [
    {
      id: 3,
      class: 'person',
      label_he: 'אדם',
      confidence: 0.91,
      bbox: [8, 10, 18, 30],
      age: 4,
      color_he: 'אדום',
    },
    {
      id: 4,
      class: 'car',
      label_he: 'רכב',
      confidence: 0.7,
      bbox: [40, 20, 24, 12],
      age: 4,
    },
  ],
};

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function appFor(env) {
  const app = express();
  app.use(express.json());
  const service = createCompanionService(env);
  registerCompanionProxyApi(app, { companionService: service });
  return app;
}

describe('test-only mock vision tracks', () => {
  it('serves fixture tracks through the proxy without a vision config post', async () => {
    const env = { COMPANION_MODE: 'mock', VITEST: 'true' };
    const server = await listen(appFor(env));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}${COMPANION_PROXY_PREFIX}`;
    try {
      const bare = await fetch(`${base}/vision/tracks?camera=cam0`);
      const bareJson = await bare.json();
      expect(bareJson.ok).toBe(true);
      expect(bareJson.lane).toBe('NEW');
      expect(bareJson.data.tracks).toEqual([]);
      expect(bareJson.data.flight_commands).toBe(false);

      env.VLC_VISION_MOCK_TRACKS = JSON.stringify(FIXTURE);
      const other = await fetch(`${base}/vision/tracks?camera=cam3`);
      const otherJson = await other.json();
      expect(otherJson.data.tracks).toEqual([]);
      expect(otherJson.data.enabled).toBe(false);

      const live = await fetch(`${base}/vision/tracks?camera=cam0`);
      const liveJson = await live.json();
      expect(liveJson.data.enabled).toBe(true);
      expect(liveJson.data.stream).toBe(true);
      expect(liveJson.data.backend).toBe('fixture');
      expect(liveJson.data.tracks.map((row) => row.id)).toEqual([3, 4]);
      expect(liveJson.data.tracks[0].color_he).toBe('אדום');
      expect(liveJson.data.tracks[1].color_he).toBeUndefined();
      expect(liveJson.data.gimbal_steer.enabled).toBe(false);
      expect(liveJson.data.gimbal_steer.sent).toBe(false);
      expect(liveJson.data.gimbal_steer.flight_commands).toBe(false);
      expect(liveJson.data.flight_commands).toBe(false);

      delete env.VITEST;
      const hidden = await fetch(`${base}/vision/tracks?camera=cam0`);
      const hiddenJson = await hidden.json();
      expect(hiddenJson.data.tracks).toEqual([]);
      expect(hiddenJson.data.backend).toBe('off');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('serves fixture tracks in explicit QA mode and can stream cam3', async () => {
    const env = { COMPANION_MODE: 'mock', VLC_QA: '1' };
    const server = await listen(appFor(env));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}${COMPANION_PROXY_PREFIX}`;
    try {
      const hidden = await fetch(`${base}/cameras/cam3/frame`);
      expect(hidden.status).toBe(404);
      const quiet = await fetch(`${base}/vision/tracks?camera=cam3`);
      const quietJson = await quiet.json();
      expect(quietJson.data.stream).toBe(false);
      expect(quietJson.data.tracks).toEqual([]);

      env.VLC_VISION_MOCK_TRACKS = JSON.stringify({ ...FIXTURE, camera: 'cam3' });
      const live = await fetch(`${base}/vision/tracks?camera=cam3`);
      const liveJson = await live.json();
      expect(liveJson.data.stream).toBe(true);
      expect(liveJson.data.tracks).toHaveLength(2);
      const status = await fetch(`${base}/status/cameras`);
      const statusJson = await status.json();
      expect(statusJson.data.cameras.cam3.camera_ok).toBe(true);
      expect(statusJson.data.cameras.cam3.state).toBe('streaming');
      expect(liveJson.data.stream).toBe(statusJson.data.cameras.cam3.camera_ok);
      const frame = await fetch(`${base}/cameras/cam3/frame`);
      expect(frame.status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('honors lock and next on the mock without a flight command', async () => {
    const env = {
      COMPANION_MODE: 'mock',
      VITEST: 'true',
      VLC_VISION_MOCK_TRACKS: JSON.stringify(FIXTURE),
    };
    const server = await listen(appFor(env));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}${COMPANION_PROXY_PREFIX}`;
    try {
      const lock = await fetch(`${base}/vision/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ camera: 'cam0', id: 4 }),
      });
      const locked = await lock.json();
      expect(locked.data.lock.id).toBe(4);
      expect(locked.data.lock.label_he).toBe('רכב');
      expect(locked.data.flight_commands).toBe(false);
      expect(locked.data.gimbal_steer.sent).toBe(false);

      const next = await fetch(`${base}/vision/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'next', camera: 'cam0', sort: 'class' }),
      });
      const stepped = await next.json();
      expect(stepped.data.lock.id).toBe(3);
      expect(stepped.data.flight_commands).toBe(false);

      const released = await fetch(`${base}/vision/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unlock', camera: 'cam0' }),
      });
      const open = await released.json();
      expect(open.data.lock).toBeNull();
      expect(open.data.flight_commands).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('stamps QA fixture tracks with the jpeg frame they belong to', async () => {
    const env = {
      COMPANION_MODE: 'mock',
      VLC_QA: '1',
      VLC_VISION_MOCK_TRACKS: JSON.stringify(FIXTURE),
    };
    const client = createCompanionService(env).client;
    const before = await client.getVisionTracks('cam0');
    expect(before.tracks.length).toBeGreaterThan(0);
    expect(before.frame_seq).toBeUndefined();
    const frame = await client.getCameraFrame('cam0');
    const after = await client.getVisionTracks('cam0');
    expect(after.frame_seq).toBe(frame.frameSeq);
    expect(after.captured_at).toBe(frame.capturedAt);
    expect(after.frame_seq).toBeGreaterThan(0);
    expect(after.captured_at).toBeGreaterThan(0);
    expect(after.tracks[0].label_he).toBe('אדם');
    expect(frame.tracks.frame_seq).toBe(frame.frameSeq);
    expect(frame.tracks.tracks[0].label_he).toBe('אדם');
    const server = await listen(appFor(env));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}${COMPANION_PROXY_PREFIX}`;
    try {
      const live = await (await fetch(`${base}/vision/tracks?camera=cam0`)).json();
      expect(live.data.tracks[0].label_he).toBe('אדם');
      expect(live.data.backend).toBe('fixture');
      let since = 0;
      let matched = 0;
      const total = 40;
      for (let i = 0; i < total; i += 1) {
        const res = await fetch(`${base}/cameras/cam0/frame?since=${since}`);
        expect(res.status).toBe(200);
        const seq = Number(res.headers.get('x-airvix-frame-seq'));
        const body = decodeTracksHeader(res.headers.get('x-airvix-tracks'));
        if (body && Number(body.frame_seq) === seq && Array.isArray(body.tracks) && body.tracks.length > 0) matched += 1;
        since = seq;
        await res.arrayBuffer();
      }
      expect(matched / total).toBeGreaterThanOrEqual(0.95);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
