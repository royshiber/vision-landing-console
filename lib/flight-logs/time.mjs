/** Asia/Jerusalem clock and T+mm:ss relative to arm. Shared by the API and tests. */

export function formatJerusalem(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${date} ${time}`;
}

/** @param {number} relSeconds seconds relative to arm. Minutes may exceed 59. */
export function formatTPlus(relSeconds) {
  const n = Number(relSeconds);
  if (!Number.isFinite(n)) return 'T+00:00';
  const sign = n < 0 ? '-' : '+';
  const abs = Math.floor(Math.abs(n));
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  return `T${sign}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
