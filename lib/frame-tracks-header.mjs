/**
 * Tracks travel with the JPEG. The header is base64 of a compact JSON object.
 * Hebrew stays inside the JSON so the header itself is ASCII.
 */

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value) {
  return Buffer.from(value, 'base64');
}

export function encodeTracksHeader(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const compact = {
    ok: payload.ok === true,
    enabled: payload.enabled === true,
    camera: payload.camera || '',
    selected_camera: payload.selected_camera ?? null,
    stream: payload.stream === true,
    frame_seq: payload.frame_seq ?? null,
    captured_at: payload.captured_at ?? null,
    frame_width: payload.frame_width ?? null,
    frame_height: payload.frame_height ?? null,
    tracks: Array.isArray(payload.tracks) ? payload.tracks : [],
    lock: payload.lock && typeof payload.lock === 'object' ? payload.lock : null,
    reason_he: payload.reason_he || '',
    gimbal_steer: payload.gimbal_steer && typeof payload.gimbal_steer === 'object' ? payload.gimbal_steer : {},
    flight_commands: false,
  };
  const json = JSON.stringify(compact);
  if (json.length > 6000) return '';
  return bytesToBase64(Buffer.from(json, 'utf8'));
}

export function decodeTracksHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const json = base64ToBytes(raw).toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
