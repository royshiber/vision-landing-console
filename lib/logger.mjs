import pino from 'pino';

/** Why: single shared logger so all modules emit consistent structured JSON.
 *  PM2 captures stdout/stderr to rotating log files automatically.
 *  Set LOG_LEVEL env var to override (trace|debug|info|warn|error|fatal). */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});
