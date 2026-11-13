// Core loop PR (Devlin, 2026-11-10): prizes in guarded cars, slower and louder prize searches, heavy
// prizes, distraction rocks (G) and roof hatches into the prize car.
import { describe, it, expect } from 'vitest';
import {
  carriedSpeedScale, createSim, entryPointWorld, generateLoot, hatchCars, hatchSpot, searchNoiseTiles, searchTicksFor, throwLanding, toTrain, trainGrid,
  type Command, type GameState, type GuardState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { asciiCar, OUTSIDE, ROOF, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];

const GUARD_CAR = asciiCar('guarded', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, { id: 'side-right', side: 'right', cell: [8, 5] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 2], facing: 'right' }],
});

function config(more: Partial<Omit<Values, 'horse'>> = {}, train: Partial<Values['trains'][string]> = {}): SimConfig {
  const base = testConfig();
  return testConfig({}, 'core0001', {
    carTemplates: { ...TEST_CARS, 'guard-car': GUARD_CAR },
    trains: { ...base.values.trains, mail: { ...TEST_MAIL_TRAIN, ...train } },
    trainMix: { ...base.values.trainMix, mailTrain: 'mail' },
    ...more,
  });
}

const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number, ...commands: Command[]) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim, ...commands)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

function committed(cfg: SimConfig, seed = 'core'): Sim {
  const sim = createSim({ config: cfg, map, seed, playerIds: [1] });
  S(sim).world.trains[0]!.d = 100;
  step(sim, { type: 'startRun', trainId: S(sim).world.trains[0]!.id });
  expect(S(sim).run).not.toBeNull();
  return sim;
}

/** Committed and boarded through car 1's left door, the stumble passed; then standing at (x, y) of car 1. */
function aboardAt(cfg: SimConfig, x: number, y: number): Sim {
  const sim = committed(cfg);
  const car = sim.cars()[1]!;
  const ep = entryPointWorld(car, { side: 'left', along: car.halfLength - 8.5 });
  Object.assign(S(sim).world.horses[0]!, { x: ep.x + car.uy, y: ep.y - car.ux, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
  step(sim);
  const rp = S(sim).run!.players[1]!;
  rp.meter.zoneCentre = 0.5;
  rp.meter.phase = 0.25;
  step(sim, { type: 'jump' });
  expect(S(sim).run!.phase).toBe('aboard');
  rp.stumbleTicks = 0;
  const p = S(sim).players[0]!;
  p.placement = { ...p.placement, x, y };
  return sim;
}

describe('prize placement', () => {
  const fakeGuard = (car: number) => ({ car }) as GuardState;

  it('puts every prize in the car with the most guards under `guarded`', () => {
    const cfg = config({ loot: { densityScale: 1, prizePlacement: 'guarded', prize: { searchTimeScale: 1, searchNoiseTiles: 0 } } }, { layouts: ['mail-a'] });
    for (let i = 0; i < 20; i++) {
      const sim = committed(cfg, `place-${i}`);
      const train = S(sim).world.trains.find((t) => t.id === S(sim).run!.trainId)!;
      const loot = generateLoot(S(sim), cfg, train, [fakeGuard(1), fakeGuard(2), fakeGuard(2)]);
      const prizes = loot.filter((l) => cfg.values.items[l.item]!.category === 'prize');
      expect(prizes.length).toBeGreaterThan(0);
      // Car 2 has the most guards; one large slot per mail-a car, so a second prize goes to car 1 (any guard).
      expect(prizes[0]!.car === 2 || prizes.some((l) => l.car === 2)).toBe(true);
      for (const l of prizes) expect([1, 2]).toContain(l.car);
    }
  });

  it('spreads prizes over the cars under `any`', () => {
    const cfg = config({}, { layouts: ['mail-a'] });
    const cars = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const sim = committed(cfg, `any-${i}`);
      for (const l of S(sim).run!.loot) if (cfg.values.items[l.item]!.category === 'prize') cars.add(l.car);
    }
    expect(cars.size).toBeGreaterThan(2);
  });

  it('falls back to anywhere when the train has no guards', () => {
    const cfg = config({ loot: { densityScale: 1, prizePlacement: 'guarded', prize: { searchTimeScale: 1, searchNoiseTiles: 0 } } }, { layouts: ['mail-a'] });
    const sim = committed(cfg, 'noguards');
    expect(S(sim).run!.guards).toHaveLength(0);
    expect(S(sim).run!.loot.some((l) => cfg.values.items[l.item]!.category === 'prize')).toBe(true);
  });
});

describe('prize search and carry', () => {
  const prizeCfg = config({ loot: { densityScale: 1, prizePlacement: 'any', prize: { searchTimeScale: 2.5, searchNoiseTiles: 6 } } });

  it('makes a prize search slower; other loot and hidden stashes keep their time', () => {
    const plain = config();
    expect(searchTicksFor(prizeCfg, 'letter')).toBe(searchTicksFor(plain, 'letter'));
    expect(searchTicksFor(prizeCfg, 'strongbox')).toBe(Math.round(searchTicksFor(plain, 'strongbox') * 2.5));
    expect(searchTicksFor(prizeCfg, 'strongbox', true)).toBe(searchTicksFor(plain, 'strongbox', true));
  });

  it('makes a prize search louder', () => {
    const sim = committed(prizeCfg);
    const run = S(sim).run!;
    run.loot = [{ id: 0, car: 1, x: 2, y: 2, item: 'strongbox', hidden: false, taken: false }, { id: 1, car: 1, x: 4, y: 2, item: 'letter', hidden: false, taken: false }];
    expect(searchNoiseTiles(S(sim), prizeCfg, { search: { loot: 0, ticks: 0 } })).toBe(6);
    expect(searchNoiseTiles(S(sim), prizeCfg, { search: { loot: 1, ticks: 0 } })).toBe(prizeCfg.values.ai.noise.searchRadiusTiles);
    expect(searchNoiseTiles(S(sim), prizeCfg, { search: null })).toBe(0);
  });

  it('slows you while you carry a prize', () => {
    const cfg = config({ carry: { ...config().values.carry, prizeSpeedScale: 0.7 } });
    expect(carriedSpeedScale(cfg, ['letter'])).toBe(1);
    // The mail sack (weight 4) is under the weight slowdown, so only the prize scale applies.
    expect(carriedSpeedScale(cfg, ['mail-sack'])).toBeCloseTo(0.7, 9);
    expect(carriedSpeedScale(config(), ['mail-sack'])).toBe(1);
  });
});

describe('distraction rocks', () => {
  const cfg = config({}, { carType: 'guarded', layouts: ['guard-car'], carCount: 1, loot: undefined, guards: { base: 1 } });

  it('lands short of a wall', () => {
    const g = trainGrid(cfg, ['engine', 'guard-car']);
    const lx = toTrain(g, 1, 3);
    const land = throwLanding(g, lx, 1.5, -1, 0, 6);
    // Row 1: the front wall of car 1 is its column 0 (row 2 has the end door).
    expect(land.lx).toBeGreaterThanOrEqual(toTrain(g, 1, 1));
    expect(land.lx).toBeLessThan(lx);
    expect(throwLanding(g, lx, 2.5, 1, 0, 6).lx).toBeCloseTo(lx + 6, 6);
  });

  it('sends a guard near where it lands to look, and runs out', () => {
    const sim = aboardAt(cfg, 3, 2.5);
    const g = S(sim).run!.guards[0]!;
    // The guard looks toward the rear, away from the player.
    Object.assign(g, { x: 13, y: 2.5, fx: 1, fy: 0 });
    const p = S(sim).players[0]!;
    // Toward the rear: the car-frame x is minus the stick's x.
    const ev = step(sim, { type: 'move', x: -127, y: 0 }, { type: 'throw' });
    const thrown = ofType(ev, 'DistractionThrown');
    expect(thrown).toHaveLength(1);
    expect(thrown[0]!.heard).toBe(1);
    expect(thrown[0]!.left).toBe(1);
    expect(thrown[0]!.x).toBeGreaterThan(8);
    expect(g.state).toBe('suspicious');
    expect(g.lastKnown?.x).toBeCloseTo(thrown[0]!.x, 6);
    expect(p.placement.layer).toBe('interior');
    step(sim, { type: 'throw' });
    const third = step(sim, { type: 'throw' });
    expect(ofType(third, 'CommandRejected')[0]?.reason).toBe('no rocks left');
  });

  it('lands on a clicked point, or at its range on the way to one past it', () => {
    const sim = aboardAt(cfg, 3, 2.5);
    const near = ofType(step(sim, { type: 'throw', x: 6, y: 3.5 }), 'DistractionThrown')[0]!;
    expect(near.car).toBe(1);
    expect(near.x).toBeCloseTo(6, 0);
    expect(near.y).toBeCloseTo(3.5, 0);
    // Standing still is fine with a point to throw at.
    const far = ofType(step(sim, { type: 'throw', x: 15, y: 2.5 }), 'DistractionThrown')[0]!;
    expect(far.x).toBeLessThanOrEqual(3 + 6 + 1e-6);
    expect(far.x).toBeGreaterThan(8.5);
  });

  it('is refused standing still and with throwing off', () => {
    const sim = aboardAt(cfg, 3, 2.5);
    expect(ofType(step(sim, { type: 'throw' }), 'CommandRejected')[0]?.reason).toBe('standing still');
    const off = config({ verbs: { ...cfg.values.verbs, throw: { ...cfg.values.verbs.throw, perRun: 0 } } }, { carType: 'guarded', layouts: ['guard-car'], carCount: 1, loot: undefined, guards: { base: 1 } });
    const sim2 = aboardAt(off, 3, 2.5);
    expect(ofType(step(sim2, { type: 'move', x: -127, y: 0 }, { type: 'throw' }), 'CommandRejected')[0]?.reason).toBe('disabled');
  });
});

describe('roof hatches', () => {
  const withHatch = (cars: 'prize' | 'all' | 'none') => config({ outside: { ...OUTSIDE, roof: { ...ROOF, hatch: { cars, climbTicks: 90, reachTiles: 1 } } } }, { layouts: ['mail-a'] });

  it('goes on the cars with a prize, every car, or none', () => {
    const cfg = withHatch('prize');
    const sim = committed(cfg);
    const run = S(sim).run!;
    const prizeCars = [...new Set(run.loot.filter((l) => cfg.values.items[l.item]!.category === 'prize').map((l) => l.car))].sort();
    expect(run.hatchCars).toEqual(prizeCars);
    const train = S(sim).world.trains.find((t) => t.id === run.trainId)!;
    expect(hatchCars(withHatch('all'), train, run.loot)).toEqual(train.cars.map((_, k) => k));
    expect(hatchCars(withHatch('none'), train, run.loot)).toEqual([]);
  });

  it('sits on an inside floor cell near the middle of the car', () => {
    const cfg = withHatch('all');
    const spot = hatchSpot(cfg, ['engine', 'mail-a', 'blank-car'], 1)!;
    expect(spot).toEqual({ x: 7.5, y: 2.5 });
  });

  it('climbs out onto the roof and drops back in, staggering', () => {
    const cfg = withHatch('all');
    const sim = aboardAt(cfg, 7.5, 2.5);
    const p = S(sim).players[0]!;
    step(sim, { type: 'climb' });
    expect(S(sim).run!.players[1]!.climb?.end).toBe('hatch');
    const up = steps(sim, 90);
    expect(ofType(up, 'Climbed')[0]).toMatchObject({ end: 'hatch', to: 'roof' });
    expect(p.placement.layer).toBe('roof');
    expect([p.placement.x, p.placement.y]).toEqual([7.5, 2.5]);
    step(sim, { type: 'climb' });
    const down = steps(sim, 90);
    expect(ofType(down, 'Climbed')[0]).toMatchObject({ end: 'hatch', to: 'deck' });
    expect(p.placement.layer).toBe('interior');
    expect(S(sim).run!.players[1]!.stumbleTicks).toBeGreaterThan(0);
  });

  it('is not there with hatches off', () => {
    const sim = aboardAt(withHatch('none'), 7.5, 2.5);
    expect(ofType(step(sim, { type: 'climb' }), 'CommandRejected')[0]?.reason).toBe('no ladder');
  });
});
