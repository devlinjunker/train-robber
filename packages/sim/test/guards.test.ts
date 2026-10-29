// Phase 2 M3: light guards (spawns, patrol, sight, noise, awareness, the guardCatch variants)
// and the horse boost.
import { describe, it, expect } from 'vitest';
import {
  canSee, createSim, entryPointWorld, gridWalkable, guardCount, isSearching, lineOfSight, noiseRadius, toTrain, trainGrid,
  type Command, type GameState, type GuardState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { asciiCar, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];

const AISLE = Array.from({ length: 9 }, (_, i) => [4 + i, 2] as [number, number]);
const GUARD_CAR = asciiCar('guarded', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [8, 0] }, { id: 'side-right', side: 'right', cell: [8, 5] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 2], facing: 'left', patrol: 'aisle' }],
  patrols: { aisle: AISLE },
});
/** The same car with a wall across the middle (a door gap in rows 2 and 3) and a guard standing watch. */
const WATCH_CAR = asciiCar('guarded', ['#######DD#######', '#.......#......#', 'D..............D', 'D..............D', '#.......#......#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [7, 0] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 1], facing: 'left' }],
});

/** A car with one crate in the middle of row 2, for cover; the guard stands watch. */
const COVER_CAR = asciiCar('guarded', ['#######DD#######', '#..............#', 'D.......C......D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [7, 0] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 2], facing: 'left' }],
});

function guardConfig(more: { ai?: Partial<Values['ai']>; train?: Partial<Values['trains'][string]>; horse?: Partial<Values['horse']> } = {}): SimConfig {
  const base = testConfig(more.horse ?? {});
  return testConfig(more.horse ?? {}, 'guard001', {
    carTemplates: { ...TEST_CARS, 'guard-car': GUARD_CAR, 'watch-car': WATCH_CAR, 'cover-car': COVER_CAR },
    trains: { ...base.values.trains, mail: { ...TEST_MAIL_TRAIN, carType: 'guarded', layouts: ['guard-car'], carCount: 1, loot: undefined, guards: { base: 1 }, ...more.train } },
    trainMix: { ...base.values.trainMix, mailTrain: 'mail' },
    ai: { ...base.values.ai, ...more.ai },
  });
}

const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number, ...commands: Command[]) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim, ...commands)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

function committed(cfg: SimConfig, seed = 'm3'): Sim {
  const sim = createSim({ config: cfg, map, seed, playerIds: [1] });
  S(sim).world.trains[0]!.d = 100;
  step(sim, { type: 'startRun', trainId: S(sim).world.trains[0]!.id });
  expect(S(sim).run).not.toBeNull();
  return sim;
}

/** Committed and boarded through car 1's left door, the stumble passed; the player then stands at (x, y) of car 1. */
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

const guard = (sim: Sim, i = 0): GuardState => S(sim).run!.guards[i]!;
/** Put the guard at (x, y) of its car facing (fx, fy), unaware. */
function placeGuard(sim: Sim, x: number, y: number, fx: number, fy: number): GuardState {
  const g = guard(sim);
  Object.assign(g, { x, y, fx, fy });
  return g;
}

describe('guard spawns', () => {
  it('places guards.base guards on the layouts\' spawns, at most one per spawn, the same for the same seed', () => {
    const cfg = guardConfig({ train: { carCount: 3, guards: { base: 2 } } });
    const a = committed(cfg), b = committed(cfg);
    expect(S(a).run!.guards).toHaveLength(2);
    expect(S(a).run!.guards).toEqual(S(b).run!.guards);
    const cars = S(a).run!.guards.map((g) => g.car);
    expect(new Set(cars).size).toBe(2);
    for (const g of S(a).run!.guards) expect({ x: g.x, y: g.y, state: g.state, patrol: g.patrol }).toEqual({ x: 12.5, y: 2.5, state: 'unaware', patrol: 'aisle' });
    // More guards than spawns: every spawn gets one.
    expect(S(committed(guardConfig({ train: { carCount: 3, guards: { base: 9 } } }))).run!.guards).toHaveLength(3);
    // A train type without guards gets none.
    expect(S(committed(guardConfig({ train: { guards: undefined } }))).run!.guards).toEqual([]);
  });

  it('reads the count through guardCount, with no wanted level bonus at level 0', () => {
    const cfg = guardConfig({ train: { guards: { base: 3 } } });
    expect(guardCount(cfg, 'mail', 0)).toBe(3);
    expect(guardCount(cfg, 'blank', 0)).toBe(0);
    // perCar: about 2 guards for every 3 guarded cars, rounded.
    const per = guardConfig({ train: { carCount: 3, guards: { base: 0, perCar: 0.67 } } });
    expect(guardCount(per, 'mail', 0)).toBe(2);
    expect(guardCount(per, 'mail', 0, 6)).toBe(4);
    expect(guardCount(per, 'mail', 0, 1)).toBe(1);
  });
});

describe('wanted level guards (phase 2 M5)', () => {
  const table = (perWantedLevel?: number) => guardConfig({ train: { carCount: 3, guards: { base: 0, perCar: 0.67, ...(perWantedLevel === undefined ? {} : { perWantedLevel }) } } });

  it('adds wanted.guardBonus[level] at each level 0 to 5, and the last entry past the end', () => {
    const cfg = table();
    // wanted.guardBonus [0, 1, 1, 2, 2, 3] on top of the 2 guards at level 0.
    expect([0, 1, 2, 3, 4, 5, 6].map((l) => guardCount(cfg, 'mail', l))).toEqual([2, 3, 3, 4, 4, 5, 5]);
    // A train with no guards still gets the wanted bonus: wanted level means more guards everywhere.
    expect(guardCount(cfg, 'blank', 3)).toBe(2);
  });

  it('adds trains.<id>.guards.perWantedLevel x level, rounded', () => {
    const cfg = table(0.5);
    expect([0, 1, 2, 3, 4, 5].map((l) => guardCount(cfg, 'mail', l))).toEqual([2, 4, 4, 6, 6, 8]);
  });

  it('spawns more guards at a higher saved level, and wanted.forceLevel overrides the save', () => {
    const base = guardConfig({ train: { carCount: 3, guards: { base: 1 } } });
    const at = (level: number, force: number | null = null) => {
      const cfg = testConfig({}, 'guardw01', { ...base.values, wanted: { ...base.values.wanted, forceLevel: force } });
      const sim = createSim({ config: cfg, map, seed: 'wanted', playerIds: [1], persistent: { wantedLevel: level, bank: 0, lifetimeEarned: 0 } });
      S(sim).world.trains[0]!.d = 100;
      step(sim, { type: 'startRun', trainId: S(sim).world.trains[0]!.id });
      return S(sim).run!.guards.length;
    };
    // Three guarded cars with one spawn each: level 0 has 1 guard, level 1 adds 1, level 3 adds 2.
    expect(at(0)).toBe(1);
    expect(at(1)).toBe(2);
    expect(at(3)).toBe(3);
    // More guards than spawns: capped at the spawns.
    expect(at(5)).toBe(3);
    // A forced level wins over the saved one.
    expect(at(0, 1)).toBe(2);
    expect(at(3, 0)).toBe(1);
  });
});

describe('patrol and watch', () => {
  it('an unaware guard walks its route back and forth on walkable cells, pausing at the ends', () => {
    const cfg = guardConfig();
    const sim = committed(cfg);
    const train = S(sim).world.trains[0]!;
    const grid = trainGrid(cfg, train.cars);
    const xs: number[] = [];
    for (let t = 0; t < 60 * 20; t++) {
      step(sim);
      const g = guard(sim);
      expect(gridWalkable(grid, toTrain(grid, g.car, g.x), g.y)).toBe(true);
      expect(g.y).toBeCloseTo(2.5, 9);
      xs.push(g.x);
    }
    // It started facing the front (left), so it walks to the route's front end, then back to its rear end.
    expect(Math.min(...xs)).toBeCloseTo(4.5, 6);
    expect(Math.max(...xs)).toBeCloseTo(12.5, 6);
    // 8 tiles at 1.5 tiles/s takes 5.3 s; the pause holds it at the end.
    const atEnd = xs.filter((x) => Math.abs(x - 4.5) < 1e-9).length;
    expect(atEnd).toBeGreaterThanOrEqual(cfg.values.ai.patrolPauseTicks);
  });

  it('a guard without a patrol stands watch at its spawn, facing its way', () => {
    const cfg = guardConfig({ train: { layouts: ['watch-car'] } });
    const sim = committed(cfg);
    steps(sim, 120);
    const g = guard(sim);
    expect({ x: g.x, y: g.y, fx: g.fx, fy: g.fy, patrol: g.patrol }).toEqual({ x: 12.5, y: 1.5, fx: -1, fy: 0, patrol: null });
  });
});

describe('sight', () => {
  const cfg = guardConfig({ train: { layouts: ['watch-car'] } });
  const grid = trainGrid(cfg, ['engine', 'watch-car']);
  const ai = cfg.values.ai;
  const at = (x: number) => toTrain(grid, 1, x);

  it('sees inside the cone and range, not behind or past the range', () => {
    // Facing the front (-x) from (12.5, 2.5) of the watch car.
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(9.5), 2.5)).toBe(true);
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(14.5), 2.5)).toBe(false);
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(12.5), 4.5)).toBe(false);
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(12.5 - 7.5), 2.5)).toBe(false);
  });

  it('cells that block sight stop it, the cells at either end do not', () => {
    // The wall at column 8 of rows 1 and 4 hides (7.5, 1.5) from (12.5, 1.5).
    expect(lineOfSight(grid, at(12.5), 1.5, at(6.5), 1.5)).toBe(false);
    expect(canSee(grid, ai, at(12.5), 1.5, -1, 0, at(6.5), 1.5)).toBe(false);
    expect(lineOfSight(grid, at(12.5), 2.5, at(6.5), 2.5)).toBe(true);
    // A player standing in a doorway can be seen.
    expect(lineOfSight(grid, at(12.5), 2.5, at(15.5), 2.5)).toBe(true);
    // Through the end door into the engine: the door blocks.
    expect(lineOfSight(grid, at(12.5), 2.5, toTrain(grid, 0, 14.5), 2.5)).toBe(false);
  });

  it('spotting the player raises playerSpotted heat once and makes the guard suspicious; more sight raises the alarm', () => {
    const sim = aboardAt(cfg, 9.5, 1.5);
    placeGuard(sim, 12.5, 1.5, -1, 0);
    const ev = step(sim);
    expect(ofType(ev, 'PlayerSpotted')).toHaveLength(1);
    expect(ofType(ev, 'HeatChanged').map((e) => [e.cause, e.delta])).toEqual([['playerSpotted', 5]]);
    expect(guard(sim).state).toBe('suspicious');
    // Seen for alertAfterTicks more: alert, with the alarm's heat, and no second spotted heat.
    const later = steps(sim, cfg.values.ai.alertAfterTicks);
    expect(ofType(later, 'PlayerSpotted')).toHaveLength(0);
    expect(ofType(later, 'GuardStateChanged').map((e) => [e.from, e.to, e.cause])).toEqual([['suspicious', 'alert', 'sight']]);
    expect(ofType(later, 'HeatChanged').map((e) => e.cause)).toEqual(['alarmRaised']);
    expect(S(sim).run!.heat).toBe(20);
    // heat-only: the alert guard stays put, facing the player.
    const g = guard(sim);
    expect({ x: g.x, y: g.y }).toEqual({ x: 12.5, y: 1.5 });
    expect(ofType(steps(sim, 120), 'ThrownOff')).toHaveLength(0);
  });

  it('breaking line of sight before the alarm lets a suspicious guard calm down', () => {
    const sim = aboardAt(cfg, 9.5, 1.5);
    placeGuard(sim, 12.5, 1.5, -1, 0);
    steps(sim, 10);
    expect(guard(sim).state).toBe('suspicious');
    // Behind the wall.
    S(sim).players[0]!.placement.x = 6.5;
    const ev = steps(sim, cfg.values.ai.calmTicks + 5);
    expect(ofType(ev, 'GuardStateChanged').map((e) => [e.to, e.cause])).toEqual([['unaware', 'calm']]);
    expect(guard(sim).spotted).toBe(false);
  });
});

describe('noise', () => {
  const cfg = guardConfig({ train: { layouts: ['watch-car'] } });

  it('running behind a guard within the run radius makes it suspicious without spotted heat; standing still is silent', () => {
    const quiet = aboardAt(cfg, 14.5, 2.5);
    placeGuard(quiet, 11.5, 2.5, -1, 0);
    expect(ofType(steps(quiet, 30), 'GuardStateChanged')).toHaveLength(0);

    const loud = aboardAt(cfg, 14.5, 2.5);
    placeGuard(loud, 11.5, 2.5, -1, 0);
    // Running on the spot into the rear wall: footsteps carry 5 tiles.
    const ev = step(loud, { type: 'move', x: -127, y: 0 });
    expect(ofType(ev, 'GuardStateChanged').map((e) => [e.to, e.cause])).toEqual([['suspicious', 'noise']]);
    expect(ofType(ev, 'HeatChanged')).toHaveLength(0);
    // It turns to look, then sees the player and spots them.
    const after = steps(loud, 60, { type: 'move', x: 0, y: 0 });
    expect(ofType(after, 'PlayerSpotted')).toHaveLength(1);
  });

  it('walking is quieter than running', () => {
    const sim = aboardAt(cfg, 14.5, 2.5);
    placeGuard(sim, 11.5, 2.5, -1, 0);
    // Half axis, as the client walks: 1.5 tiles does not reach 3 tiles away.
    expect(ofType(steps(sim, 10, { type: 'move', x: -64, y: 0 }), 'GuardStateChanged')).toHaveLength(0);
  });
});

describe('guardCatch thrown-off', () => {
  it('an alert guard chases, and contact throws the player off beside the car, stunned and hurt, losing half their loot', () => {
    const cfg = guardConfig({ ai: { guardCatch: 'thrown-off' }, train: { layouts: ['watch-car'] } });
    const sim = aboardAt(cfg, 5.5, 2.5);
    S(sim).run!.players[1]!.carried = ['letter', 'letter', 'letter'];
    placeGuard(sim, 12.5, 2.5, -1, 0);
    const ev = steps(sim, 60 * 6);
    const thrown = ofType(ev, 'ThrownOff');
    expect(thrown).toHaveLength(1);
    expect(ofType(ev, 'DamageDealt').map((e) => e.cause)).toEqual(['thrownOff']);
    const s = S(sim);
    const t = ev.indexOf(thrown[0]!);
    expect(ev.slice(t).find((e) => e.type === 'RunPhaseChanged')).toMatchObject({ from: 'aboard', to: 'boarding' });
    expect(s.players[0]!.placement.frame).toBe('world');
    expect(s.world.horses[0]!.mode).toBe('physical');
    // Half of three, rounded up: two (picked at random) go over the side, one is kept.
    expect(s.run!.players[1]!.carried).toEqual(['letter']);
    expect(ofType(ev, 'LootLost').map((e) => [e.item, e.cause])).toEqual([['letter', 'thrownOff'], ['letter', 'thrownOff']]);
    expect(s.players[0]!.health).toBe(100 - 25);
    // The stun passes and the approach resumes.
    steps(sim, cfg.values.boarding.failure.stunTicks + 2);
    expect(s.run!.phase).toBe('approach');
  });
});

describe('F after being thrown off (cash out)', () => {
  const thrownOff = (cashOut: Partial<Values['cashOut']> = {}) => {
    const base = guardConfig({ ai: { guardCatch: 'thrown-off', thrownOffLootShare: 0 }, train: { layouts: ['watch-car'] } });
    const cfg = { ...base, values: { ...base.values, cashOut: { ...base.values.cashOut, ...cashOut } } };
    const sim = aboardAt(cfg, 5.5, 2.5);
    S(sim).run!.players[1]!.carried = ['letter', 'letter'];
    placeGuard(sim, 12.5, 2.5, -1, 0);
    expect(ofType(steps(sim, 60 * 6), 'ThrownOff')).toHaveLength(1);
    return { sim, value: 2 * cfg.values.items.letter!.value, trainId: S(sim).run!.trainId };
  };
  it('ends the run cashedOut, banking the loot carried, and the train shuts its doors', () => {
    const { sim, value, trainId } = thrownOff();
    expect(value).toBeGreaterThan(0);
    const ev = step(sim, { type: 'cashOut' });
    expect(ofType(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'cashedOut', cashOut: value });
    expect(ofType(ev, 'PersistentChanged')[0]!.after).toMatchObject({ bank: value, lifetimeEarned: value });
    expect(S(sim).run).toBeNull();
    expect(S(sim).players[0]!.placement.frame).toBe('world');
    // The doors stay shut: committing to that train is refused.
    const again = step(sim, { type: 'startRun', trainId });
    expect(ofType(again, 'CommandRejected')[0]).toMatchObject({ command: 'startRun', reason: 'doors closed' });
    expect(S(sim).run).toBeNull();
  });
  it('banks only what is left after the throw took its share (thrownOffLootShare), through applyOutcome', () => {
    const base = guardConfig({ ai: { guardCatch: 'thrown-off', thrownOffLootShare: 0.5 }, train: { layouts: ['watch-car'] } });
    const sim = aboardAt(base, 5.5, 2.5);
    S(sim).persistent = { wantedLevel: 1, bank: 10, lifetimeEarned: 100 };
    S(sim).run!.players[1]!.carried = ['letter', 'letter', 'letter', 'letter'];
    placeGuard(sim, 12.5, 2.5, -1, 0);
    const lost = ofType(steps(sim, 60 * 6), 'LootLost');
    expect(lost).toHaveLength(2);
    const left = 2 * base.values.items.letter!.value;
    const ev = step(sim, { type: 'cashOut' });
    expect(ofType(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'cashedOut', cashOut: left });
    expect(ofType(ev, 'PersistentChanged')[0]).toMatchObject({ outcome: 'cashedOut', before: { wantedLevel: 1, bank: 10, lifetimeEarned: 100 }, after: { wantedLevel: 1, bank: 10 + left, lifetimeEarned: 100 + left } });
  });
  it('thrown off with nothing left and the doors shut ends the run caught, wanted +1 (PR #46 playtest)', () => {
    const base = guardConfig({ ai: { guardCatch: 'thrown-off', thrownOffLootShare: 1 }, train: { layouts: ['watch-car'] } });
    const sim = aboardAt(base, 5.5, 2.5);
    S(sim).persistent = { wantedLevel: 1, bank: 10, lifetimeEarned: 10 };
    S(sim).run!.players[1]!.carried = ['letter', 'letter'];
    placeGuard(sim, 12.5, 2.5, -1, 0);
    const ev = steps(sim, 60 * 6);
    expect(ofType(ev, 'LootLost')).toHaveLength(2);
    expect(ofType(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'caught', cashOut: 0 });
    expect(ofType(ev, 'PersistentChanged')[0]).toMatchObject({ outcome: 'caught', after: { wantedLevel: 2, bank: 10, lifetimeEarned: 10 } });
    expect(S(sim).run).toBeNull();
    // The rider stays on the horse beside the track, not sent back to the spawn.
    expect(S(sim).players[0]!.placement.frame).toBe('world');
    // With the doors left open the run goes on: you can jump back on.
    const open = guardConfig({ ai: { guardCatch: 'thrown-off', thrownOffLootShare: 1 }, train: { layouts: ['watch-car'] } });
    const cfg = { ...open, values: { ...open.values, cashOut: { ...open.values.cashOut, closeDoorsOnThrownOff: false } } };
    const sim2 = aboardAt(cfg, 5.5, 2.5);
    placeGuard(sim2, 12.5, 2.5, -1, 0);
    expect(ofType(steps(sim2, 60 * 6), 'RunEnded')).toHaveLength(0);
    expect(S(sim2).run).not.toBeNull();
  });
  it('a wanted.forceLevel run is practice: RunEnded says what it would bank, but the save stays as it was (G9)', () => {
    const base = guardConfig({ ai: { guardCatch: 'thrown-off', thrownOffLootShare: 0 }, train: { layouts: ['watch-car'] } });
    const cfg = { ...base, values: { ...base.values, wanted: { ...base.values.wanted, forceLevel: 2 } } };
    const sim = aboardAt(cfg, 5.5, 2.5);
    const saved = { wantedLevel: 0, bank: 10, lifetimeEarned: 100 };
    S(sim).persistent = { ...saved };
    S(sim).run!.players[1]!.carried = ['letter', 'letter'];
    placeGuard(sim, 12.5, 2.5, -1, 0);
    steps(sim, 60 * 6);
    const ev = step(sim, { type: 'cashOut' });
    expect(ofType(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'cashedOut', cashOut: 2 * cfg.values.items.letter!.value, practice: true });
    expect(ofType(ev, 'PersistentChanged')[0]).toMatchObject({ practice: true, before: saved, after: saved });
    expect(S(sim).persistent).toEqual(saved);
  });
  it('with doorsReopenTicks the doors open again after that long; without closeDoors they never shut', () => {
    const { sim, trainId } = thrownOff({ doorsReopenTicks: 30 });
    step(sim, { type: 'cashOut' });
    const t = S(sim).world.trains.find((q) => q.id === trainId)!;
    expect(t.doorsClosed?.untilTick).toBe(S(sim).tick + 29);
    S(sim).tick += 40;
    expect(ofType(step(sim, { type: 'startRun', trainId }), 'CommandRejected').map((e) => e.reason)).not.toContain('doors closed');
    const open = thrownOff({ closeDoors: false, closeDoorsOnThrownOff: false });
    step(open.sim, { type: 'cashOut' });
    expect(S(open.sim).world.trains.find((q) => q.id === open.trainId)!.doorsClosed).toBeUndefined();
  });
  it('being thrown off shuts the doors (closeDoorsOnThrownOff): no jump back on, the meter parks', () => {
    const { sim, trainId } = thrownOff();
    expect(S(sim).world.trains.find((q) => q.id === trainId)!.doorsClosed).toEqual({ untilTick: null });
    steps(sim, 200);
    expect(S(sim).run!.phase).toBe('approach');
    const ev = step(sim, { type: 'jump' });
    expect(ofType(ev, 'CommandRejected')[0]).toMatchObject({ command: 'jump', reason: 'doors closed' });
    expect(S(sim).run!.players[1]!.meter.phase).toBe(0);
    // Off, the doors stay open after a throw.
    const open = thrownOff({ closeDoorsOnThrownOff: false });
    expect(S(open.sim).world.trains.find((q) => q.id === open.trainId)!.doorsClosed).toBeUndefined();
  });
  it('is refused aboard, with nothing carried, and when disabled; Esc still banks nothing', () => {
    const aboard = aboardAt(guardConfig({ train: { layouts: ['watch-car'] } }), 5.5, 2.5);
    S(aboard).run!.players[1]!.carried = ['letter'];
    expect(ofType(step(aboard, { type: 'cashOut' }), 'CommandRejected')[0]).toMatchObject({ reason: 'not mounted' });
    const empty = thrownOff();
    S(empty.sim).run!.players[1]!.carried = [];
    expect(ofType(step(empty.sim, { type: 'cashOut' }), 'CommandRejected')[0]).toMatchObject({ reason: 'nothing to cash out' });
    const off = thrownOff({ enabled: false });
    expect(ofType(step(off.sim, { type: 'cashOut' }), 'CommandRejected')[0]).toMatchObject({ reason: 'disabled' });
    const esc = thrownOff();
    expect(ofType(step(esc.sim, { type: 'cancelRun' }), 'RunEnded')[0]).toMatchObject({ outcome: 'cancelled', cashOut: 0 });
    expect(S(esc.sim).persistent.bank).toBe(0);
  });
});

describe('thrownOffLootShare', () => {
  it('0 keeps everything, 1 loses everything', () => {
    for (const [share, kept] of [[0, 2], [1, 0]] as const) {
      const cfg = guardConfig({ ai: { guardCatch: 'thrown-off', thrownOffLootShare: share }, train: { layouts: ['watch-car'] } });
      const sim = aboardAt(cfg, 5.5, 2.5);
      S(sim).run!.players[1]!.carried = ['letter', 'letter'];
      placeGuard(sim, 12.5, 2.5, -1, 0);
      const ev = steps(sim, 60 * 6);
      expect(ofType(ev, 'ThrownOff')).toHaveLength(1);
      expect(ofType(ev, 'LootLost')).toHaveLength(2 - kept);
      // Losing everything with the doors shut ends the run caught; keeping some, it goes on.
      if (kept > 0) expect(S(sim).run!.players[1]!.carried).toHaveLength(kept);
      else expect(S(sim).run).toBeNull();
    }
  });
});

describe('crouching and cover', () => {
  const cfg = guardConfig({ train: { layouts: ['cover-car'] } });
  const grid = trainGrid(cfg, ['engine', 'cover-car']);
  const ai = cfg.values.ai;
  const at = (x: number) => toTrain(grid, 1, x);

  it('a crate between them hides a crouched player, not a standing one, and only when it is on the line', () => {
    // Guard at (12.5, 2.5) facing the front; the crate is cell (8, 2).
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(6.5), 2.5)).toBe(true);
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(6.5), 2.5, true)).toBe(false);
    // Crouched in the next row, the line passes beside the crate.
    expect(canSee(grid, ai, at(12.5), 2.5, -1, 0, at(6.5), 3.6, true)).toBe(true);
    // Raising crouchCoverMin past the crate's 0.5 makes it too low to hide behind.
    expect(canSee(grid, { ...ai, sight: { ...ai.sight, crouchCoverMin: 0.6 } }, at(12.5), 2.5, -1, 0, at(6.5), 2.5, true)).toBe(true);
  });

  it('C aboard crouches: no spotting from behind cover, a slow creep however hard you push, and almost no noise', () => {
    const sim = aboardAt(cfg, 6.5, 2.5);
    placeGuard(sim, 12.5, 2.5, -1, 0);
    step(sim, { type: 'crouch', on: true });
    expect(S(sim).run!.players[1]!.crouched).toBe(true);
    expect(ofType(steps(sim, 30), 'PlayerSpotted')).toHaveLength(0);
    // Running crouched toward the front: player.crouch.speedScale of full speed.
    const p = S(sim).players[0]!;
    const x0 = p.placement.x;
    steps(sim, 10, { type: 'move', x: 127, y: 0 });
    expect(x0 - p.placement.x).toBeCloseTo(10 * cfg.values.player.speedTilesPerTick * cfg.values.player.crouch.speedScale, 6);
    expect(noiseRadius(cfg, grid, p, at(p.placement.x), true)).toBeCloseTo(ai.noise.crouchRadiusTiles, 9);
    // Standing up in the open: seen.
    S(sim).players[0]!.placement.x = 6.5;
    step(sim, { type: 'move', x: 0, y: 0 });
    expect(ofType(step(sim, { type: 'crouch', on: false }), 'PlayerSpotted')).toHaveLength(1);
  });

  it('searching loot carries searchRadiusTiles, crouched or still, between walking and running', () => {
    const sim = aboardAt(cfg, 6.5, 2.5);
    const p = S(sim).players[0]!;
    const { noise } = cfg.values.ai;
    expect(noise.searchRadiusTiles).toBeGreaterThan(noise.walkRadiusTiles);
    expect(noise.searchRadiusTiles).toBeLessThan(noise.runRadiusTiles);
    expect(noiseRadius(cfg, grid, p, at(p.placement.x), false, true)).toBe(noise.searchRadiusTiles);
    expect(noiseRadius(cfg, grid, p, at(p.placement.x), true, true)).toBe(noise.searchRadiusTiles);
    expect(noiseRadius(cfg, grid, p, at(p.placement.x), false, false)).toBe(0);
    // Stumbling after a good landing is as loud as running, standing still or not.
    expect(noiseRadius(cfg, grid, p, at(p.placement.x), false, false, true)).toBe(noise.stumbleRadiusTiles);
    expect(noiseRadius(cfg, grid, p, at(p.placement.x), true, false, true)).toBe(noise.stumbleRadiusTiles);
  });

  it('crouched footsteps behind a guard go unheard where running ones are heard', () => {
    const watch = guardConfig({ train: { layouts: ['watch-car'] } });
    const sim = aboardAt(watch, 14.5, 2.5);
    placeGuard(sim, 11.5, 2.5, -1, 0);
    step(sim, { type: 'crouch', on: true });
    // Pushing into the rear wall at full: crouched, it carries 0.3 tiles, not 5.
    expect(ofType(steps(sim, 30, { type: 'move', x: -127, y: 0 }), 'GuardStateChanged')).toHaveLength(0);
  });

  it('crouch is refused off the train and cleared when you leave it', () => {
    const sim = committed(cfg);
    expect(ofType(step(sim, { type: 'crouch', on: true }), 'CommandRejected')[0]).toMatchObject({ command: 'crouch', reason: 'not aboard' });
    const thrown = guardConfig({ ai: { guardCatch: 'thrown-off' }, train: { layouts: ['watch-car'] } });
    const aboard = aboardAt(thrown, 5.5, 2.5);
    // Loot left after the throw keeps the run going, so its state can be read.
    S(aboard).run!.players[1]!.carried = ['letter', 'letter'];
    placeGuard(aboard, 12.5, 2.5, -1, 0);
    // Seen standing, then crouched in the open: the guard still sees and catches.
    steps(aboard, 30);
    step(aboard, { type: 'crouch', on: true });
    expect(ofType(steps(aboard, 60 * 6), 'ThrownOff')).toHaveLength(1);
    expect(S(aboard).run!.players[1]!.crouched).toBe(false);
  });
});

describe('losing the player', () => {
  it('a chasing guard with no sight or sound of the player for loseSightSec gives up: still alert, it walks at patrol speed to where it last knew they were and does not catch', () => {
    const cfg = guardConfig({ ai: { guardCatch: 'thrown-off' }, train: { layouts: ['watch-car'] } });
    // The player is out of range in the far corner, standing still.
    const sim = aboardAt(cfg, 1.5, 1.5);
    const g = placeGuard(sim, 14.5, 3.5, 1, 0);
    Object.assign(g, { state: 'alert', spotted: true, lastKnown: { car: 1, x: 9.5, y: 3.5 } });
    const ai = cfg.values.ai;
    // Chasing at chase speed toward the last known spot first.
    steps(sim, 10);
    expect(14.5 - guard(sim).x).toBeGreaterThan(9 * ai.chaseSpeedTilesPerTick);
    const ev = steps(sim, ai.loseSightTicks - 10);
    expect(ofType(ev, 'GuardLostTrack')).toEqual([{ type: 'GuardLostTrack', tick: S(sim).tick - 1, guard: 0 }]);
    expect(isSearching(guard(sim), cfg)).toBe(true);
    expect(guard(sim).state).toBe('alert');
    // Searching, it catches no one, and it drops back to suspicious once alertCalmTicks pass.
    const later = steps(sim, ai.alertCalmTicks - ai.loseSightTicks + 2);
    expect(ofType(later, 'ThrownOff')).toHaveLength(0);
    expect(ofType(later, 'GuardStateChanged').map((e) => [e.from, e.to, e.cause])).toEqual([['alert', 'suspicious', 'calm']]);
    expect(isSearching(guard(sim), cfg)).toBe(false);
  });

  it('seeing the player again while searching resumes the chase', () => {
    const cfg = guardConfig({ ai: { guardCatch: 'thrown-off' }, train: { layouts: ['watch-car'] } });
    const sim = aboardAt(cfg, 1.5, 1.5);
    const g = placeGuard(sim, 12.5, 2.5, -1, 0);
    Object.assign(g, { state: 'alert', spotted: true, lastKnown: { car: 1, x: 12.5, y: 2.5 }, lostTicks: cfg.values.ai.loseSightTicks });
    expect(isSearching(g, cfg)).toBe(true);
    // Step into view in front of it.
    S(sim).players[0]!.placement = { ...S(sim).players[0]!.placement, x: 9.5, y: 2.5 };
    step(sim);
    expect(guard(sim).lostTicks).toBe(0);
    expect(ofType(steps(sim, 60 * 3), 'ThrownOff')).toHaveLength(1);
  });
});

describe('horse boost', () => {
  const moving = (cfg: SimConfig) => {
    const sim = createSim({ config: cfg, map, seed: 'b', playerIds: [1] });
    // Ride along the top straight at top speed.
    Object.assign(S(sim).world.horses[0]!, { x: 60, y: 10, hx: 1, hy: 0, speed: 14 });
    return sim;
  };

  it('C bursts above top speed for the duration, then reins back in, with a cooldown', () => {
    const cfg = testConfig();
    const sim = moving(cfg);
    const ev = step(sim, { type: 'boost' }, { type: 'move', x: 0, y: -127 });
    expect(ofType(ev, 'HorseBoosted')).toHaveLength(1);
    let top = 0;
    for (let i = 0; i < 89; i++) { step(sim); top = Math.max(top, S(sim).world.horses[0]!.speed); }
    expect(top).toBeCloseTo(14 * 1.4, 9);
    // A second press while it runs is refused.
    expect(ofType(step(sim, { type: 'boost' }), 'CommandRejected')[0]).toMatchObject({ reason: 'cooling down' });
    steps(sim, 60);
    expect(S(sim).world.horses[0]!.speed).toBeCloseTo(14, 9);
    expect(S(sim).world.horses[0]!.boostCooldownTicks).toBeGreaterThan(0);
    steps(sim, cfg.values.horse.boost.cooldownTicks);
    expect(ofType(step(sim, { type: 'boost' }), 'HorseBoosted')).toHaveLength(1);
  });

  it('handlingModel arcade has no boost', () => {
    const sim = moving(testConfig({ boost: { ...testConfig().values.horse.boost, enabled: false } }));
    expect(ofType(step(sim, { type: 'boost' }), 'CommandRejected')[0]).toMatchObject({ reason: 'disabled' });
    steps(sim, 30, { type: 'move', x: 0, y: -127 });
    expect(S(sim).world.horses[0]!.speed).toBe(14);
  });

  it('only a ridden horse boosts', () => {
    const cfg = guardConfig();
    const sim = aboardAt(cfg, 5.5, 2.5);
    expect(ofType(step(sim, { type: 'boost' }), 'CommandRejected')[0]).toMatchObject({ reason: 'not mounted' });
  });
});
