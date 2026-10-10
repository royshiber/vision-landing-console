import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  SLOW_SOCKET_GRACE_MS,
  closeCompanionHttpPools,
  dequeueRequest,
  directKeepAliveAgent,
  directStreamAgent,
  jetsonFetch,
} from '../lib/jetson-socks.mjs';

afterEach(() => {
  closeCompanionHttpPools();
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
}

describe('companion short-request pool', () => {
  it('status poll completes while 4 streams are open', async () => {
    const server = http.createServer((req, res) => {
      if (String(req.url).includes('stream') || String(req.url).endsWith('/events')) {
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=f' });
        const timer = setInterval(() => res.write('--f\r\n\r\nx\r\n'), 50);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { 'Content-Length': 2 });
      res.end('{}');
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const controllers = [];
    try {
      for (let i = 0; i < 4; i++) {
        const ac = new AbortController();
        controllers.push(ac);
        await jetsonFetch(`${base}/api/v1/cam1/stream.mjpg`, { signal: ac.signal }, { env: {} });
      }
      const events = new AbortController();
      controllers.push(events);
      await jetsonFetch(`${base}/api/v1/events`, { signal: events.signal }, { env: {} });
      expect(directStreamAgent(base)).not.toBe(directKeepAliveAgent(base));
      expect(directKeepAliveAgent(base).maxSockets).toBe(4);

      const started = Date.now();
      let err = null;
      const guard = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('no settle within 3000 ms (abort signal ignored while queued)')), 3000);
      });
      try {
        await Promise.race([
          guard,
          jetsonFetch(`${base}/api/v1/status-lite`, { signal: AbortSignal.timeout(2000) }, { env: {} }).then((res) => res.text()),
        ]);
      } catch (error) {
        err = error;
      }
      const elapsed = Date.now() - started;
      expect(err, `status poll blocked behind streams (${elapsed} ms): ${err?.name} ${err?.message}`).toBeNull();
      expect(elapsed).toBeLessThan(1000);
    } finally {
      for (const ac of controllers) ac.abort();
      closeCompanionHttpPools();
      closeServer(server);
    }
  });

  it('dequeues a short request when its timeout fires', async () => {
    let holds = 0;
    let liteHits = 0;
    const server = http.createServer((req, res) => {
      if (String(req.url).includes('status-lite')) {
        liteHits += 1;
        res.writeHead(200, { 'Content-Length': 2 });
        res.end('{}');
        return;
      }
      holds += 1;
      res.writeHead(200, { 'Content-Length': 2 });
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const holders = [];
    try {
      for (let i = 0; i < 4; i++) {
        const ac = new AbortController();
        holders.push(ac);
        const pending = jetsonFetch(`${base}/hold`, { signal: ac.signal }, { env: {} });
        pending.catch(() => {});
      }
      const ready = Date.now();
      while (holds < 4 && Date.now() - ready < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(holds).toBe(4);

      const started = Date.now();
      let err = null;
      const guard = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('queued request ignored the timeout')), 3000);
      });
      try {
        await Promise.race([
          guard,
          jetsonFetch(`${base}/api/v1/status-lite`, { signal: AbortSignal.timeout(400) }, { env: {} }).then((res) => res.text()),
        ]);
      } catch (error) {
        err = error;
      }
      const elapsed = Date.now() - started;
      expect(err?.name).toBe('AbortError');
      expect(elapsed).toBeLessThan(1500);
      expect(liteHits).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(liteHits).toBe(0);
    } finally {
      for (const ac of holders) ac.abort();
      closeCompanionHttpPools();
      closeServer(server);
    }
  });

  it('keeps the socket when a slow response outlives the waiter', async () => {
    let connects = 0;
    let finished = 0;
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        const body = '{}';
        res.writeHead(200, { 'Content-Length': String(body.length) });
        res.end(body);
        finished += 1;
      }, 800);
    });
    server.on('connection', () => { connects += 1; });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/api/v1/status-lite`;
    try {
      await expect(jetsonFetch(url, { signal: AbortSignal.timeout(250) }, { env: {} }).then((res) => res.text()))
        .rejects.toMatchObject({ name: 'AbortError' });
      const waitStart = Date.now();
      while (finished < 1 && Date.now() - waitStart < 2000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(finished).toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, 50));
      const res = await jetsonFetch(url, {}, { env: {} });
      expect(await res.text()).toBe('{}');
      const drain = Date.now();
      while (finished < 2 && Date.now() - drain < 2000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(connects).toBe(1);
    } finally {
      closeCompanionHttpPools();
      closeServer(server);
    }
  });

  it('drops a socket that never answers after the grace period', async () => {
    const server = http.createServer((req, res) => {
      if (String(req.url).includes('hang')) return;
      res.writeHead(200, { 'Content-Length': 2 });
      res.end('{}');
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    try {
      const errs = await Promise.all([1, 2, 3, 4].map((i) => (
        jetsonFetch(`${base}/api/v1/hang?${i}`, { signal: AbortSignal.timeout(400) }, { env: {} })
          .then(() => 'ok', (err) => err.name)
      )));
      expect(errs).toEqual(['AbortError', 'AbortError', 'AbortError', 'AbortError']);
      await new Promise((r) => setTimeout(r, SLOW_SOCKET_GRACE_MS + 400));
      const started = Date.now();
      const res = await jetsonFetch(`${base}/api/v1/status-lite`, { signal: AbortSignal.timeout(2000) }, { env: {} });
      expect(await res.text()).toBe('{}');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      closeCompanionHttpPools();
      closeServer(server);
    }
  }, 15_000);

  it('releases a socket when the body stalls after the headers', async () => {
    let headers = 0;
    const server = http.createServer((req, res) => {
      if (String(req.url).includes('stall')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        headers += 1;
        return;
      }
      res.writeHead(200, { 'Content-Length': 2 });
      res.end('{}');
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const controllers = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const ac = new AbortController();
        controllers.push(ac);
        jetsonFetch(`${base}/stall?${i}`, { signal: ac.signal }, { env: {} })
          .then((res) => res.text().catch(() => {}))
          .catch(() => {});
      }
      const ready = Date.now();
      while (headers < 4 && Date.now() - ready < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(headers).toBe(4);
      for (const ac of controllers) ac.abort();
      await new Promise((r) => setTimeout(r, SLOW_SOCKET_GRACE_MS + 400));
      const started = Date.now();
      const res = await jetsonFetch(`${base}/api/v1/status-lite`, { signal: AbortSignal.timeout(2000) }, { env: {} });
      expect(await res.text()).toBe('{}');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      for (const ac of controllers) ac.abort();
      closeCompanionHttpPools();
      closeServer(server);
    }
  }, 15_000);

  it('after: headers follow the timeout, then the body stalls, and the pool recovers in about 3.5s', async () => {
    const headerDelayMs = 700;
    const clientTimeoutMs = 500;
    let headers = 0;
    let liteHits = 0;
    const pendingTimers = [];
    const server = http.createServer((req, res) => {
      if (String(req.url).includes('stall')) {
        const timer = setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"partial":');
            headers += 1;
          } catch { /* caller already dropped the socket */ }
        }, headerDelayMs);
        pendingTimers.push(timer);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      liteHits += 1;
      res.writeHead(200, { 'Content-Length': 2 });
      res.end('{}');
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    try {
      const errs = await Promise.all([1, 2, 3, 4].map((i) => (
        jetsonFetch(`${base}/stall?${i}`, { signal: AbortSignal.timeout(clientTimeoutMs) }, { env: {} })
          .then((res) => res.text().then(() => 'ok', () => 'ok'), (err) => err.name)
      )));
      expect(errs).toEqual(['AbortError', 'AbortError', 'AbortError', 'AbortError']);
      const headerWait = Date.now();
      while (headers < 4 && Date.now() - headerWait < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(headers).toBe(4);
      const headersAt = Date.now();

      await expect(
        jetsonFetch(`${base}/api/v1/status-lite`, { signal: AbortSignal.timeout(300) }, { env: {} }).then((res) => res.text()),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(liteHits).toBe(0);

      const remain = SLOW_SOCKET_GRACE_MS + 500 - (Date.now() - headersAt);
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      const probeAt = Date.now();
      const res = await jetsonFetch(`${base}/api/v1/status-lite`, { signal: AbortSignal.timeout(2000) }, { env: {} });
      expect(await res.text()).toBe('{}');
      expect(Date.now() - probeAt).toBeLessThan(1000);
      const recoveredMs = Date.now() - headersAt;
      expect(recoveredMs).toBeGreaterThanOrEqual(SLOW_SOCKET_GRACE_MS);
      expect(recoveredMs).toBeLessThan(4500);
    } finally {
      for (const timer of pendingTimers) clearTimeout(timer);
      closeCompanionHttpPools();
      closeServer(server);
    }
  }, 15_000);

  it('splices one request out of an unknown queue and leaves the rest', () => {
    const target = { id: 'target' };
    const other = { id: 'other' };
    const bucket = { keep: other, drop: target, note: 'layout' };
    const opaque = { nested: { req: target } };
    const agent = {
      requests: {
        shaped: bucket,
        opaque,
        listed: [other, target],
        only: [target],
      },
    };
    expect(dequeueRequest(agent, target)).toBe(true);
    expect(bucket.keep).toBe(other);
    expect(bucket.drop).toBeUndefined();
    expect(bucket.note).toBe('layout');
    expect(agent.requests.opaque).toBe(opaque);
    expect(opaque.nested.req).toBe(target);
    expect(agent.requests.listed).toEqual([other]);
    expect(agent.requests.only).toBeUndefined();
  });

  it('removes only the timed-out request from an unknown queue of six', () => {
    const waiting = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}` }));
    const timedOut = waiting[3];
    const bucket = Object.fromEntries(waiting.map((req) => [req.id, req]));
    const agent = { requests: { '127.0.0.1:4010:': bucket } };
    expect(dequeueRequest(agent, timedOut)).toBe(true);
    expect(agent.requests['127.0.0.1:4010:']).toBe(bucket);
    expect(Object.values(bucket)).toEqual(waiting.filter((req) => req !== timedOut));
  });
});
