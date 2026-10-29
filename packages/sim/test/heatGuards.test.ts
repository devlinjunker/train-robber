// Phase 2 M6b: heat bands scale the guards, guards that went alert remember you, the run end's heat
// roll for wanted, the wanted decay rules and the End day key.
import { describe, it, expect } from 'vitest';
import {
  createSim, decayWanted, entryPointWorld, guardTuning, heatBandIndex, heatRollValue, runWantedLevel, tuningFor,
  type Command, type GameState, type GuardState, type PersistentState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { asciiCar, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap } from './fixtures';

type Values = SimConfig['values'];

/** A car with a wall across the middle (a door gap in rows 2 and 3) and a guard standing watch. */
const WATCH_CAR = asciiCar('guarded', ['#######DD#######', '#.......#......#', 'D..............D', 'D..............D', '#.......#......#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [7, 0] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 1], facing: 'left' }],
});

interface More { ai?: Partial<Values['ai']>; heatGuards?: boolean; guardMemory?: boolean; wanted?: Partial<Values['wanted']>; policy?: Partial<Values['outcomePolicy']>; playtest?: Partial<Values['playtest']> }

function m6bConfig(more: More = {}): SimConfig {
  const base = testConfig();
  const v = base.values;
  return testConfig({}, 'm6b0001', {
    carTemplates: { ...TEST_CARS, 'watch-car': WATCH_CAR },
    trains: { ...v.trains, mail: { ...TEST_MAIL_TRAIN, carType: 'guarded', layouts: ['watch-car'], carCount: 1, loot: undefined, guards: { base: 1 } } },
    trainMix: { ...v.trainMix, mailTrain: 'mail' },
    ai: {
      ...v.ai, ...more.ai,
      heatGuards: { ...v.ai.heatGuards, enabled: more.heatGuards ?? true },
      guardMemory: { ...v.ai.guardMemory, enabled: more.guardMemory ?? true },
    },
    wanted: { ...v.wanted, ...more.wanted },
    outcomePolicy: { ...v.outcomePolicy, ...more.policy },
    playtest: { ...v.playtest, ...more.playtest },
  });
}

const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const SAVE = (wantedLevel: number): PersistentState => ({ wantedLevel, bank: 0, lifetimeEarned: 0 });

function idle(cfg: SimConfig, persistent = SAVE(0), seed = 'm6b'): Sim {
  const sim = createSim({ config: cfg, map, seed, playerIds: [1], persistent });
  S(sim).world.trains[0]!.d = 100;
  return sim;
}

function committed(cfg: SimConfig, persistent = SAVE(0), seed = 'm6b'): Sim {
  const sim = idle(cfg, persistent, seed);
  step(sim, { type: 'startRun', trainId: S(sim).world.trains[0]!.id });
  expect(S(sim).run).not.toBeNull();
  return sim;
}

/** Boarded through car 1's left door; the player then stands still at (x, y) of car 1. */
function aboardAt(cfg: SimConfig, x: number, y: number): Sim {
  const sim = committed(cfg);
  const car = sim.cars()[1]!;
  const ep = entryPointWorld(car, { side: 'left', along: car.halfLength - 7.5 });
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
  p.move = { x: 0, y: 0 };
  return sim;
}

const guard = (sim: Sim): GuardState => S(sim).run!.guards[0]!;
function placeGuard(sim: Sim, x: number, y: number, fx: number, fy: number): GuardState {
  return Object.assign(guard(sim), { x, y, fx, fy, state: 'unaware', spotted: false, lastKnown: null, patrol: null, post: { car: 1, x, y, fx, fy } });
}

describe('heat bands', () => {
  const heat = testConfig().values.heat;
  it('split at heat.bandEdgeShares of max heat: low, mid, high', () => {
    expect([0, 33, 34, 66, 67, 100].map((h) => heatBandIndex(h, heat))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(heatBandIndex(20, { ...heat, bandEdgeShares: [0.2, 0.5] })).toBe(1);
    expect(heatBandIndex(50, { ...heat, maxHeat: 200 })).toBe(0);
  });

  it('scale every guard by band: sight +0/+2/+4, calm, search, hearing and chase', () => {
    const cfg = m6bConfig({ guardMemory: false });
    const ai = cfg.values.ai;
    const at = (h: number) => guardTuning(cfg, h);
    expect([at(0), at(50), at(90)].map((t) => t.sightBonusTiles)).toEqual([0, 2, 4]);
    expect([at(0), at(50), at(90)].map((t) => t.hearingScale)).toEqual([1, 1.15, 1.3]);
    expect([at(0), at(50), at(90)].map((t) => t.calmTicks)).toEqual([ai.calmTicks, ai.calmTicks + 60, ai.calmTicks + 120]);
    expect([at(0), at(50), at(90)].map((t) => t.alertCalmTicks)).toEqual([ai.alertCalmTicks, ai.alertCalmTicks + 60, ai.alertCalmTicks + 120]);
    expect(at(90).chaseSpeedTilesPerTick).toBeCloseTo(ai.chaseSpeedTilesPerTick + 1 / 60, 12);
    // Memory does nothing while guardMemory is off.
    expect(guardTuning(cfg, 0, true).sightBonusTiles).toBe(0);
  });

  it('are off with heatGuards off: the plain ai values at any heat', () => {
    const cfg = m6bConfig({ heatGuards: false, guardMemory: false });
    const ai = cfg.values.ai;
    expect(guardTuning(cfg, 100)).toEqual({ sightBonusTiles: 0, hearingScale: 1, calmTicks: ai.calmTicks, alertCalmTicks: ai.alertCalmTicks, chaseSpeedTilesPerTick: ai.chaseSpeedTilesPerTick });
  });

  it('let a guard at mid heat see 2 tiles farther in the car (range 7 + 2)', () => {
    // The guard at x 14.5 looks left down rows 2-3 through the door gap; the player stands 9 tiles away.
    const see = (heat: number, heatGuards = true) => {
      const sim = aboardAt(m6bConfig({ heatGuards, guardMemory: false }), 5.5, 2.5);
      placeGuard(sim, 14.5, 2.5, -1, 0);
      S(sim).run!.heat = heat;
      return ofType(step(sim), 'PlayerSpotted').length;
    };
    expect(see(0)).toBe(0);
    expect(see(50)).toBe(1);
    expect(see(50, false)).toBe(0);
  });
});

describe('guard memory', () => {
  it('a guard that goes alert remembers you past calming down, and sees 5 farther; a fresh guard does not', () => {
    const cfg = m6bConfig({ heatGuards: false });
    const ai = cfg.values.ai;
    const sim = aboardAt(cfg, 11.5, 2.5);
    placeGuard(sim, 14.5, 2.5, -1, 0);
    steps(sim, ai.alertAfterTicks + 2);
    expect(guard(sim).state).toBe('alert');
    expect(guard(sim).remembers).toBe(true);
    // Out of its sight behind the wall, it calms all the way down and still remembers.
    Object.assign(S(sim).players[0]!.placement, { x: 3.5, y: 1.5 });
    const calm = steps(sim, ai.alertCalmTicks + ai.calmTicks + 10);
    expect(ofType(calm, 'GuardStateChanged').map((e) => e.to)).toEqual(['suspicious', 'unaware']);
    expect(guard(sim).remembers).toBe(true);
    expect(tuningFor(cfg, S(sim).run, guard(sim))).toMatchObject({ sightBonusTiles: 5, hearingScale: 1.25, chaseSpeedTilesPerTick: ai.chaseSpeedTilesPerTick });
    // 11 tiles down the aisle: past the plain range of 7, inside 7 + 5.
    placeGuard(sim, 14.5, 2.5, -1, 0).remembers = true;
    Object.assign(S(sim).players[0]!.placement, { x: 3.5, y: 2.5 });
    expect(ofType(step(sim), 'PlayerSpotted')).toHaveLength(1);
    const fresh = aboardAt(cfg, 3.5, 2.5);
    placeGuard(fresh, 14.5, 2.5, -1, 0);
    expect(ofType(step(fresh), 'PlayerSpotted')).toHaveLength(0);
  });

  it('is not kept with guardMemory off, and a suspicious guard never remembers', () => {
    const off = aboardAt(m6bConfig({ heatGuards: false, guardMemory: false }), 11.5, 2.5);
    placeGuard(off, 14.5, 2.5, -1, 0);
    steps(off, 62);
    expect(guard(off).state).toBe('alert');
    expect(guard(off).remembers).toBeUndefined();
    const sus = aboardAt(m6bConfig({ heatGuards: false }), 11.5, 2.5);
    placeGuard(sus, 14.5, 2.5, -1, 0);
    step(sus);
    expect(guard(sus).state).toBe('suspicious');
    expect(guard(sus).remembers).toBeUndefined();
  });
});

describe('heat roll at the run end', () => {
  const rollCfg = (more: More = {}) => m6bConfig({ ...more, policy: { cancelled: { bankRunLoot: false, wantedDelta: 0, heatRoll: true }, ...more.policy } });
  const cancelAt = (cfg: SimConfig, heat: number, seed = 'm6b', persistent = SAVE(0)) => {
    const sim = committed(cfg, persistent, seed);
    S(sim).run!.heat = heat;
    const ev = step(sim, { type: 'cancelRun' });
    return { sim, end: ofType(ev, 'RunEnded')[0]!, changed: ofType(ev, 'PersistentChanged')[0]! };
  };

  it('is drawn from the run\'s own seed: the same for the same seed and run, different across seeds', () => {
    expect(heatRollValue('abc', 1)).toBe(heatRollValue('abc', 1));
    const rolls = new Set(Array.from({ length: 20 }, (_, i) => heatRollValue(`s${i}`, 1)));
    expect(rolls.size).toBe(20);
    for (const r of rolls) expect(r >= 0 && r < 1).toBe(true);
    const a = cancelAt(rollCfg(), 40, 'same'), b = cancelAt(rollCfg(), 40, 'same');
    expect(a.end.heatRoll).toEqual(b.end.heatRoll);
    expect(a.end.heatRoll).toEqual({ chance: 0.4, roll: heatRollValue('same', 1), hit: heatRollValue('same', 1) < 0.4 });
  });

  it('heat 0 never hits and max heat always does, adding wanted.perHeatRoll', () => {
    const cool = cancelAt(rollCfg(), 0);
    expect(cool.end.heatRoll).toMatchObject({ chance: 0, hit: false });
    expect(cool.changed.after.wantedLevel).toBe(0);
    const hot = cancelAt(rollCfg({ wanted: { perHeatRoll: 2 } }), 100);
    expect(hot.end.heatRoll).toMatchObject({ chance: 1, hit: true });
    expect(hot.changed.after.wantedLevel).toBe(2);
  });

  it('is skipped for an outcome whose heatRoll is off', () => {
    const r = cancelAt(m6bConfig(), 100);
    expect(r.end.heatRoll).toBeNull();
    expect(r.changed.after.wantedLevel).toBe(0);
  });

  it('expired still adds its +1 outright on top of the roll', () => {
    const cfg = rollCfg({ policy: { expired: { bankRunLoot: false, wantedDelta: 1, heatRoll: true } } });
    const sim = committed(cfg);
    S(sim).run!.heat = 100;
    S(sim).run!.countdownSec = 0.001;
    const ev = step(sim);
    expect(ofType(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'expired', heatRoll: { hit: true } });
    expect(ofType(ev, 'PersistentChanged')[0]!.after.wantedLevel).toBe(2);
  });
});

describe('wanted decay', () => {
  it('decayWanted: none keeps it, per-day takes decayPerDay off, per-quiet-day only after a quiet day, never below 0', () => {
    expect(decayWanted(3, 'none', 1, true)).toBe(3);
    expect(decayWanted(3, 'per-day', 1, false)).toBe(2);
    expect(decayWanted(3, 'per-day', 2, true)).toBe(1);
    expect(decayWanted(0, 'per-day', 1, true)).toBe(0);
    expect(decayWanted(3, 'per-quiet-day', 1, true)).toBe(2);
    expect(decayWanted(3, 'per-quiet-day', 1, false)).toBe(3);
  });

  it('per-day: End day takes a level off the save and says so', () => {
    const sim = idle(m6bConfig({ wanted: { decay: 'per-day' } }), SAVE(3));
    const ev = step(sim, { type: 'endDay' });
    expect(ofType(ev, 'WantedDecayed')).toEqual([{ type: 'WantedDecayed', tick: 0, player: 1, day: 2, rule: 'per-day', from: 3, to: 2 }]);
    expect(S(sim).persistent.wantedLevel).toBe(2);
  });

  it('none: the level stays and nothing is emitted', () => {
    const sim = idle(m6bConfig({ wanted: { decay: 'none' } }), SAVE(3));
    expect(ofType(step(sim, { type: 'endDay' }), 'WantedDecayed')).toEqual([]);
    expect(S(sim).persistent.wantedLevel).toBe(3);
  });

  it('per-quiet-day: a day where a run added wanted does not decay; the quiet day after does', () => {
    const cfg = m6bConfig({ wanted: { decay: 'per-quiet-day' } });
    const sim = committed(cfg, SAVE(3));
    S(sim).run!.countdownSec = 0.001;
    step(sim);
    expect(S(sim).persistent.wantedLevel).toBe(4);
    expect(ofType(step(sim, { type: 'endDay' }), 'WantedDecayed')).toEqual([]);
    expect(S(sim).persistent.wantedLevel).toBe(4);
    expect(ofType(step(sim, { type: 'endDay' }), 'WantedDecayed')).toMatchObject([{ from: 4, to: 3, rule: 'per-quiet-day' }]);
  });

  it('a forced practice level only moves with wanted.practiceMoves, and never touches the save', () => {
    const stillCfg = m6bConfig({ wanted: { forceLevel: 3, decay: 'per-day' } });
    const still = idle(stillCfg, SAVE(1));
    expect(ofType(step(still, { type: 'endDay' }), 'WantedDecayed')).toEqual([]);
    expect(runWantedLevel(S(still), stillCfg)).toBe(3);
    const movingCfg = m6bConfig({ wanted: { forceLevel: 3, decay: 'per-day', practiceMoves: true } });
    const moving = idle(movingCfg, SAVE(1));
    expect(ofType(step(moving, { type: 'endDay' }), 'WantedDecayed')).toMatchObject([{ from: 3, to: 2, practice: true }]);
    expect(runWantedLevel(S(moving), movingCfg)).toBe(2);
    expect(S(moving).persistent.wantedLevel).toBe(1);
    // A practice run that expires moves it back up, still unsaved.
    step(moving, { type: 'startRun', trainId: S(moving).world.trains[0]!.id });
    S(moving).run!.countdownSec = 0.001;
    expect(ofType(step(moving), 'PersistentChanged')[0]).toMatchObject({ practice: true, after: SAVE(1) });
    expect(runWantedLevel(S(moving), movingCfg)).toBe(3);
  });
});

describe('End day key (K)', () => {
  it('off a run: the same day end as death without dying: full health, day + 1, cause endDay', () => {
    const sim = idle(m6bConfig());
    const p = S(sim).players[0]!;
    p.health = 30;
    const ev = step(sim, { type: 'endDay' });
    expect(ofType(ev, 'DayEnded')).toEqual([{ type: 'DayEnded', tick: 0, player: 1, day: 1, cause: 'endDay', onRun: false }]);
    expect(ofType(ev, 'DayStarted')).toMatchObject([{ day: 2, health: 100 }]);
    expect([p.day, p.health]).toEqual([2, 100]);
  });

  it('is refused on a run, and when playtest.endDayKey is off', () => {
    const on = committed(m6bConfig());
    expect(ofType(step(on, { type: 'endDay' }), 'CommandRejected')).toMatchObject([{ command: 'endDay', reason: 'run active' }]);
    expect(S(on).players[0]!.day).toBe(1);
    const off = idle(m6bConfig({ playtest: { endDayKey: false } }));
    expect(ofType(step(off, { type: 'endDay' }), 'CommandRejected')).toMatchObject([{ command: 'endDay', reason: 'disabled' }]);
  });

  it('replays the same: two sims fed the same commands match hash for hash', () => {
    const cfg = m6bConfig({ wanted: { decay: 'per-day' } });
    const a = idle(cfg, SAVE(2)), b = idle(cfg, SAVE(2));
    for (const sim of [a, b]) { steps(sim, 10); step(sim, { type: 'endDay' }); steps(sim, 10); }
    expect(a.hash()).toBe(b.hash());
    expect(S(a).persistent.wantedLevel).toBe(1);
  });
});
