/**
 * Why: param reads and writes must stay auditable after the process exits.
 * What: append newline-delimited log bytes to logs/console-*.log and rotate by size.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

export function createRotatingLogStream({
  directory = path.join(process.cwd(), 'logs'),
  maxBytes = 5 * 1024 * 1024,
  maxFiles = 8,
  prefix = 'console-',
} = {}) {
  fs.mkdirSync(directory, { recursive: true });
  let stream = null;
  let size = 0;
  let currentName = '';
  let seq = 0;

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function prune() {
    const ranked = fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
      .map((name) => {
        const full = path.join(directory, name);
        return { name, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    while (ranked.length > maxFiles) {
      const old = ranked.shift();
      if (!old || old.name === currentName) continue;
      try { fs.unlinkSync(old.full); } catch { /* already gone */ }
    }
  }

  function openNext() {
    if (stream) stream.end();
    seq += 1;
    currentName = `${prefix}${stamp()}-${seq}.log`;
    const full = path.join(directory, currentName);
    stream = fs.createWriteStream(full, { flags: 'a' });
    size = 0;
    prune();
  }

  openNext();
  const writable = new Writable({
    write(chunk, encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (size > 0 && size + buf.length > maxBytes) openNext();
      size += buf.length;
      stream.write(buf, callback);
    },
  });
  writable.directory = directory;
  return writable;
}
