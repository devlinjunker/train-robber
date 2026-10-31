// Devlin's PR #65 review: the only platform you can jump onto is the caboose's, the caboose comes on
// about 1 in 5 trains, a guard sometimes stands in it, and you can mount your horse from its platform.
import { describe, it, expect } from 'vitest';
import {
  carBoardingTargets, carFrame, createSim, generateGuards, mountDoor, pickTrainCars, seedRng,
  type CarPose, type GameState, type SimConfig, type TrainState,
} from '../src';
import { asciiCar, OUTSIDE, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];
type Train = Values['trains'][string];

/** A 16 x 6 mail car with doors on both sides and two guard spawns. */
const GUARDED = asciiCar('mail', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, { id: 'side-right', side: 'right', cell: [8, 5] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [4, 2], facing: 'left' }, { cell: [11, 3], facing: 'right' }],
});
/** A 12 x 6 caboose with end doors and one guard spawn, like the shipped one. */
const CABOOSE = asciiCar('caboose', ['############', '#..........#', 'D..........D', 'D..........D', '#..........#', '############'], {
  entryPoints: [{ id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [11, 2] }],
  guardSpawns: [{ cell: [5, 2], facing: 'right' }],
});

function cfg(train: Partial<Train> = {}, platforms: Values['boarding']['targets']['platforms'] = 'caboose'): SimConfig {
  const base = testConfig();
  return testConfig({}, 'caboose1', {
    carTemplates: { ...TEST_CARS, guarded: GUARDED, 'test-caboose': CABOOSE },
    trains: { ...base.values.trains, mail: { ...TEST_MAIL_TRAIN, layouts: ['guarded'], caboose: 'test-caboose', loot: undefined, guards: { base: 0, perCar: 0.67 }, ...train } },
    trainMix: { ...base.values.trainMix, mailTrain: 'mail' },
    boarding: { ...base.values.boarding, targets: { doors: true, platforms, sideLadders: false } },
    outside: OUTSIDE,
  });
}

const WITH = ['engine', 'guarded', 'guarded', 'guarded', 'test-caboose'];
const WITHOUT = WITH.slice(0, 4);

describe('the caboose', () => {
  it('comes on cabooseShare of trains, rolled after the layouts', () => {
    let n = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const cars = pickTrainCars(cfg({ cabooseShare: 0.2 }), 'mail', `c-${i}`);
      if (cars[cars.length - 1] === 'test-caboose') n++;
      expect(cars.slice(0, 4)).toEqual(pickTrainCars(cfg(), 'mail', `c-${i}`).slice(0, 4));
    }
    expect(n / N).toBeGreaterThan(0.15);
    expect(n / N).toBeLessThan(0.25);
    expect(pickTrainCars(cfg(), 'mail', 'x')).toEqual(WITH);
    expect(pickTrainCars(cfg({ cabooseShare: 0 }), 'mail', 'x')).toEqual(WITHOUT);
  });

  it('has the only platform target with `caboose`; a train without one has none', () => {
    const pose = (cars: string[], index: number): CarPose => {
      const cols = index === 4 ? 12 : 16;
      return { trainId: 't', index, template: cars[index]!, x: 0, y: 0, ux: 1, uy: 0, halfLength: cols / 2, halfWidth: 3 };
    };
    const platforms = (c: SimConfig, cars: string[]) => cars.flatMap((_, i) => carBoardingTargets(c, pose(cars, i), cars)).filter((t) => t.kind === 'platform').map((t) => `${t.id}:${t.side}`);
    expect(platforms(cfg(), WITH)).toEqual(['platform-rear:left', 'platform-rear:right']);
    expect(carBoardingTargets(cfg(), pose(WITH, 4), WITH).filter((t) => t.kind === 'platform')).toHaveLength(2);
    expect(platforms(cfg(), WITHOUT)).toEqual([]);
    // `train-end` keeps the last car's platform whatever the car is.
    expect(platforms(cfg({}, 'train-end'), WITHOUT)).toEqual(['platform-rear:left', 'platform-rear:right']);
  });

  it('a guard stands in it with guards.cabooseChance, moved from the others; it never adds to perCar', () => {
    const train = { id: 'm', type: 'mail', cars: WITH } as unknown as TrainState;
    const guards = (c: SimConfig, seed: string) => generateGuards({ rng: seedRng(seed), persistent: { wantedLevel: 0 } } as unknown as GameState, c, train);
    const never = cfg({ guards: { base: 0, perCar: 0.67, cabooseChance: 0 } });
    const always = cfg({ guards: { base: 0, perCar: 0.67, cabooseChance: 1 } });
    const some = cfg({ guards: { base: 0, perCar: 0.67, cabooseChance: 0.3 } });
    let inCaboose = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      // Three guarded cars at 0.67 each: two guards, with or without the caboose.
      const a = guards(never, `g-${i}`), b = guards(always, `g-${i}`), c = guards(some, `g-${i}`);
      expect([a.length, b.length, c.length]).toEqual([2, 2, 2]);
      expect(a.some((g) => g.car === 4)).toBe(false);
      expect(b.filter((g) => g.car === 4)).toHaveLength(1);
      if (c.some((g) => g.car === 4)) inCaboose++;
    }
    expect(inCaboose / N).toBeGreaterThan(0.22);
    expect(inCaboose / N).toBeLessThan(0.38);
  });

  it('you can get onto your horse from its platform, by the corner on the horse\'s side', () => {
    const c = cfg();
    const sim = createSim({ config: c, map: testMap(undefined, { x: 116, y: 22 }), seed: 'cab', playerIds: [1] });
    const s = sim.state as GameState;
    const train = s.world.trains[0]!;
    expect(train.cars[train.cars.length - 1]).toBe('test-caboose');
    const p = s.players[0]!;
    const frame = carFrame(train.id, 4);
    p.placement = { frame, x: 12.5, y: 0.5, layer: 'interior' };
    expect(mountDoor(s, sim.map, c, p, 'left')).toMatchObject({ car: 4, entry: 'platform-rear' });
    expect(mountDoor(s, sim.map, c, p, 'right')).toBeNull();
    // Mid-platform is too far from either corner; with platform landings off it is no way off.
    p.placement = { frame, x: 12.5, y: 3, layer: 'interior' };
    expect(mountDoor(s, sim.map, c, p, 'left')).toBeNull();
    p.placement = { frame, x: 12.5, y: 5.5, layer: 'interior' };
    expect(mountDoor(s, sim.map, c, p, 'right')).toMatchObject({ entry: 'platform-rear' });
    expect(mountDoor(s, sim.map, cfg({}, 'none'), p, 'right')).toBeNull();
  });
});
