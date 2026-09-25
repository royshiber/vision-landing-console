/** Gzip, chunk reassembly, and sha256 checks for flight-log objects. */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function isGzip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Transparent gunzip. Plain bytes pass through. */
export function inflateMaybeGzip(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!isGzip(bytes)) return bytes;
  return zlib.gunzipSync(bytes);
}

export function parseJsonMaybeGzip(buf) {
  const text = inflateMaybeGzip(buf).toString('utf8');
  return JSON.parse(text);
}

export function parseJsonlMaybeGzip(buf) {
  const text = inflateMaybeGzip(buf).toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

/**
 * Reassemble `<name>.partNNNN` using `<name>.parts.json`.
 * sha256 mismatch → state corrupt. Never returned as good.
 * @param {{parts: {n: number, bytes: number, sha256: string}[], bytes: number, sha256: string}} manifest
 * @param {Buffer[]} partBuffers in part-number order
 */
export function reassembleChunks(manifest, partBuffers) {
  const parts = Array.isArray(manifest?.parts) ? manifest.parts : [];
  if (!parts.length || parts.length !== partBuffers.length) {
    return { ok: false, state: 'corrupt', reason: 'corrupt', bytes: null };
  }
  const ordered = parts.map((p, i) => ({ meta: p, buf: partBuffers[i] }));
  ordered.sort((a, b) => Number(a.meta.n) - Number(b.meta.n));
  for (const { meta, buf } of ordered) {
    if (!Buffer.isBuffer(buf)) return { ok: false, state: 'corrupt', reason: 'corrupt', bytes: null };
    if (meta.bytes != null && buf.length !== Number(meta.bytes)) {
      return { ok: false, state: 'corrupt', reason: 'corrupt', bytes: null };
    }
    if (meta.sha256 && sha256Hex(buf) !== String(meta.sha256).toLowerCase()) {
      return { ok: false, state: 'corrupt', reason: 'corrupt', bytes: null };
    }
  }
  const bytes = Buffer.concat(ordered.map((p) => p.buf));
  if (manifest.bytes != null && bytes.length !== Number(manifest.bytes)) {
    return { ok: false, state: 'corrupt', reason: 'corrupt', bytes: null };
  }
  const sum = sha256Hex(bytes);
  if (manifest.sha256 && sum !== String(manifest.sha256).toLowerCase()) {
    return { ok: false, state: 'corrupt', reason: 'corrupt', bytes: null };
  }
  return { ok: true, state: 'uploaded', reason: null, bytes, sha256: sum };
}

export function verifySha(buf, expected) {
  if (!expected) return { ok: true, sha256: sha256Hex(buf) };
  const sha256 = sha256Hex(buf);
  if (sha256 !== String(expected).toLowerCase()) return { ok: false, state: 'corrupt', sha256 };
  return { ok: true, sha256 };
}
