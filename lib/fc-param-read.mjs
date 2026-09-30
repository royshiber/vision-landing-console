/**
 * Fresh FC parameter list. Read only: PARAM_REQUEST_LIST in, PARAM_VALUE out.
 * A name that never arrives is absent. Callers must not invent a value for it.
 */

export function emptyParamList() {
  return { values: {}, expected: 0, complete: false };
}

/** Fold one PARAM_VALUE into a new list. Completes only when every announced name has arrived. */
export function noteParamListValue(bucket, pv) {
  const base = bucket && typeof bucket === 'object' ? bucket : emptyParamList();
  const name = String(pv?.name || '').replace(/\0/g, '').trim();
  if (!name) return { values: { ...base.values }, expected: base.expected || 0, complete: base.complete === true };
  const values = { ...base.values, [name]: pv.value };
  const count = Number(pv?.count);
  const expected = count > 0 ? count : (Number(base.expected) || 0);
  const complete = expected > 0 && Object.keys(values).length >= expected;
  return { values, expected, complete };
}

function valuesDiffer(a, b) {
  if (a == null || b == null) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return true;
  return Math.abs(na - nb) > 1e-3;
}

/**
 * What a params-form card shows after קריאה.
 * unread: no completed list yet.
 * live: the FC number. saved is the console target only when it differs.
 * missing: the name is not in this list. live stays null.
 */
export function fcFormReadout(snapshot, key, target) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { state: 'unread', live: null, saved: null };
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
    return { state: 'missing', live: null, saved: target ?? null };
  }
  const live = snapshot[key];
  const saved = target != null && valuesDiffer(live, target) ? target : null;
  return { state: 'live', live, saved };
}
