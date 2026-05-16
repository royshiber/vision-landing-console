import { describe, it, expect } from 'vitest';

/** Mirror server NDJSON framing for unit tests (one JSON object per line). */
function parseFlightEngineerNdjsonLines(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t));
  }
  return out;
}

describe('flight-engineer NDJSON stream', () => {
  it('parses delta + final lines', () => {
    const raw = '{"type":"delta","text":"היי"}\n{"type":"final","ok":true,"text":"היי שם","actions":[],"notes":[],"pendingChange":null}\n';
    const ev = parseFlightEngineerNdjsonLines(raw);
    expect(ev).toHaveLength(2);
    expect(ev[0].type).toBe('delta');
    expect(ev[0].text).toBe('היי');
    expect(ev[1].type).toBe('final');
    expect(ev[1].text).toBe('היי שם');
  });

  it('ignores empty lines and trims', () => {
    const raw = '\n  {"type":"delta","text":"x"}  \n\n';
    expect(parseFlightEngineerNdjsonLines(raw)).toHaveLength(1);
  });
});
