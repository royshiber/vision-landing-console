import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createCompanionService } from '../lib/companion-service.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { COMPANION_PROXY_PREFIX } from '../lib/companion-v1-paths.mjs';

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

describe('test-only mock vision tracks', () => {
  const prevTracks = process.env.VLC_VISION_MOCK_TRACKS;
  const prevVitest = process.env.VITEST;

  afterEach(() => {
    if (prevTracks == null) delete process.env.VLC_VISION_MOCK_TRACKS;
    else process.env.VLC_VISION_MOCK_TRACKS = prevTracks;
    if (prevVitest == null) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
  });

  it('serves fixture tracks through the proxy without a vision config post', async () => {
    process.env.VITEST = 'true';
    delete process.env.VLC_VISION_MOCK_TRACKS;
    const app = express();
    app.use(express.json());
    const service = createCompanionService({ COMPANION_MODE: 'mock' });
    registerCompanionProxyApi(app, { companionService: service });
    const server = await listen(app);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}${COMPANION_PROXY_PREFIX}`;
    try {
      const bare = await fetch(`${base}/vision/tracks?camera=cam0`);
      const bareJson = await bare.json();
      expect(bareJson.ok).toBe(true);
      expect(bareJson.lane).toBe('NEW');
      expect(bareJson.data.tracks).toEqual([]);
      expect(bareJson.data.flight_commands).toBe(false);

      process.env.VLC_VISION_MOCK_TRACKS = JSON.stringify(FIXTURE);
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

      process.env.VITEST = '';
      const hidden = await fetch(`${base}/vision/tracks?camera=cam0`);
      const hiddenJson = await hidden.json();
      expect(hiddenJson.data.tracks).toEqual([]);
      expect(hiddenJson.data.backend).toBe('off');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
