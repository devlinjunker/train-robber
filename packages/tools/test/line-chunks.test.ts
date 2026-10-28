// G4: an open line's tiles come in chunks built from the seed, the settings and the chunk's
// position alone. Any chunk, built in any order, gives the tiles of the whole map; the sim reads
// tiles chunk by chunk and plays the same run; mapHash hashes what the map is built from.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { CHUNK_TILES, decodeElevation, decodeZones, resolveMapGen, type MapDef } from '@train-robber/config';
import { generateLine, rng } from '@train-robber/mapgen';
import { createSim, mapHash, type Command } from '@train-robber/sim';
import { CONTENT_DIR, loadConfig, readJson } from '../src/content';
import { lineRunProblems } from '../src/maps/simChecks';

const defaults = readJson(join(CONTENT_DIR, 'base/map-gen.json'));
const settings = resolveMapGen(defaults);
// A shorter line, so the tests build every chunk quickly; its east and south edges cut chunks part way.
/** The map without its chunks, so the sim reads its `zones` as for a hand-made map. */
const withoutChunks = (m: MapDef & { terrain?: unknown }): MapDef => { const o = { ...m }; delete o.terrain; return o; };
const short = resolveMapGen(defaults, { line: { lengthTiles: 1000, widthTiles: 300 } });

describe('line chunks', () => {
  for (const [name, s] of [['east', short], ['west', resolveMapGen(defaults, { line: { lengthTiles: 1000, widthTiles: 300, direction: 'west' } })], ['water', resolveMapGen(defaults, { line: { lengthTiles: 1000, widthTiles: 300 }, mix: { themes: ['water'] } })]] as const) {
    it(`built one at a time in any order give the whole map's tiles and scenery (${name})`, () => {
      const whole = generateLine(`chunks-${name}`, s);
      const lazy = generateLine(`chunks-${name}`, s, { whole: false });
      expect(lazy.map.zones).toBeUndefined();
      expect(lazy.scenery.items.kind).toEqual([]);
      const { cols, rows } = whole.map.size, T = CHUNK_TILES;
      const zones = decodeZones(whole.map), heights = decodeElevation(whole.map);
      const want = new Set(whole.scenery.items.kind.map((k, i) => `${k} ${whole.scenery.items.x[i]} ${whole.scenery.items.y[i]} ${whole.scenery.items.size[i]}`));
      const got = new Set<string>();
      const order: [number, number][] = [];
      for (let cy = 0; cy * T < rows; cy++) for (let cx = 0; cx * T < cols; cx++) order.push([cx, cy]);
      // Shuffled, so no chunk is built after its neighbours on purpose.
      const r = rng(`order-${name}`);
      for (let i = order.length - 1; i > 0; i--) { const j = r.int(0, i); [order[i], order[j]] = [order[j]!, order[i]!]; }
      let bad = 0;
      for (const [cx, cy] of order) {
        const c = lazy.map.terrain!.chunk(cx, cy);
        for (let y = 0; y < T; y++) {
          for (let x = 0; x < T; x++) {
            const gx = cx * T + x, gy = cy * T + y;
            const zone = c.zones[y * T + x], level = c.heights[y * T + x];
            // Off the map: blocked, level 0.
            const off = gx >= cols || gy >= rows;
            if (zone !== (off ? 2 : zones[gy * cols + gx]) || level !== (off ? 0 : heights[gy * cols + gx])) bad++;
          }
        }
        c.scenery.kind.forEach((k, i) => {
          const x = c.scenery.x[i]!, y = c.scenery.y[i]!;
          expect(Math.floor(x) >= cx * T && Math.floor(x) < (cx + 1) * T && Math.floor(y) >= cy * T && Math.floor(y) < (cy + 1) * T).toBe(true);
          got.add(`${k} ${x} ${y} ${c.scenery.size[i]}`);
        });
      }
      expect(bad).toBe(0);
      expect(got).toEqual(want);
      // The rest of the map is the same either way.
      const rest: Partial<MapDef> = { ...whole.map };
      delete rest.zones; delete rest.elevation;
      expect(JSON.stringify({ ...lazy.map })).toBe(JSON.stringify(rest));
      expect(lazy.scenery.bridges).toEqual(whole.scenery.bridges);
    }, 60_000);
  }

  it('a chunk off the map is all blocked ground', () => {
    const { map } = generateLine('chunks-off', short, { whole: false });
    for (const [cx, cy] of [[-1, 0], [0, -1], [100, 0], [0, 100]] as const) {
      const c = map.terrain!.chunk(cx, cy);
      expect(c.zones.every((z) => z === 2)).toBe(true);
      expect(c.scenery.kind.length).toBe(0);
    }
  });

  it('a lazy line builds no chunk until one is asked for', () => {
    const t = performance.now();
    const { map } = generateLine('chunks-lazy', settings, { whole: false });
    // Planning the 4,000-tile line takes a fraction of building it.
    expect(performance.now() - t).toBeLessThan(2000);
    expect((map.terrain as unknown as { built: number }).built).toBe(0);
    map.terrain!.chunk(10, 5);
    expect((map.terrain as unknown as { built: number }).built).toBe(1);
  });
});

describe('the sim on chunks', () => {
  it('reads only the chunks it needs, and plays the same as on the whole map', () => {
    const whole = generateLine('chunks-sim', short);
    const lazy = generateLine('chunks-sim', short, { whole: false });
    const plain = withoutChunks(whole.map);
    const config = loadConfig({ preset: 'alpha-default', variants: { trainMix: 'map' } });
    const a = createSim({ config, map: plain, seed: 'chunks-sim', playerIds: [1] });
    const b = createSim({ config, map: lazy.map, seed: 'chunks-sim', playerIds: [1] });
    expect(a.map.chunks).toBeNull();
    expect(b.map.terrain).toBeNull();
    expect(b.hash()).toBe(a.hash());
    // Ride about at random for two minutes, into whatever is there: same state every second.
    const r = rng('chunks-sim-ride');
    let steer = { x: 0, y: -1 };
    for (let t = 0; t < 120 * 30; t++) {
      if (t % 45 === 0) steer = { x: r.range(-1, 1), y: r.range(-1, 1) };
      const commands: Command[] = [{ type: 'steer', x: steer.x, y: steer.y } as Command];
      a.step([{ player: 1, commands }]); b.step([{ player: 1, commands }]);
      if (t % 30 === 0) expect(b.hash(), `tick ${t}`).toBe(a.hash());
    }
    const total = Math.ceil(short.line.lengthTiles / CHUNK_TILES) * Math.ceil(short.line.widthTiles / CHUNK_TILES);
    expect(b.map.chunks!.count).toBeGreaterThan(0);
    expect(b.map.chunks!.count).toBeLessThan(total);
  }, 60_000);

  it('plays a whole run on a lazy line, event for event as on the whole map', () => {
    const lazyLog: string[] = [], wholeLog: string[] = [];
    const lazy = generateLine('line-1', settings, { whole: false }).map;
    const plain = withoutChunks(generateLine('line-1', settings).map);
    expect(lineRunProblems(lazy, 'line-1', 600, (l) => lazyLog.push(l))).toEqual([]);
    expect(lineRunProblems(plain, 'line-1', 600, (l) => wholeLog.push(l))).toEqual([]);
    expect(lazyLog.length).toBeGreaterThan(10);
    expect(lazyLog).toEqual(wholeLog);
  }, 120_000);
});

describe('mapHash of a generated line', () => {
  it('hashes the seed, generator version and settings, not the tiles', () => {
    const a = generateLine('hash-1', short, { whole: false }).map;
    const whole = generateLine('hash-1', short).map;
    expect(mapHash(whole)).toBe(mapHash(a));
    // Changing a tile does not change it: the tiles follow from what it hashes.
    expect(mapHash({ ...whole, zones: [[1, 2], ...whole.zones!.slice(1)] })).toBe(mapHash(whole));
    expect(a.generated).toMatchObject({ generator: 'line', seed: 'hash-1', chunkTiles: CHUNK_TILES });
    // Another seed, another setting or another version: another hash.
    expect(mapHash(generateLine('hash-2', short, { whole: false }).map)).not.toBe(mapHash(a));
    expect(mapHash(generateLine('hash-1', resolveMapGen(defaults, { line: { lengthTiles: 1000, widthTiles: 300, curviness: 0.5 } }), { whole: false }).map)).not.toBe(mapHash(a));
    expect(mapHash({ ...a, generated: { ...a.generated!, version: 'line0/0' } })).not.toBe(mapHash(a));
    // The loop's track settings are not the line's.
    expect(mapHash(generateLine('hash-1', resolveMapGen(defaults, { line: { lengthTiles: 1000, widthTiles: 300 }, track: { curviness: 0.5 } }), { whole: false }).map)).toBe(mapHash(a));
  });
});
