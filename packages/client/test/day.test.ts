import { describe, it, expect } from 'vitest';
import { DUSK_TINT, NIGHT_TINT, sunView } from '../src/cues';

describe('sun bar (G8 day clock)', () => {
  it('counts down to dusk by day, to nightfall at dusk, and the grace to make camp at night', () => {
    expect(sunView({ phase: 'day', toNightfallSec: 600, graceLeftSec: null, daylight: 120 / 720 }, 120, false)).toEqual({ phase: 'day', share: 600 / 720, text: '8:00 to dusk', tint: 0 });
    expect(sunView({ phase: 'dusk', toNightfallSec: 60, graceLeftSec: null, daylight: 660 / 720 }, 120, false)).toMatchObject({ phase: 'dusk', text: 'dusk 1:00', tint: DUSK_TINT / 2 });
    expect(sunView({ phase: 'night', toNightfallSec: 0, graceLeftSec: 42.2, daylight: 1 }, 120, false)).toEqual({ phase: 'night', share: 0, text: 'make camp 0:43', tint: NIGHT_TINT });
    expect(sunView({ phase: 'night', toNightfallSec: 0, graceLeftSec: 60, daylight: 1 }, 120, true).text).toBe('night: finish up');
  });
});
