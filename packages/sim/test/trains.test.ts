import { describe, it, expect } from 'vitest';
import {
  CAR_TEMPLATES, HORSE_RADIUS, carEntryPoints, createSim, entryPointWorld, expandCars, nextInt, pinTrain, placeCars, pointInBox,
  pushOutOfBox, restoreSim, seedRng, trackAt, unpinTrain, type CarPose, type Command, type GameState,
} from '../src';
import { stadium, testConfig, testMap } from './fixtures';

const route = stadium();
const BLANK = expandCars([{ template: 'engine' }, { template: 'blank-car', count: 3 }]);
const pick = (c: CarPose) => ({ x: c.x, y: c.y, ux: c.ux, uy: c.uy });

describe('car templates', () => {
  it('engine has no doors; a blank car has a door mid-car on both sides', () => {
    expect(CAR_TEMPLATES.engine!.entryPoints).toEqual([]);
    expect(CAR_TEMPLATES.engine!.cells).not.toContain('door');
    const car = CAR_TEMPLATES['blank-car']!;
    expect(car.size).toEqual({ cols: 16, rows: 6 });
    const doors = car.cells.flatMap((c, i) => (c === 'door' ? [[i % 16, Math.floor(i / 16)]] : []));
    expect(doors).toEqual([[7, 0], [8, 0], [7, 5], [8, 5]]);
    expect(car.entryPoints.map((e) => [e.id, e.side, e.along, e.cell])).toEqual([['side-left', 'left', 0, [8, 0]], ['side-right', 'right', 0, [8, 5]]]);
    for (const e of car.entryPoints) expect(car.cells[e.cell[1] * 16 + e.cell[0]]).toBe('door');
  });
});

describe('placeCars', () => {
  it('lays rigid 16 x 6 cars end to end behind the engine on a straight', () => {
    // The top straight runs right from (40, 30); d = 100 puts the engine's front at x = 140.
    const cars = placeCars('t', BLANK, route, 100);
    expect(cars.map((c) => c.template)).toEqual(['engine', 'blank-car', 'blank-car', 'blank-car']);
    cars.forEach((c, i) => {
      expect(pick(c).x).toBeCloseTo(140 - 8 - 16 * i, 9);
      expect(c.y).toBeCloseTo(30, 9);
      expect([c.ux, c.uy, c.halfLength, c.halfWidth]).toEqual([1, 0, 8, 3]);
    });
  });

  it('keeps each car rigid on a bend: both ends on the track, body along the chord', () => {
    const d = 120 + 30; // engine front 30 tiles into the right-hand U-turn
    for (const c of placeCars('t', BLANK, route, d)) {
      const f = trackAt(route, d - c.index * 16), r = trackAt(route, d - c.index * 16 - 16);
      expect(c.x).toBeCloseTo((f.x + r.x) / 2, 9);
      expect(c.y).toBeCloseTo((f.y + r.y) / 2, 9);
      expect(Math.hypot(c.ux, c.uy)).toBeCloseTo(1, 12);
      expect(c.ux * (f.x - r.x) + c.uy * (f.y - r.y)).toBeCloseTo(Math.hypot(f.x - r.x, f.y - r.y), 9);
    }
  });

  it('wraps cars behind the start of the route onto its end', () => {
    const cars = placeCars('t', BLANK, route, 10);
    const f = trackAt(route, route.length - 6), r = trackAt(route, route.length - 22);
    expect(cars[1]!.x).toBeCloseTo((f.x + r.x) / 2, 9);
    expect(cars[1]!.y).toBeCloseTo((f.y + r.y) / 2, 9);
  });
});

describe('entry points', () => {
  it('sit on each side wall of a blank car, mid-car, left of travel being left', () => {
    const car = placeCars('t', BLANK, route, 100)[1]!; // centre (116, 30), travelling right
    const eps = carEntryPoints(car);
    expect(eps.map((e) => e.id)).toEqual(['side-left', 'side-right']);
    expect(eps[0]!.x).toBeCloseTo(116, 9);
    expect(eps[0]!.y).toBeCloseTo(27, 9);
    expect(eps[1]!.x).toBeCloseTo(116, 9);
    expect(eps[1]!.y).toBeCloseTo(33, 9);
  });

  it('follow the car round the train: on the bottom straight, left is down the screen', () => {
    const d = 120 + Math.PI * 20 + 60; // engine front 60 tiles along the bottom straight, heading left
    const car = placeCars('t', BLANK, route, d)[2]!;
    const left = entryPointWorld(car, { side: 'left', along: 0 });
    expect(left.x).toBeCloseTo(car.x, 9);
    expect(left.y).toBeCloseTo(70 + 3, 9);
  });

  it('applies the along offset toward the front', () => {
    const car = placeCars('t', BLANK, route, 100)[1]!;
    expect(entryPointWorld(car, { side: 'right', along: 2 }).x).toBeCloseTo(118, 9);
  });

  it('engine has none', () => {
    expect(carEntryPoints(placeCars('t', BLANK, route, 100)[0]!)).toEqual([]);
  });
});

describe('train scheduler', () => {
  const config = testConfig();
  const map = testMap();

  it('spawns one blank train at load, engine at the start of its route', () => {
    const sim = createSim({ config, map, seed: 's', playerIds: [1] });
    expect(sim.state.world.trains).toEqual([{ id: 'blank-1', type: 'blank', d: 0, pinnedBy: null }]);
    expect(sim.cars().map((c) => [c.trainId, c.template])).toEqual([['blank-1', 'engine'], ...Array(3).fill(['blank-1', 'blank-car'])]);
  });

  it('moves the train 9 tiles/s along the route and loops', () => {
    const sim = createSim({ config, map, seed: 's', playerIds: [1] });
    for (let t = 0; t < 600; t++) sim.step([]);
    expect(sim.state.world.trains[0]!.d).toBeCloseTo(90, 9);
    const lap = Math.ceil(route.length / (9 / 60));
    for (let t = 600; t < lap; t++) sim.step([]);
    const d = sim.state.world.trains[0]!.d;
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(9 / 60);
    expect(d).toBeCloseTo(lap * (9 / 60) - route.length, 6);
  });

  it('pins a train for one player at a time (the M3 commit hook)', () => {
    const sim = createSim({ config, map, seed: 's', playerIds: [1, 2] });
    const state = sim.state as GameState;
    expect(pinTrain(state, 'blank-1', 1)).toBe(true);
    expect(pinTrain(state, 'blank-1', 2)).toBe(false);
    expect(pinTrain(state, 'nope', 1)).toBe(false);
    unpinTrain(state, 'blank-1');
    expect(pinTrain(state, 'blank-1', 2)).toBe(true);
  });

  it('refuses a map without the train route', () => {
    expect(() => createSim({ config, map: { ...map, routes: [{ ...route, id: 'other' }] }, seed: 's', playerIds: [1] })).toThrow(/route main/);
  });
});

describe('horse against cars', () => {
  it('a horse riding into a car side stops against it', () => {
    const sim = createSim({ config: testConfig(), map: testMap(), seed: 's', playerIds: [1] });
    const h = (sim.state as GameState).world.horses[0]!;
    // Bottom straight is y = 70; the train reaches it after the U-turn. Ride up into it once it passes.
    h.x = 100; h.y = 80; h.hx = 0; h.hy = -1;
    for (let t = 0; t < 60 * 30; t++) sim.step(t === 0 ? [{ player: 1, commands: [{ type: 'move', x: 0, y: -127 }] }] : []);
    for (const car of sim.cars()) expect(pointInBox(h.x, h.y, car)).toBe(false);
  });

  it('pushOutOfBox leaves the circle touching the side, never inside', () => {
    const car: CarPose = placeCars('t', BLANK, route, 100)[1]!;
    const p = { x: 116.5, y: 31 };
    expect(pushOutOfBox(p, HORSE_RADIUS, car)).toBe(true);
    expect(p).toEqual({ x: 116.5, y: 33.5 });
    const q = { x: 116, y: 36 };
    expect(pushOutOfBox(q, HORSE_RADIUS, car)).toBe(false);
  });

  it('never ends a tick inside a car rectangle, over random riders', () => {
    const config = testConfig({ steering: 'screen' });
    for (const seed of ['a', 'b', 'c', 'd']) {
      const sim = createSim({ config, map: testMap(), seed, playerIds: [1] });
      const h = (sim.state as GameState).world.horses[0]!;
      h.x = 100; h.y = 74;
      const rng = seedRng(`bot-${seed}`);
      const axis = () => [-127, 0, 127][nextInt(rng, 'misc', 3)]!;
      let worst = Infinity;
      for (let t = 0; t < 60 * 120; t++) {
        const commands: Command[] = t % 20 === 0 ? [{ type: 'move', x: 0, y: nextInt(rng, 'misc', 4) === 0 ? 127 : -127 }, { type: 'steer', x: axis(), y: axis() }] : [];
        // Keep the bot near the track so it meets the train often.
        if (h.y < 20 || h.y > 85 || h.x < 15 || h.x > 185) commands.push({ type: 'steer', x: 100 - h.x, y: 50 - h.y });
        sim.step([{ player: 1, commands }]);
        for (const car of sim.cars()) {
          expect(pointInBox(h.x, h.y, car)).toBe(false);
          const lx = Math.abs((h.x - car.x) * car.ux + (h.y - car.y) * car.uy) - car.halfLength;
          const ly = Math.abs((h.y - car.y) * car.ux - (h.x - car.x) * car.uy) - car.halfWidth;
          worst = Math.min(worst, Math.max(lx, ly));
        }
      }
      // The bots really did rub against the train.
      expect(worst).toBeLessThan(HORSE_RADIUS + 1e-6);
    }
  });

  it('snapshot mid-ride restores and continues identically', () => {
    const config = testConfig({ steering: 'screen', throttleModel: 'coast' });
    const map = testMap((x, y) => (x > 120 && y > 80 ? 'slow' : 'open'));
    const script = (t: number) => [{ player: 1, commands: t % 90 === 0 ? [{ type: 'move', x: 0, y: t % 180 ? 0 : -127 }, { type: 'steer', x: (t % 7) - 3, y: -((t * 13) % 255) + 127 }] as Command[] : [] }];
    const a = createSim({ config, map, seed: 'r', playerIds: [1] });
    for (let t = 0; t < 700; t++) a.step(script(t));
    const b = restoreSim(a.snapshot(), config, map);
    for (let t = 700; t < 1500; t++) { a.step(script(t)); b.step(script(t)); }
    expect(b.hash()).toBe(a.hash());
  });
});
