import pino from 'pino';
import { Writable } from 'node:stream';
import { createRotatingLogStream } from './console-log.mjs';

/**
 * Append the log line even when stdout never calls back.
 * A minimized Windows console can stall process.stdout.write's callback,
 * which previously left console-*.log at 0 bytes and backpressured pino.
 */
export function createConsoleLogDestination(stdout, file) {
  const out = stdout || process.stdout;
  if (!file) return out;
  return new Writable({
    write(chunk, encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
      try {
        out.write(buf);
      } catch {
        /* stdout must not gate the file */
      }
      file.write(buf, callback);
    },
  });
}

function consoleLogDestination() {
  let file = null;
  try {
    file = createRotatingLogStream();
  } catch {
    file = null;
  }
  return createConsoleLogDestination(process.stdout, file);
}

/** Why: single shared logger so all modules emit consistent structured JSON.
 *  The same lines are appended to rotating logs/console-*.log files.
 *  Set LOG_LEVEL env var to override (trace|debug|info|warn|error|fatal).
 *  Connection keys must never appear in JSON logs. */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'CURSOR_API_KEY',
      '*.CURSOR_API_KEY',
      'apiKey',
      '*.apiKey',
      'connection_key',
      '*.connection_key',
      'req.body.key',
      'req.body.apiKey',
      'req.body.connection_key',
      'token',
      '*.token',
      'req.body.token',
      'req.body.companion_token',
      'JETSON_COMPANION_TOKEN',
      '*.JETSON_COMPANION_TOKEN',
      'VLC_COMPANION_TOKEN',
      '*.VLC_COMPANION_TOKEN',
      'COMPANION_SHARED_SECRET',
      '*.COMPANION_SHARED_SECRET',
    ],
    censor: '[REDACTED]',
  },
}, consoleLogDestination());
