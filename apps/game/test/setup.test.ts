import { describe, expect, it } from 'vitest';
import { setupFromUrl } from '../src/setup';

describe('setup from the URL', () => {
  it('runs all mail trains on alpha-flats by default, about half blank elsewhere', () => {
    expect(setupFromUrl('?seed=a').config.variants.trainMix).toBe('all-mail');
    expect(setupFromUrl('?seed=a&map=alpha-flats').config.variants.trainMix).toBe('all-mail');
    expect(setupFromUrl('?seed=a&map=tight-loop').config.variants.trainMix).toBe('mixed');
  });
  it('keeps a preset\'s own trainMix and the URL\'s ?v= on alpha-flats', () => {
    expect(setupFromUrl('?seed=a&preset=map-trains').config.variants.trainMix).toBe('map');
    expect(setupFromUrl('?seed=a&v=trainMix:mixed').config.variants.trainMix).toBe('mixed');
  });
  it('defaults trains to 6 cars', () => {
    const { trains } = setupFromUrl('?seed=a').config.values;
    expect(trains['mail-express']!.carCount).toBe(6);
    expect(trains.blank!.carCount).toBe(6);
  });
});
