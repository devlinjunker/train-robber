// One outlaw's life (roguelite): permadeath, dusk after the day's trains, riding off after the last day,
// and a resumed day.
import { describe, it, expect } from 'vitest';
import { createSim, type Command, type GameState, type Sim, type SimConfig, type SimEvent } from '../src';
import { testConfig, testMap } from './fixtures';

const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
const base = testConfig();
const withLife = (life: SimConfig['values']['life'], more: Partial<SimConfig['values']> = {}): SimConfig => ({ ...base, values: { ...base.values, life, ...more } });

/** Camping allowed anywhere, at once: no distance from the line, no train sight, a one-tick hold. */
const CAMP_ANYWHERE = { ...base.values.bank, atCamp: true, campHoldTicks: 1, campDistanceTiles: 0, campDistancePerWantedTiles: 0, trainSightTiles: 0, coverMinTiles: 0 };

const S = (sim: Sim) => sim.state as GameState;
const me = (sim: Sim) => S(sim).players[0]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const types = (ev: SimEvent[]) => ev.filter((e) => e.type === 'DayEnded' || e.type === 'DayStarted' || e.type === 'LifeEnded');

function setup(cfg: SimConfig, dayAtStart?: { day: number; health: number; trainsToday: number }): Sim {
  const sim = createSim({ config: cfg, map, seed: 'life', playerIds: [1], persistent: { wantedLevel: 2, bank: 300, lifetimeEarned: 500 }, ...(dayAtStart ? { dayAtStart } : {}) });
  S(sim).world.trains[0]!.d = 100;
  return sim;
}

/** Commit, then let the countdown run out: a run that played out (outcome expired). */
function expireRun(sim: Sim): SimEvent[] {
  const ev = step(sim, { type: 'startRun', trainId: 'blank-1' });
  expect(S(sim).run).not.toBeNull();
  S(sim).run!.countdownSec = 0;
  for (let i = 0; i < 400 && S(sim).run; i++) ev.push(...step(sim));
  expect(S(sim).run).toBeNull();
  return ev;
}

describe('life', () => {
  it('permadeath: dying ends the life, and a new outlaw starts on day 1 with bank and wanted at 0', () => {
    const sim = setup(withLife({ mode: 'permadeath', trainsPerDay: 0, days: 0 }), { day: 3, health: 100, trainsToday: 0 });
    me(sim).health = 0;
    const ev = step(sim);
    const tick = S(sim).tick - 1;
    expect(types(ev)).toEqual([
      { type: 'DayEnded', tick, player: 1, day: 3, cause: 'died', onRun: false },
      { type: 'LifeEnded', tick, player: 1, cause: 'died', days: 3, persistent: { wantedLevel: 2, bank: 300, lifetimeEarned: 500 } },
      { type: 'DayStarted', tick, player: 1, day: 1, health: 100 },
    ]);
    expect(S(sim).persistent).toEqual({ wantedLevel: 0, bank: 0, lifetimeEarned: 500 });
    expect(me(sim)).toMatchObject({ day: 1, health: 100, trainsToday: 0 });
  });

  it('day mode: dying only ends the day, as before', () => {
    const sim = setup(withLife({ mode: 'day', trainsPerDay: 0, days: 0 }));
    me(sim).health = 0;
    const ev = step(sim);
    expect(ev.some((e) => e.type === 'LifeEnded')).toBe(false);
    expect(me(sim)).toMatchObject({ day: 2, health: 100 });
    expect(S(sim).persistent).toEqual({ wantedLevel: 2, bank: 300, lifetimeEarned: 500 });
  });

  it('practice (wanted.forceLevel) never ends the life', () => {
    const sim = setup(withLife({ mode: 'permadeath', trainsPerDay: 0, days: 0 }, { wanted: { ...base.values.wanted, forceLevel: 1 } }));
    me(sim).health = 0;
    expect(step(sim).some((e) => e.type === 'LifeEnded')).toBe(false);
    expect(me(sim).day).toBe(2);
  });

  it('a run that plays out counts toward the day; a cancel does not', () => {
    const sim = setup(withLife({ mode: 'day', trainsPerDay: 0, days: 0 }));
    expireRun(sim);
    expect(me(sim).trainsToday).toBe(1);
    step(sim, { type: 'startRun', trainId: 'blank-1' });
    step(sim, { type: 'cancelRun' });
    expect(S(sim).run).toBeNull();
    expect(me(sim).trainsToday).toBe(1);
  });

  it('dusk: after the day\'s trains the day ends and the next starts at full health, where the rider is', () => {
    const sim = setup(withLife({ mode: 'day', trainsPerDay: 2, days: 0 }));
    expireRun(sim);
    me(sim).health = 40;
    const ev = expireRun(sim);
    const h = S(sim).world.horses[0]!;
    const at = { x: h.x, y: h.y };
    ev.push(...step(sim));
    expect(types(ev).map((e) => `${e.type}:${'cause' in e ? e.cause : ''}`)).toEqual(['DayEnded:dusk', 'DayStarted:']);
    expect(me(sim)).toMatchObject({ day: 2, health: 100, trainsToday: 0 });
    expect({ x: h.x, y: h.y }).toEqual(at);
    expect(S(sim).persistent.wantedLevel).toBeGreaterThanOrEqual(2);
  });

  it('a life of `days` days: surviving the last dusk rides off alive and starts a new outlaw', () => {
    const sim = setup(withLife({ mode: 'permadeath', trainsPerDay: 1, days: 2 }), { day: 2, health: 50, trainsToday: 0 });
    const ev = expireRun(sim);
    ev.push(...step(sim));
    const life = ev.find((e) => e.type === 'LifeEnded');
    expect(life).toMatchObject({ cause: 'rodeOff', days: 2 });
    expect(me(sim)).toMatchObject({ day: 1, health: 100, trainsToday: 0 });
    expect(S(sim).persistent.bank).toBe(0);
    expect(S(sim).persistent.wantedLevel).toBe(0);
  });

  it('making camp on the last day of a life rides off alive, after banking the saddlebag', () => {
    const bank = CAMP_ANYWHERE;
    const sim = setup(withLife({ mode: 'permadeath', trainsPerDay: 0, days: 2 }, { bank }), { day: 2, health: 30, trainsToday: 0 });
    me(sim).saddlebag = { value: 120, items: 2, runs: 1 };
    me(sim).campHeld = true;
    const ev = step(sim);
    expect(ev.map((e) => e.type).filter((t) => ['LootBanked', 'PersistentChanged', 'DayEnded', 'LifeEnded', 'DayStarted'].includes(t))).toEqual(['LootBanked', 'PersistentChanged', 'DayEnded', 'LifeEnded', 'DayStarted']);
    expect(ev.find((e) => e.type === 'DayEnded')).toMatchObject({ cause: 'camp', day: 2 });
    expect(ev.find((e) => e.type === 'LifeEnded')).toMatchObject({ cause: 'rodeOff', days: 2, persistent: { bank: 420, lifetimeEarned: 620 } });
    expect(S(sim).persistent).toEqual({ wantedLevel: 0, bank: 0, lifetimeEarned: 620 });
    // The next outlaw starts at the spawn, not camped where the last one left.
    expect(me(sim).campedAt).toBeNull();
  });

  it('making camp before the last day just starts the next day', () => {
    const bank = CAMP_ANYWHERE;
    const sim = setup(withLife({ mode: 'permadeath', trainsPerDay: 0, days: 3 }, { bank }), { day: 1, health: 30, trainsToday: 0 });
    me(sim).saddlebag = { value: 50, items: 1, runs: 1 };
    me(sim).campHeld = true;
    const ev = step(sim);
    expect(ev.some((e) => e.type === 'LifeEnded')).toBe(false);
    expect(me(sim)).toMatchObject({ day: 2, health: 100 });
    expect(me(sim).campedAt).not.toBeNull();
  });

  it('permadeath loses the saddlebag with the outlaw', () => {
    const sim = setup(withLife({ mode: 'permadeath', trainsPerDay: 0, days: 0 }));
    me(sim).saddlebag = { value: 80, items: 1, runs: 1 };
    me(sim).health = 0;
    const ev = step(sim);
    expect(ev.find((e) => e.type === 'SaddlebagLost')).toMatchObject({ value: 80 });
    expect(me(sim).saddlebag.value).toBe(0);
  });

  it('a resumed day starts where it was left, with health kept within 1 to max', () => {
    expect(me(setup(base, { day: 4, health: 37, trainsToday: 2 }))).toMatchObject({ day: 4, health: 37, trainsToday: 2 });
    expect(me(setup(base, { day: 2, health: 0, trainsToday: 0 })).health).toBe(1);
    expect(me(setup(base, { day: 2, health: 500, trainsToday: 0 })).health).toBe(100);
    expect(me(setup(base))).toMatchObject({ day: 1, health: 100, trainsToday: 0 });
  });
});
