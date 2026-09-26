/**
 * Min/max-preserving decimation. Each bucket keeps its lowest and highest
 * samples (in time order) so a spike is not averaged away.
 * @param {number[]} t
 * @param {number[]} v
 * @param {number} maxPoints
 */
export function decimateMinMax(t, v, maxPoints) {
  const n = Math.min(t?.length || 0, v?.length || 0);
  const cap = Math.max(2, Number(maxPoints) || 2);
  if (n <= cap) {
    return {
      t: (t || []).slice(0, n),
      v: (v || []).slice(0, n),
    };
  }
  const buckets = Math.max(1, Math.floor(cap / 2));
  const outT = [];
  const outV = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);
    let minI = start;
    let maxI = start;
    for (let i = start; i < end; i++) {
      const val = Number(v[i]);
      if (!Number.isFinite(val)) continue;
      if (!Number.isFinite(Number(v[minI])) || val < Number(v[minI])) minI = i;
      if (!Number.isFinite(Number(v[maxI])) || val > Number(v[maxI])) maxI = i;
    }
    const order = minI <= maxI ? [minI, maxI] : [maxI, minI];
    for (const i of order) {
      if (outT.length && outT[outT.length - 1] === t[i]) continue;
      outT.push(t[i]);
      outV.push(v[i]);
    }
  }
  return { t: outT, v: outV };
}
