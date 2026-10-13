/**
 * Flat / black picture check.
 * A uniform JPEG has no AC energy. A pixel grid with tiny luminance variance is the same case.
 */

export function luminanceVariance(samples) {
  if (!samples || samples.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (const raw of samples) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  if (n < 2) return null;
  const mean = sum / n;
  let acc = 0;
  for (const raw of samples) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const d = v - mean;
    acc += d * d;
  }
  return acc / n;
}

/** Low luminance variance: black, grey, or any other flat field. */
export function samplesLookBlank(samples, maxVariance = 12) {
  const variance = luminanceVariance(samples);
  if (variance == null) return false;
  return variance < maxVariance;
}

function buildHuffmanTree(counts, symbols) {
  const root = {};
  let k = 0;
  let code = 0;
  for (let len = 1; len <= 16; len += 1) {
    const count = counts[len - 1] || 0;
    for (let i = 0; i < count; i += 1) {
      let node = root;
      for (let bit = len - 1; bit >= 0; bit -= 1) {
        const key = (code >> bit) & 1 ? '1' : '0';
        if (bit === 0) node[key] = symbols[k++];
        else {
          if (typeof node[key] !== 'object' || node[key] == null) node[key] = {};
          node = node[key];
        }
      }
      code += 1;
    }
    code <<= 1;
  }
  return root;
}

class BitReader {
  constructor(buf, start, end) {
    this.buf = buf;
    this.i = start;
    this.end = end;
    this.bit = 0;
    this.cur = 0;
    this.marker = 0;
  }

  align() {
    this.bit = 0;
  }

  nextBit() {
    if (this.marker) return -1;
    if (this.bit === 0) {
      if (this.i >= this.end) return -1;
      this.cur = this.buf[this.i++];
      if (this.cur === 0xff) {
        if (this.i >= this.end) return -1;
        const next = this.buf[this.i++];
        if (next !== 0x00) {
          this.marker = next;
          return -1;
        }
      }
      this.bit = 8;
    }
    this.bit -= 1;
    return (this.cur >> this.bit) & 1;
  }

  read(n) {
    let value = 0;
    for (let i = 0; i < n; i += 1) {
      const bit = this.nextBit();
      if (bit < 0) return -1;
      value = (value << 1) | bit;
    }
    return value;
  }
}

function decodeSymbol(bits, tree) {
  let node = tree;
  for (let depth = 0; depth < 16; depth += 1) {
    const bit = bits.nextBit();
    if (bit < 0) return null;
    node = node[bit ? '1' : '0'];
    if (typeof node === 'number') return node;
    if (!node) return null;
  }
  return null;
}

function receive(bits, category) {
  if (category === 0) return 0;
  const value = bits.read(category);
  if (value < 0) return null;
  const bound = 1 << (category - 1);
  return value >= bound ? value : value - ((1 << category) - 1);
}

function decodeBlockAc(bits, dcTable, acTable) {
  const dcCat = decodeSymbol(bits, dcTable);
  if (dcCat == null || dcCat > 11) return null;
  if (receive(bits, dcCat) == null) return null;
  let acAbs = 0;
  let k = 1;
  while (k < 64) {
    const rs = decodeSymbol(bits, acTable);
    if (rs == null) return null;
    const run = rs >> 4;
    const size = rs & 15;
    if (size === 0) {
      if (run === 15) {
        k += 16;
        continue;
      }
      break;
    }
    k += run;
    const ac = receive(bits, size);
    if (ac == null) return null;
    acAbs += Math.abs(ac);
    k += 1;
  }
  return acAbs;
}

/**
 * True when a baseline JPEG is a flat field.
 * Unknown or progressive files return false so a real picture is not hidden.
 */
export function jpegFrameIsBlank(bytes, { maxMeanAc = 1.5 } = {}) {
  if (!bytes || bytes.length < 32) return false;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  const dcTables = [];
  const acTables = [];
  let sof = null;
  let sos = null;
  let scanAt = 0;
  let restart = 0;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (buf[i] === 0xff) i += 1;
    const marker = buf[i++];
    if (marker === 0xd9 || marker === 0xda) {
      if (marker === 0xda && i + 1 < buf.length) {
        const len = buf.readUInt16BE(i);
        const n = buf[i + 2];
        const comps = [];
        let p = i + 3;
        for (let c = 0; c < n; c += 1) {
          comps.push({ id: buf[p], table: buf[p + 1] });
          p += 2;
        }
        sos = { comps };
        scanAt = i + len;
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= buf.length) break;
    const len = buf.readUInt16BE(i);
    const body = i + 2;
    const next = i + len;
    if (next > buf.length) break;
    if (marker === 0xc0) {
      const height = buf.readUInt16BE(body + 1);
      const width = buf.readUInt16BE(body + 3);
      const n = buf[body + 5];
      const comps = [];
      let p = body + 6;
      for (let c = 0; c < n; c += 1) {
        comps.push({
          id: buf[p],
          h: buf[p + 1] >> 4,
          v: buf[p + 1] & 15,
        });
        p += 3;
      }
      sof = { width, height, comps };
    } else if (marker === 0xc1 || marker === 0xc2) {
      return false;
    } else if (marker === 0xc4) {
      let p = body;
      while (p < next) {
        const info = buf[p++];
        const counts = [];
        let total = 0;
        for (let c = 0; c < 16; c += 1) {
          counts.push(buf[p++]);
          total += counts[c];
        }
        const symbols = [];
        for (let s = 0; s < total; s += 1) symbols.push(buf[p++]);
        const tree = buildHuffmanTree(counts, symbols);
        const slot = info & 15;
        if ((info >> 4) === 0) dcTables[slot] = tree;
        else acTables[slot] = tree;
      }
    } else if (marker === 0xdd) {
      restart = buf.readUInt16BE(body);
    }
    i = next;
  }
  if (!sof || !sos || !scanAt) return false;
  const y = sof.comps[0];
  if (!y || y.h < 1 || y.v < 1) return false;
  const bits = new BitReader(buf, scanAt, buf.length);
  const mcuW = Math.ceil(sof.width / (8 * y.h));
  const mcuH = Math.ceil(sof.height / (8 * y.v));
  const mcus = Math.max(1, mcuW * mcuH);
  let acSum = 0;
  let blocks = 0;
  let sinceRestart = 0;
  for (let mcu = 0; mcu < mcus; mcu += 1) {
    if (restart > 0 && sinceRestart === restart) {
      bits.align();
      if (bits.marker >= 0xd0 && bits.marker <= 0xd7) bits.marker = 0;
      sinceRestart = 0;
    }
    for (let c = 0; c < sos.comps.length; c += 1) {
      const spec = sof.comps[c];
      const sel = sos.comps[c];
      const count = spec ? spec.h * spec.v : 1;
      const dc = dcTables[sel.table >> 4];
      const ac = acTables[sel.table & 15];
      if (!dc || !ac) return false;
      for (let b = 0; b < count; b += 1) {
        const energy = decodeBlockAc(bits, dc, ac);
        if (energy == null) return blocks > 0 ? acSum / blocks < maxMeanAc : false;
        if (c === 0) {
          acSum += energy;
          blocks += 1;
        }
      }
    }
    sinceRestart += 1;
    if (blocks >= 8 && acSum / blocks >= maxMeanAc) return false;
  }
  if (!blocks) return false;
  return acSum / blocks < maxMeanAc;
}
