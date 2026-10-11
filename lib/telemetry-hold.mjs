/**
 * Last-good telemetry. A blank sample does not clear a value.
 * Live, then dimmed with an age, then לא מגיב with the last value.
 */

const BLANK = new Set(['', '—', '-', '–', '--', 'אין נתון', 'לא ידוע', 'אין נתונים']);

export function telemetryValueBlank(value) {
  if (value == null) return true;
  const text = String(value).trim();
  return BLANK.has(text);
}

export function createTelemetryHold({
  now = () => Date.now(),
  ttlMs = 3000,
  dimExtraMs = 5000,
} = {}) {
  const slots = new Map();
  function read(key, slotOpts) {
    const row = slots.get(key);
    if (!row) return { phase: 'dash', text: '—', value: null, dim: false, ageMs: null };
    const age = Math.max(0, now() - row.at);
    const ttl = slotOpts?.ttlMs ?? row.ttl ?? ttlMs;
    const extra = slotOpts?.dimExtraMs ?? dimExtraMs;
    if (age <= ttl) {
      return { phase: 'live', text: row.value, value: row.value, dim: false, ageMs: age };
    }
    const sec = Math.max(1, Math.round(age / 1000));
    if (age <= Math.max(ttl + extra, 10000)) {
      return {
        phase: 'aged',
        text: `${row.value} · לפני ${sec} שנ׳`,
        value: row.value,
        dim: true,
        ageMs: age,
      };
    }
    return {
      phase: 'stale',
      text: `${row.value} · לא מגיב · לפני ${sec} שנ׳`,
      value: row.value,
      dim: true,
      ageMs: age,
    };
  }
  return {
    offer(key, value, slotOpts) {
      if (!telemetryValueBlank(value)) {
        slots.set(key, {
          value: String(value),
          at: now(),
          ttl: slotOpts?.ttlMs ?? ttlMs,
        });
      }
      return read(key, slotOpts);
    },
    read,
    clear(key) {
      slots.delete(key);
    },
  };
}

export function createMedianWindow(size = 5) {
  const bins = new Map();
  const cap = Math.max(1, size);
  return {
    push(key, value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      const arr = bins.get(key) || [];
      arr.push(n);
      while (arr.length > cap) arr.shift();
      bins.set(key, arr);
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return median;
    },
  };
}

const FAULT_RE = /שגיאה|לא מגיב|מנותק|אין חיבור/;

export function createStatusDebounce({
  now = () => Date.now(),
  fails = 3,
  failMs = 10000,
  faultRe = FAULT_RE,
} = {}) {
  let good = '';
  let at = 0;
  let haveGood = false;
  let streak = 0;
  return {
    push(text, stamp = now()) {
      const raw = String(text || '').trim();
      const fault = !raw || faultRe.test(raw) || telemetryValueBlank(raw);
      if (!fault) {
        good = raw;
        at = stamp;
        haveGood = true;
        streak = 0;
        return { phase: 'live', text: raw };
      }
      streak += 1;
      const age = haveGood ? stamp - at : failMs;
      if (haveGood && streak < fails && age < failMs) {
        return { phase: 'aged', text: good };
      }
      return { phase: 'dash', text: raw || '—' };
    },
  };
}
