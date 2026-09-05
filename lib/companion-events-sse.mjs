/**
 * Companion API v1 GET /api/v1/events — SSE frame parse + EventEnvelope merge.
 * Node consumes this; the browser stays on EventSource('/api/stream').
 */

export const COMPANION_SSE_EVENT_TYPES = Object.freeze([
  'status',
  'vision',
  'mavlink',
  'navigation',
  'landing',
  'diagnostics',
]);

const EVENT_TYPE_SET = new Set(COMPANION_SSE_EVENT_TYPES);

export function extractSseDataLines(frame) {
  const lines = String(frame || '').split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!dataLines.length) return null;
  return dataLines.join('\n');
}

/**
 * Split a raw SSE buffer into complete JSON payloads. Incomplete tail stays in `rest`.
 * @param {string} buffer
 * @returns {{ events: object[], rest: string }}
 */
export function parseSseFrames(buffer) {
  const parts = String(buffer ?? '').split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const events = [];
  for (const frame of parts) {
    const data = extractSseDataLines(frame);
    if (data == null || data === '') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // skip malformed frames
    }
  }
  return { events, rest };
}

/**
 * OpenAPI EventEnvelope, or a bare CompanionStatus treated as event=status.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeCompanionEventEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.event === 'string' && EVENT_TYPE_SET.has(raw.event) && raw.payload != null) {
    return raw;
  }
  if (raw.timestamp && (raw.system || raw.fc || raw.mavlink || raw.vision || raw.navigation)) {
    return {
      api_version: raw.api_version || '1',
      event: 'status',
      timestamp: raw.timestamp,
      payload: raw,
    };
  }
  return null;
}

/**
 * Merge an EventEnvelope into the collectStatusBundle / mapCompanionStatus shape.
 * status → CompanionStatus fields at top level; siblings keep last known extras.
 * @param {object | null | undefined} bundle
 * @param {object} envelope
 */
export function mergeCompanionEventIntoBundle(bundle, envelope) {
  const next = { ...(bundle || {}) };
  const ev = envelope?.event;
  const payload = envelope?.payload;
  if (envelope?.api_version) next.api_version = envelope.api_version;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return next;
  switch (ev) {
    case 'status':
      return { ...next, ...payload };
    case 'vision':
      return { ...next, visionResult: payload, vision: { ...next.vision, ...payload } };
    case 'mavlink':
      return { ...next, mavlink: payload };
    case 'navigation':
      return { ...next, navigationEstimate: payload, navigation: { ...next.navigation, ...payload } };
    case 'landing':
      return { ...next, landing: payload };
    case 'diagnostics':
      return { ...next, diagnostics: payload };
    default:
      return next;
  }
}

/**
 * Any failed events-stream open is a poll fallback (404/501/connection called out by the brief).
 * @param {unknown} err
 */
export function isCompanionEventsStreamUnsupported(err) {
  if (!err) return true;
  const status = err.status;
  if (status === 404 || status === 405 || status === 501) return true;
  const kind = err.kind;
  if (kind === 'connection' || kind === 'timeout' || kind === 'config' || kind === 'parse' || kind === 'http') {
    return true;
  }
  return true;
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(json: object) => void} onJson
 * @param {AbortSignal} [signal]
 */
export async function readCompanionSseStream(body, onJson, signal) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Companion events stream has no body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
  }
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const parsed = parseSseFrames(`${buffer}\n\n`);
          for (const ev of parsed.events) onJson?.(ev);
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const ev of parsed.events) onJson?.(ev);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
