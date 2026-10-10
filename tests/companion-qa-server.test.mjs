import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4077';
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = {
  camera: 'cam0',
  enabled: true,
  stream: true,
  tracks: [
    { id: 4, class: 'car', label_he: 'רכב', confidence: 0.8, bbox: [10, 10, 20, 12], color_he: 'לבן' },
  ],
};

describe('real server keeps the QA mock tracks', () => {
  let serverProc = null;

  afterAll(() => {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  it('passes VLC_QA, mock tracks, and cam3 into the running server and answers within a second', async () => {
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT,
      SQLITE_PATH: `/tmp/airvix-qa-server-${PORT}-${process.pid}.sqlite`,
      COMPANION_MODE: 'mock',
      VLC_QA: '1',
      VLC_VISION_MOCK_TRACKS: JSON.stringify(FIXTURE),
      VLC_MOCK_CAM3_STREAM: '1',
      GEMINI_API_KEY: 'present-but-unused',
    };
    delete env.VITEST;
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const health = await fetch(`${BASE}/api/health`);
        if (health.ok) {
          up = true;
          break;
        }
      } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(up).toBe(true);

    const cam0 = await fetch(`${BASE}/api/jetson/v1/vision/tracks?camera=cam0`);
    const cam0Json = await cam0.json();
    expect(cam0Json.data.tracks.map((row) => row.label_he)).toEqual(['רכב']);
    expect(cam0Json.data.stream).toBe(true);
    expect(cam0Json.data.flight_commands).toBe(false);

    const cam3 = await fetch(`${BASE}/api/jetson/v1/vision/tracks?camera=cam3`);
    const cam3Json = await cam3.json();
    expect(cam3Json.data.stream).toBe(true);

    let pulling = true;
    const frames = (async () => {
      while (pulling) {
        await Promise.all(['cam0', 'cam1', 'cam3'].map((id) => fetch(`${BASE}/api/jetson/v1/cameras/${id}/frame?since=0`).catch(() => null)));
      }
    })();
    const phrases = ['כמה רכבים יש', 'תסרוק', 'כמה חתולים יש', 'מה מצב המצלמות', 'מה מצב הטיסה'];
    const samples = [];
    for (const text of phrases) {
      const started = Date.now();
      const response = await fetch(`${BASE}/api/assist/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          channel: 'voice',
          context: {
            current_workspace: 'MISSION',
            vision: cam0Json.data,
          },
        }),
      });
      const body = await response.json();
      expect(response.status, text).toBe(200);
      const elapsed = Date.now() - started;
      samples.push(elapsed);
      expect(elapsed, text).toBeLessThan(1000);
      expect(String(body.response?.answer || ''), text).not.toMatch(/Gemini|error/i);
    }
    pulling = false;
    await frames;
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`ASSIST_MOCK_MS ${JSON.stringify({ samples, median, max: Math.max(...samples) })}`);
    expect(median).toBeLessThan(1000);
    expect(Math.max(...samples)).toBeLessThan(1000);
  }, 30000);
});
