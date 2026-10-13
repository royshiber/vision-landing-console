import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createRotatingLogStream } from '../lib/console-log.mjs';
import { createConsoleLogDestination } from '../lib/logger.mjs';

describe('rotating console log', () => {
  it('writes console-*.log files and rotates by size', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-console-log-'));
    const stream = createRotatingLogStream({
      directory,
      maxBytes: 30,
      maxFiles: 3,
      prefix: 'console-',
    });
    const chunks = ['param-read-aaa\n', 'param-write-bbb\n', 'param-read-ccc\n'];
    for (const chunk of chunks) {
      await new Promise((resolve, reject) => {
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });
    const names = fs.readdirSync(directory).filter((name) => /^console-.*\.log$/.test(name));
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.length).toBeLessThanOrEqual(3);
    const text = names.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
    expect(text).toContain('param-read-aaa');
    expect(text).toContain('param-write-bbb');
    expect(text).toContain('param-read-ccc');
  });

  it('writes console-*.log when stdout never calls back', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airvix-console-stdout-'));
    const file = createRotatingLogStream({
      directory,
      maxBytes: 100_000,
      maxFiles: 2,
      prefix: 'console-',
    });
    const stdout = new Writable({
      write(_chunk, _encoding, _callback) {
        /* minimized Windows console: callback never fires */
      },
    });
    const dest = createConsoleLogDestination(stdout, file);
    await new Promise((resolve, reject) => {
      dest.write('hello-from-console\n', (err) => (err ? reject(err) : resolve()));
    });
    const names = fs.readdirSync(directory).filter((name) => /^console-.*\.log$/.test(name));
    expect(names.length).toBeGreaterThan(0);
    const text = names.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
    expect(text).toContain('hello-from-console');
    expect(text.length).toBeGreaterThan(0);
  });
});
