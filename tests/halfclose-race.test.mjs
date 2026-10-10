import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { closeCompanionHttpPools, jetsonFetch } from '../lib/jetson-socks.mjs';

afterEach(() => {
  closeCompanionHttpPools();
});

describe('companion keep-alive half-close', () => {
  it('survives a server FIN at the next poll', async () => {
    const idle = 200;
    const polls = 40;
    let connects = 0;
    const server = http.createServer((req, res) => {
      const body = '{"ok":true}';
      res.writeHead(200, { 'Content-Length': String(body.length), 'Content-Type': 'application/json' });
      res.end(body);
    });
    server.keepAliveTimeout = idle;
    server.on('connection', () => { connects += 1; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/v1/status-lite`;
    let ok = 0;
    let fail = 0;
    const errs = {};
    try {
      for (let i = 0; i < polls; i += 1) {
        try {
          const res = await jetsonFetch(url, {}, { env: {} });
          await res.text();
          ok += 1;
        } catch (err) {
          fail += 1;
          const key = err.code || err.message;
          errs[key] = (errs[key] || 0) + 1;
        }
        await new Promise((r) => setTimeout(r, idle - 2 + Math.random() * 4));
      }
      expect({ ok, fail, errs, connects }).toMatchObject({ fail: 0 });
      expect(ok).toBe(polls);
    } finally {
      closeCompanionHttpPools();
      server.closeAllConnections?.();
      server.close();
    }
  }, 20_000);
});
