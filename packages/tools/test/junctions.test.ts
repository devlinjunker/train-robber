// Junctions: segments shared by services, and trains that pick a branch at each split.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ZONES, trackPieces, type MapDef } from '@train-robber/config';
import { createSim, type CarPose } from '@train-robber/sim';
import { buildMap, buildMapFile } from '../src/maps/build';
import { MAPS_SRC } from '../src/maps/cli';
import { loadConfig } from '../src/content';

const T = 32;
type P = [number, number];
const J1: P = [40, 20], J2: P = [160, 20];
const SHARED: P[] = [J1, [100, 20], J2];
const OUTER: P[] = [J2, [185, 30], [190, 60], [185, 90], [160, 100], [40, 100], [15, 90], [10, 60], [15, 30], J1];
const INNER: P[] = [J2, [178, 28], [185, 45], [178, 62], [160, 70], [40, 70], [22, 62], [15, 45], [22, 28], J1];

/** A 200 x 120 open map with segments and services. */
function tmj(segments: Record<string, P[]>, services: Record<string, { path: string; trains?: number; trainOffset?: number }>): string {
  const objects = Object.entries(segments).map(([id, pts], i) => ({
    id: i + 1, name: id, x: 0, y: 0, polyline: pts.map(([x, y]) => ({ x: x * T, y: y * T })), properties: [{ name: 'segment', type: 'string', value: id }],
  }));
  const svc = Object.entries(services).map(([id, s], i) => ({
    id: 100 + i, name: id, x: 0, y: 0, point: true,
    properties: [
      { name: 'path', type: 'string', value: s.path },
      ...(s.trains !== undefined ? [{ name: 'trains', type: 'int', value: s.trains }] : []),
      ...(s.trainOffset !== undefined ? [{ name: 'trainOffset', type: 'float', value: s.trainOffset }] : []),
    ],
  }));
  return JSON.stringify({
    orientation: 'orthogonal', infinite: false, width: 200, height: 120, tilewidth: T, tileheight: T,
    tilesets: [{ firstgid: 1, name: 'zones', tiles: ZONES.map((z, id) => ({ id, properties: [{ name: 'zone', type: 'string', value: z }] })) }],
    layers: [
      { name: 'terrain', type: 'tilelayer', width: 200, height: 120, data: Array<number>(200 * 120).fill(1) },
      { name: 'track', type: 'objectgroup', objects },
      { name: 'services', type: 'objectgroup', objects: svc },
      { name: 'markers', type: 'objectgroup', objects: [{ id: 200, name: 'playerSpawn', point: true, x: 100 * T, y: 110 * T }] },
    ],
  });
}
const build = (text: string) => buildMap('test.tmj', text, () => { throw new Error('no external files'); }).map;
const twoLoops = (trains = { big: 1, small: 1 }) => build(tmj({ shared: SHARED, outer: OUTER, inner: INNER }, {
  big: { path: 'shared outer', trains: trains.big }, small: { path: 'shared, inner', trains: trains.small, trainOffset: 150 },
}));

describe('segments and services in build-maps', () => {
  const map = twoLoops();
  const [big, small] = map.routes;

  it('bakes each service into a closed route with its legs and the junctions they meet at', () => {
    expect(map.routes.map((r) => [r.id, r.closed, r.legs?.map((l) => l.segment)])).toEqual([['big', true, ['shared', 'outer']], ['small', true, ['shared', 'inner']]]);
    // Junction ids follow the segments in id order: inner starts at the first one.
    expect(map.junctions).toEqual([{ id: 'j1', x: 160, y: 20, tx: 1, ty: 0 }, { id: 'j2', x: 40, y: 20, tx: 1, ty: 0 }]);
    expect(big!.legs![0]).toMatchObject({ start: 0, from: 'j2', to: 'j1' });
    expect(big!.legs![1]!.start).toBe(big!.legs![0]!.length);
  });

  it('gives a shared segment the same samples in every service', () => {
    const n = big!.samples.s.filter((s) => s < big!.legs![0]!.length).length;
    for (const k of ['x', 'y', 's', 'tx', 'ty'] as const) expect(small!.samples[k].slice(0, n)).toEqual(big!.samples[k].slice(0, n));
  });

  it('spaces samples half a tile apart, with one longer step into each junction', () => {
    for (const r of map.routes) {
      const { s } = r.samples;
      const steps = s.map((v, i) => (i + 1 < s.length ? s[i + 1]! : r.length) - v);
      expect(steps.filter((d) => Math.abs(d - 0.5) > 1e-3).length).toBeLessThanOrEqual(r.legs!.length);
      for (const d of steps) { expect(d).toBeGreaterThan(0.24); expect(d).toBeLessThan(0.76); }
    }
  });

  it('keeps the track smooth through every junction', () => {
    for (const r of map.routes) {
      const { tx, ty } = r.samples, n = tx.length;
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n;
        expect(Math.acos(Math.min(1, tx[a]! * tx[i]! + ty[a]! * ty[i]!)) * 180 / Math.PI, `${r.id} sample ${i}`).toBeLessThan(3);
      }
    }
  });

  it('places trains on services, spaced from the offset', () => {
    expect(map.trains).toEqual([{ type: 'blank', route: 'big', d: 0 }, { type: 'blank', route: 'small', d: 150 }]);
  });

  it('draws shared track once', () => {
    expect(trackPieces(map).map((p) => [p.id, p.closed])).toEqual([['shared', false], ['outer', false], ['inner', false]]);
  });

  it('names the problem when segments do not join up', () => {
    const fails = (segments: Record<string, P[]>, services: Record<string, { path: string }>) => () => build(tmj(segments, services));
    expect(fails({ shared: SHARED, outer: OUTER, inner: INNER }, { big: { path: 'shared outer' }, small: { path: 'inner shared outer' } }))
      .toThrow(/service small: segment outer ends at j2 but inner starts at j1/);
    expect(fails({ shared: SHARED, outer: OUTER, inner: INNER }, { big: { path: 'shared outer' }, small: { path: 'shared nowhere' } })).toThrow(/service small: no segment nowhere/);
    expect(fails({ shared: SHARED, outer: OUTER, inner: INNER }, { big: { path: 'shared outer' } })).toThrow(/segment inner: no service runs on it/);
    expect(fails({ shared: SHARED, outer: [...OUTER.slice(0, -1), [41, 25]] }, { big: { path: 'shared outer' } })).toThrow(/meets no other segment/);
    expect(fails({ shared: SHARED, outer: OUTER, inner: [J2, [180, 55], ...INNER.slice(3)] }, { big: { path: 'shared outer' }, small: { path: 'shared inner' } }))
      .toThrow(/junction j1 at 160,20: segment inner leaves \d+ degrees off/);
    expect(fails({ shared: SHARED, outer: OUTER }, { big: { path: 'shared outer<' } })).toThrow(/backwards/);
  });
});

/** Every car's distance to the nearest car of another train, and how far any car moved in one tick. */
function watch(map: MapDef, seed: string, ticks: number) {
  const config = loadConfig();
  const sim = createSim({ config, map, seed, playerIds: [1] });
  let closest = Infinity, jump = 0;
  const switches: string[] = [];
  let prev: CarPose[] = sim.cars();
  let routes = sim.state.world.trains.map((t) => t.route);
  for (let k = 0; k < ticks; k++) {
    sim.step([{ player: 1, commands: [] }]);
    const cars = sim.cars();
    cars.forEach((c, i) => { jump = Math.max(jump, Math.hypot(c.x - prev[i]!.x, c.y - prev[i]!.y)); });
    if (k % 5 === 0) {
      for (const a of cars) for (const b of cars) if (a.trainId < b.trainId) closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
    }
    const now = sim.state.world.trains.map((t) => t.route);
    now.forEach((r, i) => { if (r !== routes[i]) switches.push(`${sim.state.tick} ${sim.state.world.trains[i]!.id} ${routes[i]}>${r}`); });
    routes = now;
    prev = cars;
  }
  return { closest, jump, switches, hash: sim.hash() };
}

describe('trains at junctions', () => {
  const map = twoLoops();
  const speed = loadConfig().values.trains.blank!.speedTilesPerTick;

  it('pick branches from the seed, so the same seed replays the same picks', () => {
    const a = watch(map, 'seed-a', 6000), b = watch(map, 'seed-a', 6000), c = watch(map, 'seed-b', 6000);
    expect(a.switches.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(c.switches).not.toEqual(a.switches);
  });

  it('never moves a car more than the train does in a tick when it changes service', () => {
    expect(watch(map, 'jumps', 6000).jump).toBeLessThan(speed * 1.05);
  });

  const bigCountry = buildMapFile(join(MAPS_SRC, 'big-country.tmj')).map;
  it.each(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])('keep big-country trains apart for ten minutes (seed %s)', (seed) => {
    const r = watch(bigCountry, `big-country-${seed}`, 10 * 60 * 60);
    expect(r.switches.length).toBeGreaterThan(4);
    expect(r.jump).toBeLessThan(speed * 1.05);
    expect(r.closest).toBeGreaterThan(12);
  });
});
