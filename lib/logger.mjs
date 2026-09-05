import pino from 'pino';

/** Why: single shared logger so all modules emit consistent structured JSON.
 *  PM2 captures stdout/stderr to rotating log files automatically.
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
      'COMPANION_SHARED_SECRET',
      '*.COMPANION_SHARED_SECRET',
    ],
    censor: '[REDACTED]',
  },
});
