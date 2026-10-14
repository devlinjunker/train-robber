// Phase 2 M2: run generation (layouts and loot from the seed and run number), the search verb,
// carrying, dropping, walking between cars, and the trainMix setting.
import { describe, it, expect } from 'vitest';
import {
  carriedWeight, carryRefusal, carrySpeedScale, createSim, entryPointWorld, generateLoot, initialTrains, pickTrainCars, runSeed, searchTicksFor, seedRng, trainCarsSeed,
  type Command, type GameState, type LootState, type Sim, type SimConfig, type SimEvent, type SimMap,
} from '../src';
import { TEST_MAIL_TRAIN, testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];

/** The test config with a mail train as the map's train; `train` and `more` patch it. */
function mailConfig(train: Partial<Values['trains'][string]> = {}, more: Partial<Omit<Values, 'horse'>> = {}): SimConfig {
  const base = testConfig();
  return testConfig({}, 'mail0001', {
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

/** A sim whose mail train's engine front is at d = 100, committed to it. */
function committed(cfg: SimConfig, seed = 'm2'): Sim {
  const sim = createSim({ config: cfg, map, seed, playerIds: [1] });
  S(sim).world.trains[0]!.d = 100;
  const ev = step(sim, { type: 'startRun', trainId: S(sim).world.trains[0]!.id });
  expect(ofType(ev, 'RunStarted')).toHaveLength(1);
  return sim;
}

/** Committed and boarded through car 1's left door (all mail-a, so every car has one). */
function aboard(cfg = mailConfig({ layouts: ['mail-a'] }), seed = 'm2'): Sim {
  const sim = committed(cfg, seed);
  const car = sim.cars()[1]!;
  const ep = entryPointWorld(car, { side: 'left', along: -0.5 });
  Object.assign(S(sim).world.horses[0]!, { x: ep.x + car.uy, y: ep.y - car.ux, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
  step(sim);
  const rp = S(sim).run!.players[1]!;
  rp.meter.zoneCentre = 0.5;
  rp.meter.phase = 0.3;
  step(sim, { type: 'jump' });
  expect(S(sim).run!.phase).toBe('aboard');
  // Let the landing stumble pass so walking runs at full speed.
  steps(sim, 30);
  return sim;
}

const player = (sim: Sim) => S(sim).players[0]!;
const rp = (sim: Sim) => S(sim).run!.players[1]!;
/** Put the player on a loot item in their car and give back the item. */
function standOn(sim: Sim, l: LootState): void {
  const p = player(sim);
  p.placement = { ...p.placement, frame: `car:${S(sim).run!.trainId}:${l.car}`, x: l.x, y: l.y };
}
const lootIn = (sim: Sim, car: number) => S(sim).run!.loot.filter((l) => l.car === car && !l.taken);

describe('run generation', () => {
  it('the same seed and run number give the same cars and loot, and another seed differs', () => {
    const cfg = mailConfig();
    const a = committed(cfg, 'same'), b = committed(cfg, 'same');
    expect(S(a).world.trains[0]!.cars).toEqual(S(b).world.trains[0]!.cars);
    expect(S(a).run!.loot).toEqual(S(b).run!.loot);
    expect(S(a).run!.loot.length).toBeGreaterThan(0);
    // The cars come from the run's seed alone.
    const t = S(a).world.trains[0]!;
    expect(t.cars).toEqual(pickTrainCars(cfg, 'mail', `${runSeed('same', 1)}/${t.id}`));
    const differs = ['x1', 'x2', 'x3', 'x4'].some((seed) => {
      const c = committed(cfg, seed);
      return JSON.stringify([S(c).world.trains[0]!.cars, S(c).run!.loot]) !== JSON.stringify([t.cars, S(a).run!.loot]);
    });
    expect(differs).toBe(true);
  });

  it('run two is the same for the same seed however run one went', () => {
    const cfg = mailConfig();
    const runTwo = (wait: number) => {
      const sim = committed(cfg, 'r2');
      steps(sim, wait);
      step(sim, { type: 'cancelRun' });
      // The train is free again, with run two's layouts.
      const t = S(sim).world.trains[0]!;
      expect(t.cars).toEqual(pickTrainCars(cfg, 'mail', trainCarsSeed(S(sim), t.id)));
      step(sim, { type: 'startRun', trainId: t.id });
      return { cars: t.cars, loot: S(sim).run!.loot };
    };
    expect(runTwo(5)).toEqual(runTwo(200));
  });

  it('every engine-to-caboose train has side doors on both sides with requireSideDoors both', () => {
    const cfg = mailConfig({ caboose: undefined });
    for (let i = 0; i < 200; i++) {
      const cars = pickTrainCars(cfg, 'mail', `doors-${i}`);
      expect(cars[0]).toBe('engine');
      expect(cars).toHaveLength(4);
      // Only mail-a has a right-side door.
      expect(cars).toContain('mail-a');
    }
    const one = mailConfig({ caboose: undefined, layouts: ['mail-b', 'mail-c'], requireSideDoors: 'one' });
    for (let i = 0; i < 100; i++) expect(pickTrainCars(one, 'mail', `one-${i}`)).toContain('mail-b');
  });

  it('maxSideDoorCars caps the cars with side doors and still keeps a door on each side', () => {
    const cfg = mailConfig({ caboose: undefined, carCount: 8, maxSideDoorCars: 2 });
    const doorCars = (cars: string[]) => cars.filter((id) => id === 'mail-a' || id === 'mail-b').length;
    let seen = 0;
    for (let i = 0; i < 200; i++) {
      const cars = pickTrainCars(cfg, 'mail', `cap-${i}`);
      expect(cars).toHaveLength(9);
      expect(doorCars(cars)).toBeLessThanOrEqual(2);
      expect(cars).toContain('mail-a');
      seen = Math.max(seen, doorCars(pickTrainCars(mailConfig({ caboose: undefined, carCount: 8 }), 'mail', `cap-${i}`)));
    }
    // Without the cap an 8-car train often has more door cars.
    expect(seen).toBeGreaterThan(2);
  });

  it('places prizes on large slots, small items by density, and skips hidden slots unless hidden loot is on', () => {
    const cfg = mailConfig({ layouts: ['mail-a'], caboose: undefined });
    const sim = createSim({ config: cfg, map, seed: 'gen', playerIds: [1] });
    const train = S(sim).world.trains[0]!;
    for (let i = 0; i < 50; i++) {
      S(sim).rng = seedRng(`loot-${i}`);
      const loot = generateLoot(S(sim), cfg, train);
      const prizes = loot.filter((l) => cfg.values.items[l.item]!.category === 'prize');
      expect(prizes.length).toBeGreaterThanOrEqual(1);
      expect(prizes.length).toBeLessThanOrEqual(2);
      expect(loot.some((l) => l.hidden)).toBe(false);
      // 3 cars × 2 visible small slots × 0.6 density.
      expect(loot.length - prizes.length).toBe(4);
    }
    const hidden = mailConfig({ layouts: ['mail-a'], caboose: undefined }, { verbs: { search: { ...cfg.values.verbs.search, hiddenLoot: true } } });
    const seen = new Set<boolean>();
    for (let i = 0; i < 50; i++) {
      S(sim).rng = seedRng(`loot-${i}`);
      for (const l of generateLoot(S(sim), hidden, train)) seen.add(l.hidden);
    }
    expect(seen.has(true)).toBe(true);
    expect(generateLoot(S(sim), testConfig(), { ...train, type: 'blank' })).toEqual([]);
  });
});

describe('search', () => {
  it('holding E for the search time picks up the item, emitting LootPickedUp, and raises heat by heat.sources.lootTaken', () => {
    const sim = aboard();
    const l = lootIn(sim, 1)[0]!;
    standOn(sim, l);
    const ev = step(sim, { type: 'interact', held: true });
    expect(rp(sim).search).toEqual({ loot: l.id, ticks: 1 });
    ev.push(...steps(sim, 70));
    expect(ofType(ev, 'LootPickedUp')).toHaveLength(0);
    ev.push(...step(sim));
    expect(ofType(ev, 'LootPickedUp')).toEqual([expect.objectContaining({ item: l.item, loot: l.id, car: 1 })]);
    expect(rp(sim).carried).toEqual([l.item]);
    expect(ofType(ev, 'HeatChanged')).toEqual([expect.objectContaining({ cause: 'lootTaken', delta: 1 })]);
    expect(S(sim).run!.heat).toBe(1);
    expect(l.taken).toBe(true);
    // Still holding: the next item waits for a release.
    steps(sim, 100);
    expect(rp(sim).carried).toHaveLength(1);
  });

  it('searching a hidden stash for hiddenSearchTimeSec reveals its item, which is then searched again to take it', () => {
    const cfg = mailConfig({ layouts: ['mail-a'] });
    const sim = aboard(cfg);
    const l = lootIn(sim, 1)[0]!;
    l.hidden = true;
    standOn(sim, l);
    expect(searchTicksFor(cfg, l.item, true)).toBe(108);
    const ev = step(sim, { type: 'interact', held: true });
    ev.push(...steps(sim, 106));
    expect(ofType(ev, 'LootRevealed')).toHaveLength(0);
    ev.push(...step(sim));
    expect(ofType(ev, 'LootRevealed')).toEqual([expect.objectContaining({ item: l.item, loot: l.id, car: 1 })]);
    expect(ofType(ev, 'LootPickedUp')).toHaveLength(0);
    expect(ofType(ev, 'HeatChanged')).toHaveLength(0);
    expect([l.hidden, l.taken]).toEqual([false, false]);
    expect(rp(sim).carried).toEqual([]);
    // Still holding: taking it waits for a release, then the item's own search time.
    steps(sim, 100);
    expect(rp(sim).carried).toEqual([]);
    step(sim, { type: 'interact', held: false });
    const take = steps(sim, searchTicksFor(cfg, l.item), { type: 'interact', held: true });
    expect(ofType(take, 'LootPickedUp')).toEqual([expect.objectContaining({ item: l.item, loot: l.id })]);
    expect(rp(sim).carried).toEqual([l.item]);
  });

  it('an item\'s own search time replaces the verb\'s, and timeScale scales both', () => {
    const base = testConfig();
    const items = { ...base.values.items, strongbox: { ...base.values.items.strongbox!, searchTimeTicks: 132 } };
    const cfg = testConfig({}, 'srch0001', { items });
    expect([searchTicksFor(cfg, 'letter'), searchTicksFor(cfg, 'strongbox')]).toEqual([72, 132]);
    const slow = testConfig({}, 'srch0002', { items, verbs: { search: { ...base.values.verbs.search, timeScale: 2.5 } } });
    expect([searchTicksFor(slow, 'letter'), searchTicksFor(slow, 'strongbox')]).toEqual([180, 330]);
  });

  it('releasing E cancels and loses the progress', () => {
    const sim = aboard();
    standOn(sim, lootIn(sim, 1)[0]!);
    step(sim, { type: 'interact', held: true });
    steps(sim, 35);
    const ev = step(sim, { type: 'interact', held: false });
    expect(ofType(ev, 'SearchCancelled')).toEqual([expect.objectContaining({ reason: 'released', progress: 0.5 })]);
    step(sim, { type: 'interact', held: true });
    expect(rp(sim).search!.ticks).toBe(1);
  });

  it('moving more than the cancel range from the loot cancels it', () => {
    const sim = aboard();
    const l = lootIn(sim, 1).find((q) => q.y < 3)!;
    standOn(sim, l);
    step(sim, { type: 'interact', held: true }, { type: 'move', x: 0, y: 127 });
    const ev = steps(sim, 80);
    expect(ofType(ev, 'SearchCancelled')).toEqual([expect.objectContaining({ reason: 'moved away', loot: l.id })]);
    expect(ofType(ev, 'LootPickedUp')).toHaveLength(0);
  });

  it('you walk at the slow-walk scale while searching', () => {
    const sim = aboard();
    const l = lootIn(sim, 1).find((q) => q.y < 3)!;
    standOn(sim, l);
    step(sim, { type: 'interact', held: true }, { type: 'move', x: 0, y: 127 });
    const y0 = player(sim).placement.y;
    step(sim);
    expect(player(sim).placement.y - y0).toBeCloseTo((8 / 60) * 0.3, 9);
  });

  it('a pickup that would break the weight or item limit is refused', () => {
    const cfg = mailConfig({ layouts: ['mail-a'] });
    const sim = aboard(cfg);
    const prize = S(sim).run!.loot.find((l) => cfg.values.items[l.item]!.category === 'prize')!;
    rp(sim).carried = ['strongbox'];
    standOn(sim, prize);
    const ev = step(sim, { type: 'interact', held: true });
    ev.push(...steps(sim, 72));
    expect(ofType(ev, 'LootRefused')).toEqual([expect.objectContaining({ reason: 'too heavy', item: prize.item })]);
    expect(prize.taken).toBe(false);
    expect(carryRefusal(cfg, Array(20).fill('letter'), 'letter')).toBe('too many items');
    expect(carryRefusal(mailConfig({}, { carry: { ...cfg.values.carry, limitEnabled: false } }), ['strongbox'], 'strongbox')).toBeNull();
  });

  it('drop puts an item on the floor where you stand, to be searched again', () => {
    const sim = aboard();
    rp(sim).carried = ['letter', 'strongbox'];
    const p = player(sim);
    p.placement = { ...p.placement, x: 5.3, y: 2.7 };
    const ev = step(sim, { type: 'drop', slot: 1 });
    expect(ofType(ev, 'LootDropped')).toEqual([expect.objectContaining({ item: 'strongbox', car: 1 })]);
    expect(rp(sim).carried).toEqual(['letter']);
    expect(S(sim).run!.loot.at(-1)).toMatchObject({ car: 1, x: 5.5, y: 2.5, item: 'strongbox', taken: false });
    expect(ofType(step(sim, { type: 'drop', slot: 4 }), 'CommandRejected')).toEqual([expect.objectContaining({ reason: 'nothing to drop' })]);
  });

  it('carrying slows you from the slowdown weight down to the minimum scale at the max', () => {
    const cfg = mailConfig();
    expect(carrySpeedScale(cfg, 6)).toBe(1);
    expect(carrySpeedScale(cfg, 8)).toBeCloseTo(0.75, 9);
    expect(carrySpeedScale(cfg, 10)).toBeCloseTo(0.5, 9);
    expect(carrySpeedScale(cfg, 14)).toBeCloseTo(0.5, 9);
    expect(carrySpeedScale(mailConfig({}, { carry: { ...cfg.values.carry, slowdownEnabled: false } }), 10)).toBe(1);
    expect(carriedWeight(cfg, ['strongbox', 'letter'])).toBeCloseTo(6.1, 9);
    const sim = aboard();
    rp(sim).carried = ['strongbox', 'mail-sack'];
    const p = player(sim);
    p.placement = { ...p.placement, x: 5.5, y: 1.5 };
    step(sim, { type: 'move', x: 0, y: 127 });
    expect(p.placement.y - 1.5).toBeCloseTo((8 / 60) * 0.5, 9);
  });
});

describe('the train is one interior', () => {
  it('walking through an end door carries you into the next car', () => {
    const sim = aboard();
    const p = player(sim);
    const train = S(sim).run!.trainId;
    p.placement = { ...p.placement, frame: `car:${train}:1`, x: 14.5, y: 2.5 };
    // -x is toward the rear.
    steps(sim, 20, { type: 'move', x: -127, y: 0 });
    expect(p.placement.frame).toBe(`car:${train}:2`);
    expect(p.placement.x).toBeGreaterThan(0);
    // The engine has no rear door: walking forward out of car 1 stops at its wall.
    p.placement = { ...p.placement, frame: `car:${train}:1`, x: 1.5, y: 2.5 };
    steps(sim, 60, { type: 'move', x: 127, y: 0 });
    expect(p.placement.frame).toBe(`car:${train}:1`);
  });
});

describe('trainMix', () => {
  const mixMap: SimMap = { ...map, trains: [{ type: 'blank', route: 'main', d: 0 }, { type: 'blank', route: 'main', d: 150 }] };
  const types = (cfg: SimConfig, m: SimMap = map, seed = 'mix') => {
    const sim = createSim({ config: cfg, map: m, seed, playerIds: [1] });
    return initialTrains(S(sim), sim.map, cfg).map((t) => t.type);
  };
  const mix = (mode: Values['trainMix']['mode'], blankShare = 0, trainCount = 4) =>
    mailConfig({}, { trainMix: { mode, mailTrain: 'mail', blankTrain: 'blank', trainCount, blankShare } });

  it('map uses the map own trains, or one mail train', () => {
    expect(types(mix('map'))).toEqual(['mail']);
    expect(types(mix('map'), mixMap)).toEqual(['blank', 'blank']);
  });

  it('all-mail, mixed and mostly-blank turn the slots into mail and blank trains, keeping one mail train', () => {
    expect(types(mix('all-mail'))).toEqual(['mail', 'mail', 'mail', 'mail']);
    expect(types(mix('all-mail'), mixMap)).toEqual(['mail', 'mail']);
    const mixed = types(mix('mixed', 0.5));
    expect(mixed.filter((t) => t === 'blank')).toHaveLength(2);
    expect(types(mix('mostly-blank', 1))).toEqual(expect.arrayContaining(['mail']));
    expect(types(mix('mostly-blank', 0.75)).filter((t) => t === 'blank')).toHaveLength(3);
    const sim = createSim({ config: mix('mixed', 0.5), map, seed: 'mix', playerIds: [1] });
    expect(S(sim).world.trains.filter((t) => t.type === 'blank')).toHaveLength(2);
  });
});
