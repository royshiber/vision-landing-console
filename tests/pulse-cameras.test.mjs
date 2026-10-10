import { describe, expect, it } from 'vitest';
import { mapCompanionStatus } from '../lib/companion-status.mjs';
import { companionMappedToSseOverlay } from '../lib/companion-events-bridge.mjs';
import { healthyCompanionStatus } from '../lib/companion-mock-fixtures.mjs';
import {
  formatPulseCameraAge,
  formatPulseCameraFps,
  pulseCameraCards,
} from '../public/modules/pulse-cameras.mjs';

function liveStatus(cameras, extrasCameras) {
  return {
    mode: 'real',
    reachable: true,
    vision: { cameras },
    extras: extrasCameras ? { cameras: extrasCameras } : null,
  };
}

describe('pulse camera cards', () => {
  it('says the mission computer is quiet in the same words as the other tiles', () => {
    expect(pulseCameraCards(null)).toEqual({ live: false, pill: 'מנותק', cards: [] });
    expect(pulseCameraCards({ mode: 'off', reachable: false }).pill).toBe('מנותק');
    expect(pulseCameraCards({ mode: 'real', reachable: false, vision: { cameras: { cam1: { fps: 30 } } } })).toEqual({
      live: false,
      pill: 'לא מגיב',
      cards: [],
    });
  });

  it('says there is no camera report instead of inventing slots', () => {
    expect(pulseCameraCards({ mode: 'mock', reachable: true })).toEqual({
      live: true,
      pill: 'אין נתון',
      cards: [],
    });
  });

  it('includes the gimbal and omits fields the payload does not carry', () => {
    const model = pulseCameraCards(liveStatus({
      cam1: { id: 'cam1', role: 'forward', state: 'streaming', fps: 28, last_frame_age_ms: 40 },
      cam3: { id: 'cam3', role: 'gimbal', state: 'disabled', camera_ok: false, error: 'disabled' },
    }));
    expect(model.cards.map((card) => card.id)).toEqual(['cam1', 'cam3']);
    expect(model.cards[0]).toMatchObject({
      name: 'מטה',
      streaming: true,
      fps: 28,
      ageMs: 40,
      error: null,
      tone: 'ok',
    });
    expect(model.cards[1]).toMatchObject({
      name: 'גימבל',
      streaming: false,
      fps: null,
      ageMs: null,
      error: 'כבוי',
      tone: 'bad',
    });
    expect(formatPulseCameraFps(28)).toBe('28');
    expect(formatPulseCameraAge(40)).toBe('40 ms');
    expect(formatPulseCameraAge(1500)).toBe('1.5 s');
  });

  it('keeps a gimbal that arrives only on the extras camera map', () => {
    const model = pulseCameraCards(liveStatus(
      { cam0: { id: 'cam0', role: 'down', state: 'streaming', fps: 20, last_frame_age_ms: 0 } },
      { cam3: { id: 'cam3', role: 'gimbal_observe', state: 'read_failed', error: 'read_failed', last_frame_age_ms: 900 } },
    ));
    expect(model.cards.map((card) => [card.id, card.name, card.streaming, card.error, card.ageMs])).toEqual([
      ['cam0', 'קדמית', true, null, 0],
      ['cam3', 'גימבל', false, 'קריאה נכשלה', 900],
    ]);
  });

  it('does not treat a null age as zero', () => {
    const model = pulseCameraCards(liveStatus({
      cam1: { id: 'cam1', role: 'down', camera_ok: true, fps: null, last_frame_age_ms: null },
    }));
    expect(model.cards[0]).toMatchObject({ name: 'מטה', streaming: true, fps: null, ageMs: null, error: null });
  });

  it('shows the gimbal from the companion status the console already maps', () => {
    const raw = {
      timestamp: { t_monotonic_ns: 1, t_utc_ns: 1 },
      vision: {
        health: 'valid',
        running: true,
        camera_ok: true,
        cameras: {
          cam1: { id: 'cam1', role: 'forward', state: 'streaming', camera_ok: true, fps: 24, last_frame_age_ms: 33 },
          cam3: { id: 'cam3', role: 'gimbal', state: 'absent', camera_ok: false, fps: null, last_frame_age_ms: null, error: 'device_absent' },
        },
      },
      extras: {
        cameras: {
          cam3: { id: 'cam3', role: 'gimbal', state: 'absent', error: 'device_absent' },
        },
      },
    };
    const overlay = companionMappedToSseOverlay(mapCompanionStatus(raw), { mode: 'real', reachable: true });
    const model = pulseCameraCards(overlay.companion);
    const gimbal = model.cards.find((card) => card.id === 'cam3');
    expect(gimbal).toMatchObject({ name: 'גימבל', streaming: false, fps: null, ageMs: null, error: 'אין התקן' });
    expect(model.cards.find((card) => card.id === 'cam1')).toMatchObject({ streaming: true, fps: 24, ageMs: 33 });

    const down = companionMappedToSseOverlay(mapCompanionStatus(raw), { mode: 'real', reachable: false });
    expect(pulseCameraCards(down.companion).pill).toBe('לא מגיב');
    expect(pulseCameraCards(down.companion).cards).toEqual([]);
  });

  it('keeps the gimbal slot on the mapped optical-nav cameras', () => {
    const mapped = mapCompanionStatus(healthyCompanionStatus());
    const overlay = companionMappedToSseOverlay(mapped, { mode: 'mock', reachable: true });
    const model = pulseCameraCards({ ...overlay.companion, mode: 'mock', reachable: true });
    expect(model.cards.map((card) => card.id)).toContain('cam3');
    expect(model.cards.find((card) => card.id === 'cam3').name).toBe('גימבל');
    expect(model.cards.find((card) => card.id === 'cam3').fps).toBeNull();
  });
});
