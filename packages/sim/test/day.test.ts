// G8 day clock: dusk marks the last train, nightfall stops new commits, a run on holds the clock,
// and the grace to make camp ends the day with part of the saddlebag lost.
import { describe, it, expect } from 'vitest';
import { createSim, type Command, type GameState, type Sim, type SimConfig, type SimEvent } from '../src';
import { DAY_OFF, testConfig, testMap } from './fixtures';

const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
const base = testConfig();
type Day = SimConfig['values']['day'];
// 60 Hz: dusk at tick 60, nightfall at 120, grace over at 180.
const SHORT: Day = { ...DAY_OFF, clock: true, lengthSec: 2, duskSec: 1, nightGraceSec: 1 };
const withDay = (day: Partial<Day> = {}, more: Partial<SimConfig['values']> = {}): SimConfig => ({ ...base, values: { ...base.values, day: { ...SHORT, ...day }, ...more } });

const S = (sim: Sim) => sim.state as GameState;
const me = (sim: Sim) => S(sim).players[0]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const run = (sim: Sim, n: number) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim)); return ev; };
const of = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

function setup(cfg: SimConfig, dayAtStart?: { day: number; health: number; trainsToday: number; dayTicks?: number }): Sim {
  const sim = createSim({ config: cfg, map, seed: 'day', playerIds: [1], persistent: { wantedLevel: 0, bank: 0, lifetimeEarned: 0 }, ...(dayAtStart ? { dayAtStart } : {}) });
  S(sim).world.trains[0]!.d = 100;
  return sim;
}

describe('day clock', () => {
  it('off (the base config): the clock never moves', () => {
    const sim = setup({ ...base, values: { ...base.values, day: DAY_OFF } });
    const ev = run(sim, 300);
    expect(me(sim).dayTicks).toBe(0);
    expect(of(ev, 'DuskStarted')).toEqual([]);
  });

  it('dusk marks the nearest free train as the last train, then nightfall comes', () => {
    const sim = setup(withDay());
    const ev = run(sim, 120);
    expect(of(ev, 'DuskStarted')).toEqual([{ type: 'DuskStarted', tick: 59, player: 1, day: 1, lastTrain: 'blank-1' }]);
    expect(S(sim).world.trains[0]!.lastTrain).toBe(true);
    expect(of(ev, 'Nightfall')).toEqual([{ type: 'Nightfall', tick: 119, player: 1, day: 1, onRun: false, graceSec: 1 }]);
  });

  it('after nightfall nothing new can be committed to', () => {
    const sim = setup(withDay());
    run(sim, 120);
    const ev = step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(S(sim).run).toBeNull();
    expect(of(ev, 'CommandRejected')[0]?.reason).toBe('nightfall');
  });

  it('when the grace runs out the day ends where you are and half the saddlebag is lost', () => {
    const sim = setup(withDay());
    run(sim, 120);
    me(sim).saddlebag = { value: 101, items: 3, runs: 1 };
    const h = S(sim).world.horses[0]!;
    const at = { x: h.x, y: h.y };
    const ev = run(sim, 60);
    expect(of(ev, 'SaddlebagLost')).toEqual([{ type: 'SaddlebagLost', tick: 179, player: 1, value: 50, items: 2, cause: 'nightfall' }]);
    expect(of(ev, 'DayEnded')).toEqual([{ type: 'DayEnded', tick: 179, player: 1, day: 1, cause: 'nightfall', onRun: false }]);
    expect(me(sim)).toMatchObject({ day: 2, dayTicks: 0, saddlebag: { value: 51, items: 1, runs: 1 } });
    expect({ x: h.x, y: h.y }).toEqual(at);
  });

  it('a run on at nightfall holds the clock; the grace starts once it ends', () => {
    const sim = setup(withDay());
    run(sim, 100);
    step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(S(sim).run).not.toBeNull();
    const held = run(sim, 200);
    expect(of(held, 'Nightfall')[0]?.onRun).toBe(true);
    expect(me(sim).dayTicks).toBe(120);
    expect(of(held, 'DayEnded')).toEqual([]);
    S(sim).run!.countdownSec = 0;
    const ev = run(sim, 400);
    expect(S(sim).run).toBeNull();
    const ended = of(ev, 'RunEnded')[0]!;
    const dayEnded = of(ev, 'DayEnded')[0]!;
    expect(dayEnded.cause).toBe('nightfall');
    // The run's last tick already counts as the first of the grace.
    expect(dayEnded.tick - ended.tick).toBe(59);
  });

  it('the last train starts hotter, carries an extra guard and pays the loot multiplier once', () => {
    const cfg = withDay({ lastTrain: { enabled: true, lootMult: 2, extraGuards: 1, startHeat: 10 } });
    const sim = setup(cfg);
    run(sim, 60);
    const ev = step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(of(ev, 'RunStarted')[0]?.lastTrain).toBe(true);
    expect(S(sim).run!.heat).toBe(10);
    S(sim).run!.countdownSec = 0;
    const end: SimEvent[] = [];
    for (let i = 0; i < 400 && S(sim).run; i++) end.push(...step(sim));
    const ended = of(end, 'RunEnded')[0]!;
    expect(ended.lastTrain).toBe(true);
    expect(ended.lootMultiplier).toBe(2);
    expect(S(sim).world.trains[0]!.lastTrain).toBeUndefined();
  });

  it('making camp, dying or a resumed day all go through the same clock', () => {
    const sim = setup(withDay(), { day: 3, health: 50, trainsToday: 1, dayTicks: 90 });
    expect(me(sim).dayTicks).toBe(90);
    me(sim).health = 0;
    step(sim);
    expect(me(sim)).toMatchObject({ day: 4, dayTicks: 1 });
  });

  it('practice marks no last train', () => {
    const sim = setup(withDay({}, { wanted: { ...base.values.wanted, forceLevel: 1 } }));
    const ev = run(sim, 60);
    expect(of(ev, 'DuskStarted')[0]?.lastTrain).toBeNull();
  });
});
