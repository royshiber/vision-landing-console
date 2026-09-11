/**
 * Why: Jetson/RPi/vision can POST over LAN; when COMPANION_SHARED_SECRET is set, only callers with the token may push.
 * What: if secret unset, no-op (dev/lab). Header X-Companion-Token or Authorization: Bearer.
 */

import { logger } from './logger.mjs';
import { normalizeCompanionSecret } from './companion-secret.mjs';

const HEADER = 'x-companion-token';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireCompanionToken(req, res, next) {
  const secret = normalizeCompanionSecret(process.env.COMPANION_SHARED_SECRET)
    || normalizeCompanionSecret(process.env.VLC_COMPANION_TOKEN)
    || normalizeCompanionSecret(process.env.JETSON_COMPANION_TOKEN);
  if (!secret) return next();
  const h = normalizeCompanionSecret(req.get(HEADER) || '');
  const auth = normalizeCompanionSecret((req.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
  const token = h || auth;
  if (token === secret) return next();
  logger.warn({ path: req.path, ip: req.ip }, 'companion token rejected or missing');
  return res.status(401).json({ ok: false, message: 'Unauthorized — set X-Companion-Token or use Authorization: Bearer' });
}
