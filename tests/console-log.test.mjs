import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRotatingLogStream } from '../lib/console-log.mjs';

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
});
