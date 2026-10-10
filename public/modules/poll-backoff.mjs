/** Failed companion and vision polls wait 1s, then double, and stop at 30s. */

export const POLL_FAIL_MIN_MS = 1000;
export const POLL_FAIL_MAX_MS = 30000;

export function nextFailPollMs(current) {
  const prev = Number(current);
  const grown = Number.isFinite(prev) && prev >= POLL_FAIL_MIN_MS ? prev * 2 : POLL_FAIL_MIN_MS;
  return Math.min(POLL_FAIL_MAX_MS, grown);
}
