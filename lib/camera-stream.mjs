/**
 * One streaming bit per camera. Camera status and vision state both read it.
 */

export const STREAM_CAMERA_IDS = Object.freeze(['cam0', 'cam1', 'cam3']);
export const UNKNOWN_STREAM_HE = 'אין נתון על זרם המצלמות';

function boolOrNull(value) {
  return value === true || value === false ? value : null;
}

/**
 * Copy the tracks stream onto the camera slot, and the slot onto the tracks,
 * so a status sentence and a detection sentence cannot disagree.
 */
export function applyCameraStreamTruth(context) {
  if (!context || typeof context !== 'object') return context;
  const ops = { ...(context.ops_signals && typeof context.ops_signals === 'object' ? context.ops_signals : {}) };
  const cameras = { ...(ops.cameras && typeof ops.cameras === 'object' ? ops.cameras : {}) };
  const vision = context.vision && typeof context.vision === 'object' ? { ...context.vision } : null;
  const streams = vision?.streams && typeof vision.streams === 'object' ? vision.streams : null;
  if (streams) {
    for (const id of STREAM_CAMERA_IDS) {
      const bit = boolOrNull(streams[id]);
      if (bit != null) cameras[id] = bit;
    }
  }
  const perCamera = vision?.cameras && typeof vision.cameras === 'object' ? vision.cameras : null;
  if (perCamera) {
    for (const id of STREAM_CAMERA_IDS) {
      const row = perCamera[id];
      if (!row || typeof row !== 'object' || row.reason_he === UNKNOWN_STREAM_HE) continue;
      if (cameras[id] != null) continue;
      const bit = boolOrNull(row.stream);
      if (bit != null) cameras[id] = bit;
    }
  }
  const selected = String(vision?.camera || '');
  const unknown = vision?.reason_he === UNKNOWN_STREAM_HE;
  if (vision && unknown) {
    if (vision.stream === false) delete vision.stream;
    if (STREAM_CAMERA_IDS.includes(selected)) delete cameras[selected];
  } else if (vision && STREAM_CAMERA_IDS.includes(selected)) {
    const fromTracks = streams ? boolOrNull(streams[selected]) : null;
    if (fromTracks != null) {
      cameras[selected] = fromTracks;
      vision.stream = fromTracks;
    } else if (boolOrNull(vision.stream) != null) {
      cameras[selected] = vision.stream;
    } else if (boolOrNull(cameras[selected]) != null) {
      vision.stream = cameras[selected];
    }
  }
  const present = {};
  for (const id of STREAM_CAMERA_IDS) {
    const bit = boolOrNull(cameras[id]);
    if (bit != null) present[id] = bit;
  }
  if (Object.keys(present).length) ops.cameras = present;
  else delete ops.cameras;
  return {
    ...context,
    ops_signals: Object.keys(ops).length ? ops : null,
    vision,
  };
}
