/**
 * Why: Parameters WRITE must call live MAVLink setParam when connected,
 *      and must not invent FC values or pretend a RAM copy is a write.
 */

const MATCH_EPS = 1e-3;

export function valuesDiffer(a, b) {
  if (a == null || b == null) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return true;
  return Math.abs(na - nb) > MATCH_EPS;
}

/**
 * Editable target keys to send. When a live dictionary exists, skip values
 * that already match. When the live dictionary is empty, send every accepted
 * target — do not invent FC current values.
 */
export function selectChangedEditableParams(targetAccepted, liveParams) {
  const live = liveParams && typeof liveParams === 'object' && !Array.isArray(liveParams)
    ? liveParams
    : null;
  const liveCount = live ? Object.keys(live).length : 0;
  const out = [];
  for (const [key, raw] of Object.entries(targetAccepted || {})) {
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
