import { describe, expect, it } from 'vitest';
import { createPulseCameraHold } from '../public/modules/pulse-cameras.mjs';

const live = {
  mode: 'real',
  reachable: true,
  vision: {
    cameras: {
      cam0: { id: 'cam0', state: 'streaming', fps: 60 },
      cam1: { id: 'cam1', state: 'streaming', fps: 30 },
    },
  },
};

describe('pulse camera slots stay fixed', () => {
  it('does not collapse or flip to לא ידוע on one timeout', () => {
    let now = 0;
    const board = createPulseCameraHold({ now: () => now, fails: 3, failMs: 10000 });
    const first = board.step(live, now);
    expect(first.cards.map((card) => card.id)).toEqual(['cam0', 'cam1', 'cam3']);
    expect(first.cards[0].pill).toBe('משדר');
    now = 1000;
    const gap = board.step({ mode: 'real', reachable: false }, now);
    expect(gap.cards.map((card) => card.id)).toEqual(['cam0', 'cam1', 'cam3']);
    expect(gap.cards[0].pill).not.toBe('לא ידוע');
    expect(gap.cards[0].held).toBe(true);
    expect(gap.cards[0].ageLabel).toContain('לפני');
    now = 2000;
    const back = board.step(live, now);
    expect(back.cards.map((card) => card.id)).toEqual(first.cards.map((card) => card.id));
    expect(back.cards[0].pill).toBe('משדר');
    expect(back.cards[0].held).toBe(false);
  });

  it('holds a streaming flip until three polls, then shows לא מגיב only after a sustained miss', () => {
    let now = 0;
    const board = createPulseCameraHold({ now: () => now, fails: 3, failMs: 10000 });
    board.step(live, now);
    now = 500;
    const flipped = {
      ...live,
      vision: { cameras: { cam0: { id: 'cam0', state: 'idle', camera_ok: false }, cam1: { id: 'cam1', state: 'streaming', fps: 30 } } },
    };
    const once = board.step(flipped, now);
    expect(once.cards[0].pill).toBe('משדר');
    expect(once.cards[0].held).toBe(true);
    expect(once.cards[0].ageLabel).toContain('לפני');
    now = 1000;
    board.step(flipped, now);
    now = 1500;
    const committed = board.step(flipped, now);
    expect(committed.cards[0].pill).toBe('לא משדר');
    expect(committed.cards.map((card) => card.id)).toEqual(['cam0', 'cam1', 'cam3']);
    expect(committed.cards.some((card) => card.name === 'cam2' || card.id === 'cam2')).toBe(false);
    now = 2000;
    const quiet = board.step({ mode: 'real', reachable: false }, now);
    expect(quiet.cards[0].pill).not.toBe('לא מגיב');
    now = 12000;
    const down = board.step({ mode: 'real', reachable: false }, now);
    expect(down.cards[0].pill).toBe('לא מגיב');
  });
});
