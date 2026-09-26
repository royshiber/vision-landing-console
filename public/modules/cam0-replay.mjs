/** Pick the Cam0 sidecar row nearest a flight-timeline second. */

export function pickFrame(frames, tRelS) {
  if (!Array.isArray(frames) || !frames.length || tRelS == null || tRelS === '') return null;
  const target = Number(tRelS);
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestD = Infinity;
  for (const row of frames) {
    const rel = Number(row?.t_rel_s);
    if (!Number.isFinite(rel)) continue;
    const d = Math.abs(rel - target);
    if (d < bestD) {
      best = row;
      bestD = d;
    }
  }
  return best;
}

export function recordingFrameUrl(flightId, index) {
  return `/api/jetson/v1/cam0/recordings/${encodeURIComponent(flightId)}/frame.jpg?i=${encodeURIComponent(index)}`;
}
