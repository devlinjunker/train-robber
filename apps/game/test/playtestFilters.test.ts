import { describe, expect, it } from 'vitest';
import { filtersFromQuery, filtersToQuery, viewToQuery } from '../src/playtestFilters';

describe('Playtests page filters in the URL', () => {
  it('reads each filter from its own parameter, variants from v=group:id', () => {
    const f = filtersFromQuery('?pr=61&exp=fall-cost&version=0.2.5&tester=Dev&map=alpha-flats&runPr=61&save=ab12cd&v=trainMix:all-mail&v=bad');
    expect(Object.fromEntries(f)).toEqual({ version: '0.2.5', tester: 'Dev', mapId: 'alpha-flats', pr: '61', saveId: 'ab12cd', 'v:trainMix': 'all-mail' });
  });

  it('writes the set filters back, keeping pr and exp, dropping cleared ones', () => {
    const filters = new Map([['version', '0.2.5'], ['outcome', ''], ['v:steering', 'heading'], ['v:trainMix', 'all-mail'], ['experiment', 'fall-cost']]);
    const q = filtersToQuery('?pr=61&exp=fall-cost&outcome=died&v=old:x', filters, 'fall-cost');
    expect(q).toBe('?pr=61&exp=fall-cost&version=0.2.5&v=steering:heading&v=trainMix:all-mail');
    expect(Object.fromEntries(filtersFromQuery(q))).toEqual({ version: '0.2.5', 'v:steering': 'heading', 'v:trainMix': 'all-mail' });
  });

  it('round-trips through the URL and adds the view', () => {
    const filters = new Map([['experiment', 'fall-cost'], ['practice', 'saved']]);
    const q = viewToQuery(filtersToQuery('', filters), 'boarding');
    expect(q).toBe('?experiment=fall-cost&practice=saved&view=boarding');
    expect(filtersFromQuery(q)).toEqual(filters);
    expect(filtersToQuery('?pr=3', new Map())).toBe('?pr=3');
  });
});
