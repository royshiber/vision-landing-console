/**
 * Why: Jetson/RPi/vision can POST over LAN; when COMPANION_SHARED_SECRET is set, only callers with the token may push.
 * What: if secret unset, no-op (dev/lab). Header X-Companion-Token or Authorization: Bearer.
 */

import { logger } from './logger.mjs';

const HEADER = 'x-companion-token';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireCompanionToken(req, res, next) {
  const secret = (process.env.COMPANION_SHARED_SECRET || '').trim();
  if (!secret) return next();
  const h = (req.get(HEADER) || '').trim();
  const auth = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const token = h || auth;
  if (token === secret) return next();
  logger.warn({ path: req.path, ip: req.ip }, 'companion token rejected or missing');
  return res.status(401).json({ ok: false, message: 'Unauthorized — set X-Companion-Token or use Authorization: Bearer' });
}
