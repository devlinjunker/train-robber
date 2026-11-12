import { describe, expect, it } from 'vitest';
import { dayLabel, deathCause, mapTitle } from '../src/cues';
import { faceSvg, fullName, posterReward } from '../src/poster';

describe('life words', () => {
  it('the HUD day reads day N, out of the life\'s days, with the train of the day', () => {
    expect(dayLabel({ trainsPerDay: 0, days: 0 }, { day: 4, trainsToday: 0 })).toBe('day 4');
    expect(dayLabel({ trainsPerDay: 3, days: 3 }, { day: 2, trainsToday: 1 })).toBe('day 2/3 · train 2/3');
    expect(dayLabel({ trainsPerDay: 3, days: 0 }, { day: 1, trainsToday: 5 })).toBe('day 1 · train 3/3');
  });

  it('a fatal hit reads as a cause of death', () => {
    expect(deathCause({ cause: 'collision', against: 'train', kind: 'crash' })).toBe('crushed under a train');
    expect(deathCause({ cause: 'collision', against: 'obstacle', kind: 'crash' }, 'mesa')).toBe('rode into a mesa');
    expect(deathCause({ cause: 'thrownOff' })).toBe('thrown from a moving train by a guard');
    expect(mapTitle('alpha-flats')).toBe('Alpha Flats');
  });

  it('poster rewards round like a poster', () => {
    expect(posterReward(87)).toBe('$87');
    expect(posterReward(1234)).toBe('$1,250');
    expect(posterReward(456)).toBe('$460');
    expect(fullName({ name: 'Ada Kincaid', nickname: 'Dusty' })).toBe('“Dusty” Ada Kincaid');
    expect(faceSvg({ hat: 1, beard: 2, scar: 0, bandana: 1, brow: 0 })).toMatch(/^<svg/);
  });
});
