// Phase 2 M3: light guards (spawns, patrol, sight, noise, awareness, the guardCatch variants)
// and the horse boost.
import { describe, it, expect } from 'vitest';
import {
  canSee, createSim, entryPointWorld, gridWalkable, guardCount, lineOfSight, toTrain, trainGrid,
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

function guardConfig(more: { ai?: Partial<Values['ai']>; train?: Partial<Values['trains'][string]>; horse?: Partial<Values['horse']> } = {}): SimConfig {
  const base = testConfig(more.horse ?? {});
  return testConfig(more.horse ?? {}, 'guard001', {
    carTemplates: { ...TEST_CARS, 'guard-car': GUARD_CAR, 'watch-car': WATCH_CAR },
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

  it('reads the count through guardCount, which adds no wanted level bonus until M5', () => {
    const cfg = guardConfig({ train: { guards: { base: 3 } } });
    expect(guardCount(cfg, 'mail', 0)).toBe(3);
    expect(guardCount(cfg, 'mail', 4)).toBe(3);
    expect(guardCount(cfg, 'blank', 2)).toBe(0);
    // perCar: about 2 guards for every 3 guarded cars, rounded.
    const per = guardConfig({ train: { carCount: 3, guards: { base: 0, perCar: 0.67 } } });
    expect(guardCount(per, 'mail', 0)).toBe(2);
    expect(guardCount(per, 'mail', 0, 6)).toBe(4);
    expect(guardCount(per, 'mail', 0, 1)).toBe(1);
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
  it('an alert guard chases, and contact throws the player off beside the car, stunned and hurt, keeping their loot', () => {
    const cfg = guardConfig({ ai: { guardCatch: 'thrown-off' }, train: { layouts: ['watch-car'] } });
    const sim = aboardAt(cfg, 5.5, 2.5);
    S(sim).run!.players[1]!.carried = ['letter'];
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
    expect(s.run!.players[1]!.carried).toEqual(['letter']);
    expect(s.run!.players[1]!.health).toBe(100 - 25);
    // The stun passes and the approach resumes.
    steps(sim, cfg.values.boarding.failure.stunTicks + 2);
    expect(s.run!.phase).toBe('approach');
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
