import { describe, it, expect } from 'vitest';
import { campParts, timelapseView } from '../src/camp';
import { NIGHT_TINT } from '../src/cues';

describe('making camp (PR #74 review)', () => {
  it('builds up part by part while C is held, and the fire catches when camp is made', () => {
    expect(campParts(0)).toEqual([]);
    expect(campParts(0.15)).toEqual(['bedroll']);
    expect(campParts(0.5)).toEqual(['bedroll', 'stones']);
    expect(campParts(0.99)).toEqual(['bedroll', 'stones', 'firewood', 'tent']);
    expect(campParts(1)).toEqual(['bedroll', 'stones', 'firewood', 'tent', 'fire']);
  });

  it('the time-lapse runs dusk to nightfall, through the night, to the next dawn', () => {
    const at = (u: number) => timelapseView(15 * 60, 6, 20, u);
    expect(at(0)).toMatchObject({ phase: 'dusk', time: '3:00 PM', tint: 0 });
    expect(at(0.3)).toMatchObject({ phase: 'night', time: '8:00 PM', tint: NIGHT_TINT });
    expect(at(0.525)).toMatchObject({ phase: 'night', time: '1:00 AM' });
    expect(at(1)).toMatchObject({ phase: 'day', time: '6:00 AM', tint: 0 });
  });
});
