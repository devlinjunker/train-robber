// G10 boarding plan, client side: meet-here markers, their times, place names and lookouts.
import { describe, it, expect } from 'vitest';
import { createSim, prepareMap } from '@train-robber/sim';
import { clock, createMarkers, engineCone, lookoutAt, MARKER_AMBER, MARKER_GREEN, MARKER_RED, placeName, readMarkers, trainEta } from '../src/plan';
import { stadium, testConfig, testMap } from './fixtures';

describe('markers', () => {
  it('drops up to max, picks one up when dropped on it again, numbers two in one place', () => {
    const m = createMarkers(2);
    expect(m.toggle('main', 10, 0, 0, 'Gorge')).toBe('added');
    expect(m.toggle('main', 100, 0, 0, 'Gorge')).toBe('added');
    expect(m.list.map((q) => q.name)).toEqual(['Gorge', 'Gorge 2']);
    expect(m.toggle('main', 200, 0, 0, 'Flats')).toBe('replaced');
    expect(m.list.map((q) => q.d)).toEqual([100, 200]);
    expect(m.toggle('main', 203, 0, 0, 'Flats')).toBe('removed');
    expect(m.list).toHaveLength(1);
    expect(createMarkers(0).toggle('main', 1, 0, 0, 'x')).toBe('off');
  });

  it('times a train to a marker by its speed, weighing slow track, and nothing once it passed', () => {
    const cfg = testConfig();
    const v = cfg.values.trains.blank!.speedTilesPerTick * cfg.values.sim.tickRateHz;
    const open = { ...stadium(), closed: false };
    expect(trainEta(cfg, open, { type: 'blank', d: 20 }, 110)).toBeCloseTo(90 / v, 6);
    expect(trainEta(cfg, open, { type: 'blank', d: 120 }, 110)).toBeNull();
    const slow = { ...open, samples: { ...open.samples, speedScale: open.samples.s.map((d) => (d >= 60 && d < 100 ? 0.5 : 1)) } };
    expect(trainEta(cfg, slow, { type: 'blank', d: 20 }, 110)).toBeCloseTo(130 / v, 1);
    // A loop wraps.
    const loop = stadium();
    expect(trainEta(cfg, loop, { type: 'blank', d: loop.length - 10 }, 20)).toBeCloseTo(30 / v, 6);
  });

  it('reads green with time to spare, amber when close, red when the train beats you', () => {
    const cfg = testConfig();
    const map = testMap();
    const sim = createSim({ config: cfg, map, seed: 'mk', playerIds: [1] });
    const s = sim.state;
    const t = s.world.trains[0]!;
    const h = s.world.horses[0]!;
    const route = prepareMap(map).routes.get('main')!;
    const at = (d: number) => { const i = Math.round(d / route.spacing); return { x: route.samples.x[i]!, y: route.samples.y[i]! }; };
    const ahead = (t.d + 60) % route.length, p = at(ahead);
    const read = (hx: number, hy: number) => {
      Object.assign(h, { x: hx, y: hy });
      return readMarkers(s, sim.map, cfg, [{ id: 1, route: 'main', d: ahead, ...p, name: 'Here' }], h, 5)[0]!;
    };
    expect(read(p.x, p.y).colour).toBe(MARKER_GREEN);
    const r = read(p.x, p.y);
    expect(r.text).toContain('Here');
    expect(r.text).toContain(`you ${clock(0)}`);
    const trainSec = r.trainSec!;
    const top = cfg.values.horse.maxSpeed;
    expect(read(p.x + top * (trainSec - 2), p.y).colour).toBe(MARKER_AMBER);
    expect(read(p.x + top * (trainSec + 3), p.y).colour).toBe(MARKER_RED);
  });

  it('names a marker after the set piece, town, lookout or stretch it is at', () => {
    const map = {
      setPieces: [{ id: 'piece1', kind: 'canyon' as const, name: "Hangman's Gorge", route: 'main', d0: 500, d1: 650, box: { x0: 0, y0: 0, x1: 1, y1: 1 }, sign: { x: 0, y: 0 } }],
      towns: [{ id: 'town1', route: 'main', d: 1000, x: 1000, y: 50, side: 1 as const, radiusTiles: 18 }],
      lookouts: [{ id: 'lookout1', name: 'Eagle Rock', x: 1500, y: 0, topRadiusTiles: 8, sign: { x: 1500, y: 40 } }],
      stretches: [{ id: 'stretch1', name: 'Long Flats', profile: 'flats', pace: 'quiet' as const, route: 'main', d0: 0, d1: 4000, x0: 0, x1: 4000, sign: { x: 0, y: 0 } }],
    };
    expect(placeName(map, 600, 600, 50)).toBe("Hangman's Gorge");
    expect(placeName(map, 1040, 1040, 50)).toBe('Town 1');
    expect(placeName(map, 1500, 1500, 50)).toBe('below Eagle Rock');
    expect(placeName(map, 2500, 2500, 50)).toBe('Long Flats');
    expect(lookoutAt(map.lookouts, 1505, 3)).toBe(map.lookouts[0]);
    expect(lookoutAt(map.lookouts, 1500, 20)).toBeNull();
  });
});

describe('engine cone', () => {
  it('reaches the full range on open ground and stops at blocked ground', () => {
    const cfg = testConfig();
    const es = cfg.values.boarding.engineSight;
    const engine = { trainId: 't', index: 0, template: 'engine', x: 100, y: 90, ux: 1, uy: 0, halfLength: 5, halfWidth: 3 };
    // The middle ray, straight ahead.
    const far = (paint?: Parameters<typeof testMap>[0]) => {
      const cone = engineCone(prepareMap(testMap(paint)), cfg, engine, null, false);
      const [x, y] = cone.points[1 + (cone.points.length - 2) / 2]!;
      return Math.hypot(x - 100, y - 90);
    };
    expect(far()).toBeCloseTo(es.rangeTiles, 6);
    expect(far((x) => (x > 110 ? 'blocked' : 'open'))).toBeCloseTo(11, 6);
  });
});
