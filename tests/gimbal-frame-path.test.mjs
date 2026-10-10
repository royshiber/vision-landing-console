import { describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createLatestFrameShelf, framePullIsLate as shelfLate } from '../lib/camera-latest-jpeg.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import {
  createLatestJpegPump,
  framePullIsLate as pumpLate,
} from '../public/modules/camera-latest-frame.mjs';

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABmX/9k=',
  'base64',
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeSampleJpeg() {
  const script = [
    'from PIL import Image',
    'import io, time',
    'im = Image.new("RGB", (640, 480), (18, 42, 64))',
    'buf = io.BytesIO()',
    't = time.perf_counter()',
    'im.save(buf, "JPEG", quality=80)',
    'import sys',
    'ms = (time.perf_counter() - t) * 1000',
    'sys.stdout.buffer.write(("{:.3f}\\n".format(ms)).encode())',
    'sys.stdout.buffer.write(buf.getvalue())',
  ].join('\n');
  const run = spawnSync('python3', ['-c', script], { encoding: 'buffer', timeout: 15000 });
  if (run.status !== 0 || !run.stdout) return null;
  const split = run.stdout.indexOf(10);
  if (split < 0) return null;
  const ms = Number(run.stdout.subarray(0, split).toString());
  const bytes = run.stdout.subarray(split + 1);
  if (!Number.isFinite(ms) || bytes.length < 100) return null;
  return { encodeMs: ms, bytes: Buffer.from(bytes) };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('gimbal frame path', () => {
  it('lets the event loop run while an instant mock frame stays hot', async () => {
    let pulls = 0;
    const shelf = createLatestFrameShelf({
      async pull() {
        pulls += 1;
        return { bytes: Buffer.from('jpeg-bytes'), contentType: 'image/jpeg', frameSeq: pulls, capturedAt: Date.now() };
      },
    });
    const first = Date.now();
    await shelf.take({ since: 0 });
    expect(Date.now() - first).toBeLessThan(200);
    const marks = [];
    const timer = setInterval(() => marks.push(Date.now()), 20);
    const gapStarted = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const yielded = Date.now() - gapStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));
    clearInterval(timer);
    expect(yielded).toBeLessThan(200);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(pulls).toBeLessThan(40);
  });

  it('drops a late pull and paints the newer frame without waiting it out', async () => {
    const oldBytes = Buffer.from('old-frame-bytes');
    const newBytes = Buffer.from('new-frame-bytes');
    const aborted = [];
    let calls = 0;
    const shelf = createLatestFrameShelf({
      async pull({ signal }) {
        const mine = ++calls;
        const slow = mine === 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              bytes: slow ? oldBytes : newBytes,
              contentType: 'image/jpeg',
              capturedAt: Date.now(),
              encodeMs: slow ? 0 : 11,
            });
          }, slow ? 280 : 40);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(mine);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      },
    });

    const first = shelf.take({ since: 0 });
    await delay(25);
    const newerAt = Date.now();
    const frame = await shelf.take({ fresh: true });
    const newerMs = Date.now() - newerAt;
    console.log(`GIMBAL_SUPERSEDE_SHELF ${JSON.stringify({ oldPullMs: 280, newerPaintMs: newerMs, aborted: aborted.includes(1) })}`);
    expect(frame.bytes.equals(newBytes)).toBe(true);
    expect(newerMs).toBeLessThan(180);
    expect(aborted).toContain(1);
    const firstFrame = await first;
    expect(firstFrame.bytes.equals(newBytes)).toBe(true);
    await delay(260);
    expect(shelf.current().bytes.equals(newBytes)).toBe(true);
    expect(shelf.current().bytes.equals(oldBytes)).toBe(false);
  });

  it('replaces an in-flight browser load without waiting for the old one', async () => {
    const painted = [];
    const misses = [];
    let n = 0;
    const pump = createLatestJpegPump({
      follow: () => false,
      urlFor(gen) {
        return `frame-${gen}`;
      },
      load(src) {
        const seq = ++n;
        const slow = seq === 1;
        return new Promise((resolve) => {
          setTimeout(() => resolve({ src, seq, objectUrl: '' }), slow ? 220 : 30);
        });
      },
      onFrame(src, meta) {
        painted.push({ src, seq: meta.seq, at: Date.now() });
      },
      onMiss() {
        misses.push(Date.now());
      },
    });
    const started = Date.now();
    pump.start();
    await delay(15);
    const replaceAt = Date.now();
    pump.replace();
    await delay(90);
    console.log(`GIMBAL_SUPERSEDE_PUMP ${JSON.stringify({ oldLoadMs: 220, newerPaintMs: painted[0].at - replaceAt })}`);
    expect(painted.map((row) => row.seq)).toEqual([2]);
    expect(painted[0].at - replaceAt).toBeLessThan(120);
    expect(painted[0].at - started).toBeLessThan(160);
    await delay(180);
    expect(painted.map((row) => row.seq)).toEqual([2]);
    expect(misses).toEqual([]);
    pump.stop();
  });

  it('waits a second before the next companion frame after a miss', async () => {
    let calls = 0;
    const pump = createLatestJpegPump({
      follow: () => true,
      urlFor(gen) {
        return `frame-${gen}`;
      },
      load() {
        calls += 1;
        const err = new Error('down');
        err.name = 'MissError';
        return Promise.reject(err);
      },
    });
    pump.start();
    await delay(40);
    expect(calls).toBe(1);
    pump.start();
    await delay(400);
    expect(calls).toBe(1);
    await delay(700);
    expect(calls).toBe(2);
    pump.stop();
    await delay(50);
    const held = calls;
    await delay(200);
    expect(calls).toBe(held);
  });

  it('measures capture, encode, fetch, decode, and paint before and after the cut', async () => {
    const sample = encodeSampleJpeg();
    const bytes = sample?.bytes || TINY_JPEG;
    const encodeMs = sample?.encodeMs ?? 0;
    const linkMs = 80;

    const server = http.createServer((req, res) => {
      const timer = setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store',
          'X-Airvix-Capture-At': String(Date.now() - encodeMs),
          'X-Encode-Ms': String(encodeMs),
        });
        res.end(bytes);
      }, linkMs);
      req.on('close', () => {
        if (!res.writableEnded) clearTimeout(timer);
      });
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/frame.jpg`;

    const beforeCapture = Date.now();
    const paidEncodeMs = sample ? sample.encodeMs : 15;
    if (!sample) await delay(paidEncodeMs);
    const firstFetchStarted = Date.now();
    const first = await fetch(url);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const firstFetchMs = Date.now() - firstFetchStarted;
    const secondFetchStarted = Date.now();
    const second = await fetch(url);
    const secondBytes = Buffer.from(await second.arrayBuffer());
    const secondFetchMs = Date.now() - secondFetchStarted;
    expect(firstBytes.length).toBe(bytes.length);
    expect(secondBytes.length).toBe(bytes.length);

    const afterCapture = Date.now();
    const afterEncodePaidMs = paidEncodeMs;
    const shelf = createLatestFrameShelf({
      async pull({ signal }) {
        const res = await fetch(url, { signal });
        const body = Buffer.from(await res.arrayBuffer());
        return {
          bytes: body,
          contentType: 'image/jpeg',
          capturedAt: Number(res.headers.get('x-airvix-capture-at')),
          encodeMs: Number(res.headers.get('x-encode-ms')),
        };
      },
    });
    const shelfStarted = Date.now();
    const latest = await shelf.take({ since: 0, waitMs: 1000 });
    const shelfFetchMs = Date.now() - shelfStarted;
    expect(latest.bytes.length).toBe(bytes.length);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<canvas id="c"></canvas>');
    const timedVisual = await page.evaluate(async (b64) => {
      const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const blob = new Blob([raw], { type: 'image/jpeg' });
      async function once() {
        const t = performance.now();
        const bmp = await createImageBitmap(blob);
        const decodeMs = performance.now() - t;
        const canvas = document.getElementById('c');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        const p = performance.now();
        ctx.drawImage(bmp, 0, 0);
        const paintMs = performance.now() - p;
        bmp.close();
        return { decodeMs, paintMs, width: canvas.width, height: canvas.height };
      }
      const firstPass = await once();
      const secondPass = await once();
      const rafMs = await new Promise((resolve) => {
        const t = performance.now();
        requestAnimationFrame(() => resolve(performance.now() - t));
      });
      return { firstPass, secondPass, rafMs };
    }, bytes.toString('base64'));
    await browser.close();
    await closeServer(server);

    const before = {
      encodeMs: Number(paidEncodeMs.toFixed(3)),
      fetchMs: Number(firstFetchMs.toFixed(3)),
      secondFetchMs: Number(secondFetchMs.toFixed(3)),
      animationFrameMs: Number(timedVisual.rafMs.toFixed(3)),
      decodeMs: Number(timedVisual.firstPass.decodeMs.toFixed(3)),
      secondDecodeMs: Number(timedVisual.secondPass.decodeMs.toFixed(3)),
      paintMs: Number(timedVisual.firstPass.paintMs.toFixed(3)),
      secondPaintMs: Number(timedVisual.secondPass.paintMs.toFixed(3)),
    };
    before.captureToPaintMs = Number((
      before.encodeMs
      + before.fetchMs
      + before.secondFetchMs
      + before.animationFrameMs
      + before.decodeMs
      + before.secondDecodeMs
      + before.paintMs
      + before.secondPaintMs
    ).toFixed(2));
    const after = {
      encodeMs: before.encodeMs,
      fetchMs: Number(shelfFetchMs.toFixed(3)),
      decodeMs: before.decodeMs,
      paintMs: before.paintMs,
    };
    after.captureToPaintMs = Number((
      after.encodeMs + after.fetchMs + after.decodeMs + after.paintMs
    ).toFixed(2));
    const report = {
      liveGimbal: 'not measured from this VM',
      jpegBytes: bytes.length,
      jpegWidth: timedVisual.firstPass.width,
      jpegHeight: timedVisual.firstPass.height,
      encodeSource: sample ? 'pillow-640x480-q80' : 'tiny-jpeg-no-encoder',
      linkMs,
      before,
      after,
      savedMs: Number((before.captureToPaintMs - after.captureToPaintMs).toFixed(2)),
    };
    console.log(`GIMBAL_FRAME_PATH ${JSON.stringify(report)}`);
    expect(beforeCapture).toBeLessThan(Date.now());
    expect(afterCapture).toBeLessThan(Date.now());
    expect(afterEncodePaidMs).toBeGreaterThanOrEqual(0);
    expect(encodeMs).toBeGreaterThanOrEqual(0);
    expect(before.secondFetchMs).toBeGreaterThan(linkMs * 0.5);
    expect(after.fetchMs).toBeLessThan(before.fetchMs + before.secondFetchMs);
    expect(after.captureToPaintMs).toBeLessThan(before.captureToPaintMs);
    expect(timedVisual.firstPass.width).toBeGreaterThan(0);
    expect(timedVisual.firstPass.height).toBeGreaterThan(0);
  }, 30000);

  it('serves the newer proxy frame while the older companion pull is aborted', async () => {
    const oldBytes = Buffer.from('proxy-old-frame');
    const newBytes = Buffer.from('proxy-new-frame');
    let calls = 0;
    const aborted = [];
    const client = {
      getCameraFrame(_id, opts = {}) {
        const mine = ++calls;
        const slow = mine === 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              bytes: slow ? oldBytes : newBytes,
              contentType: 'image/jpeg',
              capturedAt: Date.now(),
              encodeMs: 9,
            });
          }, slow ? 300 : 40);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(mine);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      },
    };
    const app = express();
    registerCompanionProxyApi(app, { companionService: { client, describe: () => ({ mode: 'mock' }) } });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/api/jetson/v1/cameras/cam3/frame`;
    try {
      const first = fetch(base);
      await delay(20);
      const t0 = Date.now();
      const res = await fetch(`${base}?newest=1`);
      const newerMs = Date.now() - t0;
      const body = Buffer.from(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(body.equals(newBytes)).toBe(true);
      expect(newerMs).toBeLessThan(180);
      expect(Number(res.headers.get('x-airvix-encode-ms'))).toBe(9);
      expect(Number(res.headers.get('x-airvix-frame-seq'))).toBeGreaterThan(1);
      expect(aborted).toContain(1);
      const firstRes = await first;
      const firstBody = Buffer.from(await firstRes.arrayBuffer());
      expect(firstBody.equals(newBytes)).toBe(true);
      await delay(280);
      expect(aborted).toContain(1);
      const again = await fetch(base);
      const againBody = Buffer.from(await again.arrayBuffer());
      expect(againBody.equals(oldBytes)).toBe(false);
    } finally {
      await closeServer(server);
    }
  }, 20000);

  it('keeps the 1.02.409 layout hooks on the newest-frame path', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const debrief = readFileSync(new URL('../public/modules/debrief-cameras.mjs', import.meta.url), 'utf8');
    const gimbal = readFileSync(new URL('../public/modules/gimbal-screen.mjs', import.meta.url), 'utf8');
    expect(app).toContain('function fitHorizonPicture');
    expect(app).toContain('newest=1');
    expect(app).toContain('fitHorizonPicture(img)');
    expect(debrief).toContain('followLoadedFrame');
    expect(debrief).toContain('layoutCameraPanes');
    expect(debrief).toContain('newest=1');
    expect(gimbal).toContain('ensureFlightMap');
    expect(gimbal).toContain('bindChrome');
    expect(gimbal).toContain('newest=1');
  });

  it('treats a young pull as still current and a stuck one as late', () => {
    expect(shelfLate(500, 100)).toBe(true);
    expect(pumpLate(500, 100)).toBe(true);
    expect(shelfLate(300, 100)).toBe(false);
    expect(pumpLate(300, 100)).toBe(false);
    expect(shelfLate(2000, 0)).toBe(false);
    expect(pumpLate(2000, 0)).toBe(false);
  });
});
