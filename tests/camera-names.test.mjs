import { describe, expect, it } from 'vitest';
import { CAMERA_NAME_HE, cameraDisplayName } from '../public/modules/camera-names.mjs';
import { pulseCameraCards } from '../public/modules/pulse-cameras.mjs';

describe('camera display names', () => {
  it('uses the optics names even when the companion role disagrees', () => {
    expect(cameraDisplayName('cam0')).toBe('קדמית');
    expect(cameraDisplayName('cam1')).toBe('מטה');
    expect(cameraDisplayName('cam3')).toBe('גימבל');
    expect(cameraDisplayName('a8')).toBe('גימבל');
    expect(cameraDisplayName('cam2')).toBe('');
    expect(CAMERA_NAME_HE.cam0).toBe('קדמית');

    const model = pulseCameraCards({
      mode: 'real',
      reachable: true,
      vision: {
        cameras: {
          cam0: { id: 'cam0', role: 'down', state: 'streaming', fps: 20, last_frame_age_ms: 10 },
          cam1: { id: 'cam1', role: 'forward', state: 'idle', camera_ok: false },
          cam2: { id: 'cam2', role: 'down', state: 'streaming', fps: 5, last_frame_age_ms: 20 },
          cam3: { id: 'cam3', role: 'ceiling', state: 'streaming', fps: 15, last_frame_age_ms: 30 },
        },
      },
    });
    const byId = Object.fromEntries(model.cards.map((card) => [card.id, card.name]));
    expect(byId.cam0).toBe('קדמית');
    expect(byId.cam1).toBe('מטה');
    expect(byId.cam2).toBe('cam2');
    expect(byId.cam3).toBe('גימבל');
    expect(byId.cam3).not.toBe('תקרה');
  });
});
