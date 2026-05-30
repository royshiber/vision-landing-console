/**
 * Per-request correlation ID for structured logs (Express + MAVLink side-effects).
 * MAVLink frames have no request-id field — tie PARAM_SET etc. to HTTP via logs only.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** @returns {{ correlationId: string } | undefined} */
export function getRequestStore() {
  return store.getStore();
}

/** @returns {string | null} */
export function getCorrelationId() {
  const s = store.getStore();
  return s?.correlationId ?? null;
}

/**
 * Attach `req.correlationId`, mirror as `X-Request-Id`, and bind ALS for downstream sync code.
 */
export function correlationMiddleware(req, res, next) {
  const incoming = req.get('x-request-id');
  const correlationId = typeof incoming === 'string' && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Request-Id', correlationId);
  store.run({ correlationId }, () => next());
}
