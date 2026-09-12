/**
 * Why: Parameters WRITE must call live MAVLink setParam when connected,
 *      and must not invent FC values or pretend a RAM copy is a write.
 *      WRITE sends only operator-dirty keys — never the full target template.
 */

const MATCH_EPS = 1e-3;
export const WRITE_BULK_CAP = 40;

export function valuesDiffer(a, b) {
  if (a == null || b == null) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return true;
  return Math.abs(na - nb) > MATCH_EPS;
}

/** Why: empty `{}` WRITE must not fall back to the full template. What: body.params only. */
export function resolveRequestedWriteParams(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body.params : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

/**
 * Operator-dirty keys only. Never pass the full target template.
 * When a live dictionary exists, skip requested values that already match.
 * When the live dictionary is empty, send every requested key — do not invent FC current values.
 * Empty requested → [].
 */
export function selectChangedEditableParams(requestedParams, liveParams) {
  const requested = requestedParams && typeof requestedParams === 'object' && !Array.isArray(requestedParams)
    ? requestedParams
    : null;
  if (!requested || Object.keys(requested).length === 0) return [];
  const live = liveParams && typeof liveParams === 'object' && !Array.isArray(liveParams)
    ? liveParams
    : null;
  const liveCount = live ? Object.keys(live).length : 0;
  const out = [];
  for (const [key, raw] of Object.entries(requested)) {
    const value = Number(raw);
    if (!key || !Number.isFinite(value)) continue;
    if (
      liveCount > 0
      && Object.prototype.hasOwnProperty.call(live, key)
      && !valuesDiffer(live[key], value)
    ) {
      continue;
    }
    out.push({ param: key, value });
  }
  return out;
}

/** Why: a stale or full-template body must not blast SERIAL/SR. What: abort over cap unless confirmBulk. */
export function rejectIfOverBulkCap(items, confirmBulk) {
  if (!Array.isArray(items) || items.length <= WRITE_BULK_CAP) return null;
  if (confirmBulk === true) return null;
  return {
    ok: false,
    code: 'bulk_cap',
    count: items.length,
    cap: WRITE_BULK_CAP,
    message: 'WRITE חסום — יותר מדי פרמטרים בבת אחת',
  };
}

export async function writeEditableParamsViaMavlink(mavConn, items, { timeoutMs = 4000 } = {}) {
  const written = [];
  const failed = [];
  const verified = {};
  for (const item of items || []) {
    try {
      const result = await mavConn.setParam(item.param, item.value, { timeoutMs, retries: 1 });
      if (result?.ok) {
        written.push(item.param);
        if (Number.isFinite(Number(result.value))) verified[item.param] = Number(result.value);
      } else {
        failed.push({ param: item.param, error: result?.error || 'fc_rejected' });
      }
    } catch (err) {
      failed.push({ param: item.param, error: err?.message || 'setParam failed' });
    }
  }
  return { written, failed, verified };
}
