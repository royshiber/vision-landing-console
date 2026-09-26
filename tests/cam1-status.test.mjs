import { describe, expect, it } from 'vitest';
import {
  DRILL,
  STREAM_ERR,
  honestyText,
  nextStreamDelayMs,
  settingsPayload,
  statusPhrase,
  targetFpsValue,
} from '../public/modules/cam1-status.mjs';

const liveDrill = { camera_ok: true, has_frame: true, real: false, fps: 30, capture_fps: 30, stream: { fps: 15 } };

describe('CAM1 display rules', () => {
  it('shows a drill when the frame is not a real camera', () => {
    expect(honestyText(liveDrill, false)).toBe(DRILL);
    expect(honestyText(liveDrill, false)).toBe('תרגיל. לא מצלמה אמיתית.');
    expect(honestyText({ ...liveDrill, real: true }, false)).toBe('פריים חי');
  });

  it('shows an error and retries with backoff instead of a live rate', () => {
    expect(honestyText({ ...liveDrill, real: true }, true)).toBe(STREAM_ERR);
    expect(honestyText({ ...liveDrill, state: 'error' }, false)).toBe('השידור נכשל. ננסה שוב.');
    expect(statusPhrase({ ...liveDrill, real: true }, true)).toBe('CAM1 · שגיאה · קצב —');
    expect(statusPhrase({ ...liveDrill, state: 'error' }, false)).not.toContain('30');
    expect(nextStreamDelayMs(0)).toBe(400);
    expect(nextStreamDelayMs(1)).toBe(800);
    expect(nextStreamDelayMs(2)).toBe(1600);
    expect(nextStreamDelayMs(20)).toBe(8000);
  });

  it('keeps capture fps when only gain changes', () => {
    expect(targetFpsValue({ capture_fps: 30, fps: 12, stream: { fps: 15 } })).toBe('30');
    expect(targetFpsValue({ fps: 12, stream: { fps: 15 } })).toBeNull();
    const gainOnly = settingsPayload({ gain: 40, fps: '15', fpsTouched: false, ae: false, exposure: '', width: 1280, height: 800 });
    expect(gainOnly.gain).toBe(40);
    expect(gainOnly.fps).toBeUndefined();
    expect(gainOnly.stream).toEqual({ fps: 15 });
    const edited = settingsPayload({ gain: 40, fps: '20', fpsTouched: true, ae: false, exposure: '', width: 1280, height: 800 });
    expect(edited.fps).toBe(20);
  });

  it('shows a present idle camera as waiting', () => {
    expect(statusPhrase({ state: 'idle', camera_ok: false }, false)).toBe('CAM1 · מחוברת, ממתינה · קצב —');
    expect(statusPhrase(null, false)).toBe('CAM1 · לא מחובר · קצב —');
  });
});
