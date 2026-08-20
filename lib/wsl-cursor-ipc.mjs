import { assertNoSecrets, redactSecrets } from './wsl-cursor-secret.mjs';

export const MAX_IPC_LINE_BYTES = 256 * 1024;

/** Windows bridge to Linux runtime. */
export const IPC_COMMAND_TYPES = Object.freeze(['start', 'resume', 'send', 'cancel', 'status', 'dispose']);

/** Linux runtime to Windows bridge. */
export const IPC_EVENT_TYPES = Object.freeze([
  'hello',
  'health',
  'started',
  'ack',
  'state',
  'message',
  'finished',
  'cancelled',
  'unsupported',
  'error',
]);

export function encodeIpcMessage(message, extraSecrets = []) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('ipc message must be an object');
  }
  const type = String(message.type || '');
  if (!IPC_COMMAND_TYPES.includes(type) && !IPC_EVENT_TYPES.includes(type)) {
    throw new Error(`unsupported ipc message type: ${type || '(missing)'}`);
  }
  assertNoSecrets(message, extraSecrets);
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') > MAX_IPC_LINE_BYTES) {
    throw new Error('ipc message too large');
  }
  return `${line}\n`;
}

export function parseIpcLine(line, { allowedTypes = IPC_EVENT_TYPES, extraSecrets = [] } = {}) {
  const raw = String(line ?? '').trim();
  if (!raw) throw new Error('empty ipc line');
  if (Buffer.byteLength(raw, 'utf8') > MAX_IPC_LINE_BYTES) throw new Error('ipc line too large');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ipc line is not json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ipc message must be an object');
  }
  const type = parsed.type;
  if (typeof type !== 'string' || !allowedTypes.includes(type)) {
    throw new Error('ipc message type is not allowed');
  }
  return redactIpcStrings(parsed, extraSecrets);
}

function redactIpcStrings(value, extraSecrets, depth = 0) {
  if (depth > 6) return null;
  if (typeof value === 'string') return redactSecrets(value, extraSecrets);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactIpcStrings(v, extraSecrets, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactIpcStrings(v, extraSecrets, depth + 1);
    return out;
  }
  return value;
}

/**
 * Newline-delimited framing over a pipe. Oversized frames are dropped rather
 * than buffered without bound, so a noisy runtime cannot exhaust host memory.
 */
export function createLineBuffer({ maxLineBytes = MAX_IPC_LINE_BYTES } = {}) {
  let buffer = '';
  let overflowed = 0;
  return {
    push(chunk) {
      buffer += String(chunk ?? '');
      const lines = [];
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) lines.push(line);
        index = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        buffer = '';
        overflowed += 1;
      }
      return lines;
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      return rest ? [rest] : [];
    },
    get overflowCount() {
      return overflowed;
    },
  };
}
