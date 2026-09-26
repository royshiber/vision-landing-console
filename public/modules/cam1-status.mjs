/** Display rules for CAM1. Measured stream rate is not a capture target. */

export const DRILL = 'תרגיל. לא מצלמה אמיתית.';
export const LIVE = 'פריים חי';
export const NO_SIGNAL = 'אין אות';
export const STREAM_ERR = 'השידור נכשל. ננסה שוב.';
export const IDLE = 'מחוברת, ממתינה';

export function honestyText(body, streamError) {
  if (streamError || body?.state === 'error') return STREAM_ERR;
  const has = body?.camera_ok === true && body?.has_frame === true;
  if (!has) return NO_SIGNAL;
  return body.real === true ? LIVE : DRILL;
}

export function statusPhrase(body, streamError) {
  if (streamError || body?.state === 'error') return 'CAM1 · שגיאה · קצב —';
  if (!body) return 'CAM1 · לא מחובר · קצב —';
  if (body.camera_ok === true) {
    const rate = body.fps == null || body.fps === '' ? '—' : String(body.fps);
    return `CAM1 · מחובר · קצב ${rate}`;
  }
  if (body.state === 'idle') return `CAM1 · ${IDLE} · קצב —`;
  return 'CAM1 · לא מחובר · קצב —';
}

/** Capture fps from settings. Never the JPEG stream rate or the measured fps. */
export function targetFpsValue(body) {
  if (body == null || body.capture_fps == null || body.capture_fps === '') return null;
  return String(body.capture_fps);
}

/** A gain edit must not send a capture fps taken from the stream. */
export function settingsPayload(form) {
  const body = {
    ae: { enabled: form.ae === true },
    exposure_us: form.exposure === '' || form.exposure == null ? undefined : Number(form.exposure),
    gain: form.gain === '' || form.gain == null ? undefined : Number(form.gain),
    width: form.width,
    height: form.height,
    manual: form.ae !== true,
    stream: { fps: 15 },
  };
  if (form.fpsTouched && form.fps !== '' && form.fps != null) body.fps = Number(form.fps);
  return body;
}

export function nextStreamDelayMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(8000, 400 * (2 ** n));
}
