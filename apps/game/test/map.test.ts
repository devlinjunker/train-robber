import { describe, it, expect } from 'vitest';
import { DEFAULT_MAP, loadMap, mapIdFromUrl } from '../src/map';

describe('map loading', () => {
  it('reads ?map= and defaults to alpha-flats', () => {
    expect(mapIdFromUrl('?map=other&seed=1')).toBe('other');
    expect(mapIdFromUrl('?seed=1')).toBe(DEFAULT_MAP);
    expect(mapIdFromUrl('?map=')).toBe(DEFAULT_MAP);
  });

  it('loads and validates the built alpha-flats map', async () => {
    const map = await loadMap('alpha-flats');
    expect(map.id).toBe('alpha-flats');
    expect(map.routes[0]!.id).toBe('main');
  });

  it('names the maps it has when the id is unknown', async () => {
    await expect(loadMap('nowhere')).rejects.toThrow(/map nowhere: not found \(have .*alpha-flats/);
  });

  it('rejects a file that fails the schema or holds another map', async () => {
    const good = await loadMap('alpha-flats');
    const maps = new Map([
      ['broken', async () => ({ ...good, id: 'broken', schemaVersion: 2 })],
      ['renamed', async () => good],
    ]);
    await expect(loadMap('broken', maps)).rejects.toThrow(/map broken: invalid at schemaVersion/);
    await expect(loadMap('renamed', maps)).rejects.toThrow(/file holds map alpha-flats/);
  });
});
