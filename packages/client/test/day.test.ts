import { describe, it, expect } from 'vitest';
import { clockFace, DUSK_TINT, NIGHT_TINT, sunView } from '../src/cues';

describe('sun bar (G8 day clock)', () => {
  it('counts down to dusk by day, to nightfall at dusk, and the grace to make camp at night', () => {
    expect(sunView({ phase: 'day', toNightfallSec: 600, graceLeftSec: null, daylight: 120 / 720, minutes: 6 * 60 + 140 }, 120, false)).toEqual({ phase: 'day', share: 600 / 720, text: '8:00 to dusk', tint: 0, time: '8:20 AM' });
    expect(sunView({ phase: 'dusk', toNightfallSec: 60, graceLeftSec: null, daylight: 660 / 720, minutes: 19 * 60 }, 120, false)).toMatchObject({ phase: 'dusk', text: 'dusk 1:00', tint: DUSK_TINT / 2 });
    expect(sunView({ phase: 'night', toNightfallSec: 0, graceLeftSec: 42.2, daylight: 1, minutes: 20 * 60 + 23 }, 120, false)).toEqual({ phase: 'night', share: 0, text: 'make camp 0:43', tint: NIGHT_TINT, time: '8:25 PM' });
    expect(sunView({ phase: 'night', toNightfallSec: 0, graceLeftSec: 60, daylight: 1, minutes: 20 * 60 }, 120, true).text).toBe('night: finish up');
  });

  it('reads the time of day to the nearest 5 minutes', () => {
    expect(clockFace(6 * 60)).toBe('6:00 AM');
    expect(clockFace(12 * 60 + 2)).toBe('12:00 PM');
    expect(clockFace(16 * 60 + 13)).toBe('4:15 PM');
    expect(clockFace(23 * 60 + 58)).toBe('12:00 AM');
  });
});
