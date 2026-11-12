import { describe, expect, it } from 'vitest';
import { guardCount } from '@train-robber/sim';
import { setupFromUrl } from '../src/setup';

describe('setup from the URL', () => {
  it('runs all mail trains on alpha-flats, about half blank elsewhere (the line by default)', () => {
    expect(setupFromUrl('?seed=a').config.variants.trainMix).toBe('mixed');
    expect(setupFromUrl('?seed=a&map=alpha-flats').config.variants.trainMix).toBe('all-mail');
    expect(setupFromUrl('?seed=a&map=tight-loop').config.variants.trainMix).toBe('mixed');
  });
  it('keeps a preset\'s own trainMix and the URL\'s ?v= on alpha-flats', () => {
    expect(setupFromUrl('?seed=a&map=alpha-flats&preset=map-trains').config.variants.trainMix).toBe('map');
    expect(setupFromUrl('?seed=a&map=alpha-flats&v=trainMix:mixed').config.variants.trainMix).toBe('mixed');
  });
  it('defaults trains to 6 cars', () => {
    const { trains } = setupFromUrl('?seed=a').config.values;
    expect(trains['mail-express']!.carCount).toBe(6);
    expect(trains.blank!.carCount).toBe(6);
  });
});

describe('test variants', () => {
  it('guards:none turns guards off and timer:off turns the countdown off', () => {
    const on = setupFromUrl('?seed=a').config.values;
    expect(on.ai.guardsEnabled).toBe(true);
    expect(on.countdown.enabled).toBe(true);
    const off = setupFromUrl('?seed=a&v=guards:none&v=timer:off').config.values;
    expect(off.ai.guardsEnabled).toBe(false);
    expect(off.countdown.enabled).toBe(false);
    expect(guardCount({ values: on } as never, 'mail-express', 3)).toBeGreaterThan(0);
    expect(guardCount({ values: off } as never, 'mail-express', 3)).toBe(0);
  });
});
