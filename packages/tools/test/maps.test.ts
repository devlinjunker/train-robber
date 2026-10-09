import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodeZones, ZONES, type Route } from '@train-robber/config';
import { buildMap, buildMapFile, stringifyMap, SAMPLE_SPACING_TILES } from '../src/maps/build';
import { MAPS_OUT, MAPS_SRC } from '../src/maps/cli';

const alpha = buildMapFile(join(MAPS_SRC, 'alpha-flats.tmj'));
const main = alpha.map.routes[0]!;
const at = (r: Route, i: number) => ({ x: r.samples.x[i]!, y: r.samples.y[i]!, tx: r.samples.tx[i]!, ty: r.samples.ty[i]! });

describe('alpha-flats stadium route', () => {
  it('matches the checked-in build', () => {
    expect(stringifyMap(alpha.map)).toBe(readFileSync(join(MAPS_OUT, 'alpha-flats.json'), 'utf8'));
  });

  it('is a closed 400 x 200 map with one route and both spawns', () => {
    expect(alpha.map.size).toEqual({ cols: 400, rows: 200 });
    expect(alpha.map.routes.map((r) => [r.id, r.closed])).toEqual([['main', true]]);
    expect(alpha.map.markers.playerSpawn).toEqual({ x: 200, y: 170 });
    expect(alpha.map.markers.horseSpawn).toEqual({ x: 202, y: 171 });
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

  it('runs at full speed everywhere (no speed zones yet)', () => {
    expect(new Set(main.samples.speedScale)).toEqual(new Set([1]));
  });
});

// Small synthetic maps for the converter's rules.
const T = 16;
function tmj(opts: { cols?: number; rows?: number; tiles?: (x: number, y: number) => number; encode?: 'array' | 'zlib';
  route?: { x: number; y: number }[]; closed?: boolean; markers?: Record<string, [number, number]>; speedZones?: object[] } = {}) {
  const cols = opts.cols ?? 20, rows = opts.rows ?? 10;
  const data = Array.from({ length: cols * rows }, (_, i) => opts.tiles?.(i % cols, Math.floor(i / cols)) ?? 0);
  const encoded = opts.encode === 'zlib'
    ? { encoding: 'base64', compression: 'zlib', data: deflateSync(Buffer.from(new Uint32Array(data).buffer)).toString('base64') }
    : { data };
  const route = opts.route ?? [{ x: 2, y: 2 }, { x: 10, y: 3 }, { x: 17, y: 2 }];
  const markers = opts.markers ?? { playerSpawn: [1, 8], horseSpawn: [2, 8] };
  return JSON.stringify({
    orientation: 'orthogonal', infinite: false, width: cols, height: rows, tilewidth: T, tileheight: T,
    tilesets: [{ firstgid: 1, name: 'zones', tiles: ZONES.map((z, id) => ({ id, properties: [{ name: 'zone', type: 'string', value: z }] })) }],
    layers: [
      { name: 'terrain', type: 'tilelayer', width: cols, height: rows, ...encoded },
      { name: 'track', type: 'objectgroup', objects: [{ id: 1, name: 'main', x: 0, y: 0, polyline: route.map((p) => ({ x: p.x * T, y: p.y * T })), properties: [{ name: 'closed', type: 'bool', value: opts.closed ?? false }] }] },
      { name: 'speedZones', type: 'objectgroup', objects: opts.speedZones ?? [] },
      { name: 'markers', type: 'objectgroup', objects: Object.entries(markers).map(([name, [x, y]], i) => ({ id: 10 + i, name, point: true, x: x * T, y: y * T })) },
    ],
  });
}
const build = (text: string) => buildMap('test.tmj', text, () => { throw new Error('no external files'); });

describe('build-maps rules', () => {
  it('reads array and zlib tile data the same way, and run-length encodes zones', () => {
    const tiles = (x: number, y: number) => (y === 0 ? 3 : x === 19 ? 2 : 0); // gids: open 1, slow 2, blocked 3, water 4
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
    expect(() => build(tmj({ markers: { playerSpawn: [1, 8] } }))).toThrow(/missing marker "horseSpawn"/);
    expect(() => build(tmj({ tiles: (x, y) => (x === 1 && y === 8 ? 3 : 0) }))).toThrow(/playerSpawn is on a blocked tile/);
    expect(() => build(tmj({ route: [{ x: 2, y: 2 }, { x: 30, y: 2 }] }))).toThrow(/outside the map/);
  });
});
