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
    expect(first.cards.map((card) => card.id)).toEqual(['cam0', 'cam1', 'cam2', 'cam3']);
    expect(first.cards[0].pill).toBe('משדר');
    now = 1000;
    const gap = board.step({ mode: 'real', reachable: false }, now);
    expect(gap.cards.map((card) => card.id)).toEqual(['cam0', 'cam1', 'cam2', 'cam3']);
    expect(gap.cards[0].pill).not.toBe('לא ידוע');
    expect(gap.cards[0].held).toBe(true);
    expect(gap.cards[0].ageLabel).toContain('לפני');
    now = 2000;
    const back = board.step(live, now);
    expect(back.cards.map((card) => card.id)).toEqual(first.cards.map((card) => card.id));
    expect(back.cards[0].pill).toBe('משדר');
    expect(back.cards[0].held).toBe(false);
  });
});
