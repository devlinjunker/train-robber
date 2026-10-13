import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodeElevation, decodeZones, ZONES, type Route } from '@train-robber/config';
import { trackAt } from '@train-robber/sim';
import { buildMap, buildMapFile, stringifyMap, SAMPLE_SPACING_TILES } from '../src/maps/build';
import { MAPS_OUT, MAPS_SRC } from '../src/maps/cli';

const alpha = buildMapFile(join(MAPS_SRC, 'alpha-flats.tmj'));
const main = alpha.map.routes[0]!;
const at = (r: Route, i: number) => ({ x: r.samples.x[i]!, y: r.samples.y[i]!, tx: r.samples.tx[i]!, ty: r.samples.ty[i]! });

describe('alpha-flats stadium route', () => {
  it('matches the checked-in build', () => {
    expect(stringifyMap(alpha.map)).toBe(readFileSync(join(MAPS_OUT, 'alpha-flats.json'), 'utf8'));
  });

  it('is a closed 400 x 200 map with one route and a player spawn', () => {
    expect(alpha.map.size).toEqual({ cols: 400, rows: 200 });
    expect(alpha.map.routes.map((r) => [r.id, r.closed])).toEqual([['main', true]]);
    expect(alpha.map.markers.playerSpawn).toEqual({ x: 200, y: 170 });
  });

  it('has the length of two 240-tile straights and two radius-40 U-turns', () => {
    expect(main.length).toBeCloseTo(2 * 240 + 2 * Math.PI * 40, 0);
  });

  it('samples evenly at most half a tile apart, wrapping at the end', () => {
    const n = main.samples.x.length;
    expect(main.spacing).toBeLessThanOrEqual(SAMPLE_SPACING_TILES);
    expect(n).toBe(Math.round(main.length / main.spacing));
    for (let i = 0; i < n; i++) {
      const a = at(main, i), b = at(main, (i + 1) % n);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(main.spacing, 2);
      expect(main.samples.s[i]).toBeCloseTo(i * main.spacing, 2);
    }
  });

  it('stores unit tangents along each segment', () => {
    const n = main.samples.x.length;
    for (let i = 0; i < n; i++) {
      const a = at(main, i), b = at(main, (i + 1) % n);
      expect(Math.hypot(a.tx, a.ty)).toBeCloseTo(1, 5);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      expect(a.tx).toBeCloseTo((b.x - a.x) / len, 3);
      expect(a.ty).toBeCloseTo((b.y - a.y) / len, 3);
    }
  });

  it('passes through every control point', () => {
    for (const p of main.points) {
      let best = Infinity;
      for (let i = 0; i < main.samples.x.length; i++) best = Math.min(best, Math.hypot(main.samples.x[i]! - p.x, main.samples.y[i]! - p.y));
      expect(best).toBeLessThan(main.spacing / 2 + 1e-3);
    }
  });

  it('keeps the straights straight', () => {
    for (let i = 0; i < main.samples.x.length; i++) {
      const s = at(main, i);
      if (s.x < 145 || s.x > 255) continue;
      expect(Math.abs(s.y - 60) < 0.01 || Math.abs(s.y - 140) < 0.01).toBe(true);
      expect(s.ty).toBeCloseTo(0, 4);
      expect(Math.abs(s.tx)).toBeCloseTo(1, 4);
    }
    expect(alpha.minRadiusTiles).toBeGreaterThan(25);
  });

  it('leaves open ground from the spawn down to the bottom straight', () => {
    // Phase 1 decision: the rider starts at (200, 170) and heads up to the y = 140 straight.
    const grid = decodeZones(alpha.map);
    const { cols } = alpha.map.size;
    for (let y = 138; y <= 172; y++) for (let x = 150; x <= 250; x++) expect(ZONES[grid[y * cols + x]!], `${x},${y}`).toBe('open');
  });

  it('looks up positions and tangents along the baked route', () => {
    // The loop starts at (80, 60) heading right and is symmetric about x = 200 and y = 100,
    // so half way round is (320, 140), and the middle of each U-turn sits half a straight
    // (about 120 tiles) past each quarter.
    const near = (d: number, x: number, y: number, tx: number, ty: number) => {
      const p = trackAt(main, d);
      expect(p.x).toBeCloseTo(x, 0); expect(p.y).toBeCloseTo(y, 0);
      expect(p.tx).toBeCloseTo(tx, 1); expect(p.ty).toBeCloseTo(ty, 1);
    };
    const L = main.length;
    near(120, 200, 60, 1, 0);
    near(L / 4 + 120, 360, 100, 0, 1);
    near(L / 2, 320, 140, -0.99, 0.13); // the spline leans into the turn near the straight ends
    near(L / 2 + 120, 200, 140, -1, 0);
    near(3 * L / 4 + 120, 40, 100, 0, -1);
    expect(trackAt(main, 0)).toMatchObject({ x: 80, y: 60, tx: main.samples.tx[0], ty: main.samples.ty[0] });
    expect(trackAt(main, main.samples.s[7]!)).toMatchObject(at(main, 7));
    expect(trackAt(main, L)).toEqual(trackAt(main, 0));
    expect(trackAt(main, L + 100)).toEqual(trackAt(main, 100));
  });

  it('runs at full speed everywhere (no speed zones yet)', () => {
    expect(new Set(main.samples.speedScale)).toEqual(new Set([1]));
  });
});

// Small synthetic maps for the converter's rules.
const T = 16;
function tmj(opts: { cols?: number; rows?: number; tiles?: (x: number, y: number) => number; encode?: 'array' | 'zlib';
  route?: { x: number; y: number }[]; closed?: boolean; markers?: Record<string, [number, number]>; speedZones?: object[]; scenery?: object[];
  elevation?: (x: number, y: number) => number } = {}) {
  const cols = opts.cols ?? 20, rows = opts.rows ?? 10;
  const data = Array.from({ length: cols * rows }, (_, i) => opts.tiles?.(i % cols, Math.floor(i / cols)) ?? 0);
  const encoded = opts.encode === 'zlib'
    ? { encoding: 'base64', compression: 'zlib', data: deflateSync(Buffer.from(new Uint32Array(data).buffer)).toString('base64') }
    : { data };
  const route = opts.route ?? [{ x: 2, y: 2 }, { x: 10, y: 3 }, { x: 17, y: 2 }];
  const markers = opts.markers ?? { playerSpawn: [1, 8] };
  return JSON.stringify({
    orientation: 'orthogonal', infinite: false, width: cols, height: rows, tilewidth: T, tileheight: T,
    tilesets: [
      { firstgid: 1, name: 'zones', tiles: ZONES.map((z, id) => ({ id, properties: [{ name: 'zone', type: 'string', value: z }] })) },
      // Elevation tiles: level n is gid 5 + n.
      { firstgid: 5, name: 'elevation', tiles: Array.from({ length: 9 }, (_, id) => ({ id, properties: [{ name: 'elevation', type: 'int', value: id }] })) },
    ],
    layers: [
      { name: 'terrain', type: 'tilelayer', width: cols, height: rows, ...encoded },
      ...(opts.elevation ? [{ name: 'elevation', type: 'tilelayer', width: cols, height: rows,
        data: Array.from({ length: cols * rows }, (_, i) => { const l = opts.elevation!(i % cols, Math.floor(i / cols)); return l ? 5 + l : 0; }) }] : []),
      { name: 'track', type: 'objectgroup', objects: [{ id: 1, name: 'main', x: 0, y: 0, polyline: route.map((p) => ({ x: p.x * T, y: p.y * T })), properties: [{ name: 'closed', type: 'bool', value: opts.closed ?? false }] }] },
      { name: 'speedZones', type: 'objectgroup', objects: opts.speedZones ?? [] },
      { name: 'markers', type: 'objectgroup', objects: Object.entries(markers).map(([name, [x, y]], i) => ({ id: 10 + i, name, point: true, x: x * T, y: y * T })) },
      ...(opts.scenery ? [{ name: 'scenery', type: 'objectgroup', objects: opts.scenery }] : []),
    ],
  });
}
const build = (text: string) => buildMap('test.tmj', text, () => { throw new Error('no external files'); });

describe('build-maps rules', () => {
  it('reads array and zlib tile data the same way, and run-length encodes zones', () => {
    const tiles = (x: number, y: number) => (y === 0 ? 3 : x === 19 ? 2 : 0); // gids: open 1, slow 2, blocked 3, water 4, deep 5
    const a = build(tmj({ tiles })).map, b = build(tmj({ tiles, encode: 'zlib' })).map;
    expect(a.zones).toEqual(b.zones);
    const grid = decodeZones(a);
    expect(grid[0]).toBe(ZONES.indexOf('blocked'));
    expect(grid[1 * 20 + 19]).toBe(ZONES.indexOf('slow'));
    expect(grid[5 * 20 + 5]).toBe(ZONES.indexOf('open'));
  });

  it('starts and ends an open route on its end points', () => {
    const r = build(tmj()).map.routes[0]!;
    const n = r.samples.x.length;
    expect([r.samples.x[0], r.samples.y[0]]).toEqual([2, 2]);
    expect([r.samples.x[n - 1], r.samples.y[n - 1]]).toEqual([17, 2]);
    expect(r.samples.s[n - 1]).toBeCloseTo(r.length, 3);
  });

  it('applies the lowest overlapping speed zone', () => {
    const zone = (x: number, scale: number) => ({ id: 5, x: x * T, y: 0, width: 5 * T, height: 10 * T, properties: [{ name: 'speedScale', type: 'float', value: scale }] });
    const r = build(tmj({ speedZones: [zone(0, 0.8), zone(3, 0.5)] })).map.routes[0]!;
    const scaleAt = (x: number) => r.samples.speedScale[r.samples.x.findIndex((v) => v >= x)];
    expect([scaleAt(2), scaleAt(4), scaleAt(9)]).toEqual([0.8, 0.5, 1]);
  });

  it('rejects a route over water, a missing spawn and a spawn on blocked ground', () => {
    expect(() => build(tmj({ tiles: (x, y) => (x === 10 && y >= 2 && y <= 4 ? 4 : 0) }))).toThrow(/on a water tile/);
    expect(() => build(tmj({ tiles: (x, y) => (x === 10 && y >= 2 && y <= 4 ? 5 : 0) }))).toThrow(/on a deep tile/);
    expect(() => build(tmj({ markers: {} }))).toThrow(/missing marker "playerSpawn"/);
    expect(() => build(tmj({ tiles: (x, y) => (x === 1 && y === 8 ? 3 : 0) }))).toThrow(/playerSpawn is on a blocked tile/);
    expect(() => build(tmj({ route: [{ x: 2, y: 2 }, { x: 30, y: 2 }] }))).toThrow(/outside the map/);
  });

  it('leaves elevation out without an elevation layer, and round-trips it with one', () => {
    expect(build(tmj()).map.elevation).toBeUndefined();
    const lift = (x: number, y: number) => (y >= 13 && x >= 4 && x <= 8 ? 1 : 0);
    const level = decodeElevation(build(tmj({ rows: 16, elevation: lift })).map);
    expect(level[13 * 20 + 4]).toBe(1);
    expect(level[12 * 20 + 4]).toBe(0);
  });

  it('blocks the top of a cliff (two or more levels) but not a one-level slope', () => {
    // A 4 x 3 block at level 3 (x 14-17, y 12-14) and a level-1 rise at x 3-6, y 13-15.
    const elevation = (x: number, y: number) => (x >= 14 && x <= 17 && y >= 12 && y <= 14 ? 3 : x >= 3 && x <= 6 && y >= 13 ? 1 : 0);
    const grid = decodeZones(build(tmj({ rows: 16, elevation })).map);
    const zone = (x: number, y: number) => ZONES[grid[y * 20 + x]!];
    for (const [x, y] of [[14, 12], [17, 12], [14, 13], [17, 13], [15, 14], [16, 12]] as const) expect(zone(x, y)).toBe('blocked');
    expect(zone(15, 13)).toBe('open');
    expect(zone(16, 13)).toBe('open');
    expect(zone(13, 13)).toBe('open');
    expect(zone(3, 13)).toBe('open');
  });

  it('keeps the track six tiles clear of raised ground, wide enough for the cars', () => {
    expect(() => build(tmj({ rows: 16, elevation: (x, y) => (x === 10 && y === 8 ? 1 : 0) }))).toThrow(/keep the track on level 0/);
    expect(() => build(tmj({ rows: 16, elevation: (x, y) => (x === 10 && y === 12 ? 1 : 0) }))).not.toThrow();
  });
});

describe('build-maps scenery', () => {
  // gids: open 1, slow 2, blocked 3, water 4. Rows 6 to 9 hold the test ground; the route runs along row 2.
  const ground = (x: number, y: number) => (y < 6 ? 0 : x < 5 ? 3 : x < 10 ? 1 : x < 12 ? 4 : 0);
  const obj = (id: number, kind: string, x: number, y: number, extra: object = {}, props: Record<string, unknown> = {}) => ({
    id, name: '', type: kind, x: x * T, y: y * T, width: 0, height: 0, ...extra,
    properties: Object.entries(props).map(([name, value]) => ({ name, value })),
  });
  const rect = (w: number, h: number) => ({ width: w * T, height: h * T });
  const scenery = (objects: object[]) => build(tmj({ tiles: ground, markers: { playerSpawn: [15, 4] }, scenery: objects })).scenery!;
  const items = (s: NonNullable<ReturnType<typeof scenery>>) => s.items.kind.map((k, i) => ({ kind: s.kindLegend[k], x: s.items.x[i]!, y: s.items.y[i]! }));

  it('is null without a scenery layer, so maps without one build as before', () => {
    expect(build(tmj()).scenery).toBeNull();
  });

  it('places a point item, a tree only on rock and a bush only on open ground', () => {
    expect(items(scenery([obj(1, 'tree', 2.5, 7.5, { point: true }), obj(2, 'bush', 7.5, 7.5, { point: true })]))).toEqual([{ kind: 'tree', x: 2.5, y: 7.5 }, { kind: 'bush', x: 7.5, y: 7.5 }]);
    expect(() => scenery([obj(1, 'tree', 7.5, 7.5, { point: true })])).toThrow(/tree at 7\.5,7\.5 is on a open tile; paint it blocked/);
    expect(() => scenery([obj(1, 'bush', 2.5, 7.5, { point: true })])).toThrow(/bush .* is on a blocked tile; it needs open ground/);
    expect(() => scenery([obj(1, 'cactus', 2.5, 7.5, { point: true })])).toThrow(/unknown kind "cactus"/);
  });

  it('scatters an area over the tiles that suit each kind, the same way every build', () => {
    // A 20 x 4 rectangle over rock, open ground, water and open ground again; density 1 is one item a tile.
    const area = [obj(1, 'tree,bush', 0, 6, rect(20, 4), { density: 1 })];
    const a = items(scenery(area));
    expect(a.length).toBeGreaterThan(0);
    for (const it of a) {
      const x = Math.floor(it.x);
      expect(it.kind === 'tree' ? x < 5 : x >= 5 && (x < 10 || x >= 12), `${it.kind} at ${it.x}`).toBe(true);
    }
    expect(a.some((it) => it.kind === 'tree') && a.some((it) => it.kind === 'bush')).toBe(true);
    expect(items(scenery(area))).toEqual(a);
    // Only trees: every rock tile gets exactly one.
    expect(items(scenery([obj(1, 'tree', 0, 6, rect(20, 4), { density: 1 })]))).toHaveLength(5 * 4);
  });

  it('keeps bridges as rectangles, and refuses a bridge over water or rock', () => {
    const s = scenery([obj(1, 'bridge', 12, 6, rect(4, 2)), obj(3, 'bridge', 12, 8, rect(1, 2), { along: 'x' })]);
    expect(s.bridges).toEqual([{ x: 12, y: 6, w: 4, h: 2, along: 'x' }, { x: 12, y: 8, w: 1, h: 2, along: 'x' }]);
    expect(() => scenery([obj(1, 'bridge', 9, 6, rect(3, 2))])).toThrow(/bridge covers a water tile at 10,6/);
    expect(() => scenery([obj(1, 'bridge', 9, 6)])).toThrow(/bridge must be a rectangle/);
  });
});
