import { describe, it, expect } from 'vitest';
import { DEFAULT_MAP, GENERATED_MAP_ID, LINE_MAP_ID, loadMap, loadScenery, mapIdFromUrl, sessionMap } from '../src/map';
import { setupFromUrl } from '../src/setup';

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

  it("loads a map's scenery, and draws without it when there is none, it is off, broken or stale", async () => {
    const tight = await loadMap('tight-loop');
    const scenery = await loadScenery(tight, undefined, '');
    expect(scenery?.map).toBe('tight-loop');
    expect(scenery!.items.kind.length).toBeGreaterThan(100);
    expect(await loadScenery(tight, undefined, '?scenery=off')).toBeNull();
    expect(await loadScenery(await loadMap('alpha-flats'), undefined, '')).toBeNull();
    const files = new Map([['tight-loop', async () => ({ ...scenery, schemaVersion: 2 })]]);
    expect(await loadScenery(tight, files, '')).toBeNull();
    const stale = new Map([['tight-loop', async () => ({ ...scenery, source: { ...scenery!.source, hash: 'old' } })]]);
    expect(await loadScenery(tight, stale, '')).toBeNull();
  });

  it('?map=gen generates the map from the run seed, the same every time', async () => {
    const { config } = setupFromUrl('?map=gen&seed=abc');
    const a = await sessionMap(GENERATED_MAP_ID, 'abc', config, '?map=gen&seed=abc');
    const b = await sessionMap(GENERATED_MAP_ID, 'abc', config, '?map=gen&seed=abc');
    const c = await sessionMap(GENERATED_MAP_ID, 'abd', config, '?map=gen&seed=abd');
    expect(a.map.id).toBe('gen');
    expect(a.map.source.file).toMatch(/^gen:abc (balanced|forest|rocks|mesas|water|mud) [+-]\d/);
    expect(a.map).toEqual(b.map);
    expect(a.scenery).toEqual(b.scenery);
    expect(c.map.zones).not.toEqual(a.map.zones);
    expect((await sessionMap(GENERATED_MAP_ID, 'abc', config, '?scenery=off')).scenery).toBeNull();
  });

  it('?map=line generates the open line from the run seed, with towns, the same every time', async () => {
    const { config } = setupFromUrl('?map=line&seed=abc&set=mapGen.line.lengthTiles=1200');
    const a = await sessionMap(LINE_MAP_ID, 'abc', config, '');
    const b = await sessionMap(LINE_MAP_ID, 'abc', config, '');
    expect(a.map.id).toBe('line');
    expect(a.map.size.cols).toBe(1200);
    expect(a.map.source.file).toMatch(/^line:abc (balanced|forest|rocks|mesas|water|mud) [+-]\d/);
    expect(a.map.openLine).toBeTruthy();
    expect(a.map.routes.every((r) => !r.closed)).toBe(true);
    expect(a.map).toEqual(b.map);
  });

  it('?set=mapGen.<path>= changes the generator settings and a bad one names the path', async () => {
    const { config } = setupFromUrl('?map=gen&set=mapGen.size.cols=300');
    expect((await sessionMap(GENERATED_MAP_ID, 's', config, '')).map.size.cols).toBe(300);
    const bad = setupFromUrl('?map=gen&set=mapGen.track.curviness=7').config;
    await expect(sessionMap(GENERATED_MAP_ID, 's', bad, '')).rejects.toThrow(/mapGen\.track\.curviness/);
  });
});
