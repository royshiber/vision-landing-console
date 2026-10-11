/**
 * A single missed JPEG must not flash אין אות while a recent frame still exists.
 * The companion may answer the first cam1 request with 404 no_frame.
 */

export const FRAME_MISS_HOLD_MS = 4000;

export function frameMissShowsNoSignal({
  seenAt = 0,
  now = 0,
  streaming = false,
  consecutiveMisses = 1,
} = {}) {
  const seen = Number(seenAt);
  const stamp = Number(now);
  const misses = Number(consecutiveMisses);
  const recent = Number.isFinite(seen) && seen > 0 && Number.isFinite(stamp) && stamp - seen <= FRAME_MISS_HOLD_MS;
  if (misses <= 1 && (recent || streaming === true)) return false;
  return true;
}

/**
 * A live tile must show the last picture or אין אות.
 * A second miss must not leave both hidden.
 * One miss with a recent frame keeps the picture and hides the warning.
 */
export function frameTilePresentation({
  seenAt = 0,
  now = 0,
  streaming = false,
  consecutiveMisses = 0,
  hasPicture = false,
} = {}) {
  const misses = Number(consecutiveMisses);
  const picture = hasPicture === true;
  const showNone = misses > 0 && frameMissShowsNoSignal({
    seenAt,
    now,
    streaming,
    consecutiveMisses: misses,
  });
  if (picture && !showNone) return { showImage: true, showNote: false };
  if (showNone && !picture) return { showImage: false, showNote: true };
  if (picture) return { showImage: true, showNote: false };
  return { showImage: false, showNote: true };
}
