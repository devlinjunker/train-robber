// Phase 2 M1: the countdown from commit, heat through raiseHeat and its drain, the expired
// outcome, the grace hook, and what RunStarted and RunEnded carry.
import { describe, it, expect } from 'vitest';
import {
  applyOutcome, boardingResistanceActive, createSim, drainRate, entryPointWorld, raiseHeat, raiseHeatFor, restoreSim,
  type Command, type GameState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { testConfig, testMap } from './fixtures';

const config = testConfig();
const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
type Values = SimConfig['values'];

function setup(cfg: SimConfig = config): Sim {
  const sim = createSim({ config: cfg, map, seed: 'm1', playerIds: [1] });
  (sim.state as GameState).world.trains[0]!.d = 100;
  return sim;
}
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim)); return ev; };
const of = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const withValues = (more: Partial<Values>, hash = 'heat0001') => testConfig({}, hash, more);
const heatCfg = (over: Partial<Values['heat']> = {}, sources: Partial<Values['heat']['sources']> = {}): Values['heat'] => {
  const h = config.values.heat;
  return { ...h, ...over, sources: { ...h.sources, ...sources } };
};

function committed(cfg: SimConfig = config): Sim {
  const sim = setup(cfg);
  step(sim, { type: 'interact', held: true });
  return sim;
}

/** Committed and landed aboard car 1 with a perfect jump. */
function aboard(cfg: SimConfig = config): Sim {
  const sim = committed(cfg);
  const car = sim.cars()[1]!;
  const ep = entryPointWorld(car, { side: 'left', along: 0 });
  const h = S(sim).world.horses[0]!;
  Object.assign(h, { x: ep.x + car.uy, y: ep.y - car.ux, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
  step(sim);
  const rp = S(sim).run!.players[1]!;
  rp.meter.zoneCentre = 0.5; rp.meter.phase = 0.25;
  step(sim, { type: 'jump' });
  expect(S(sim).run!.phase).toBe('aboard');
  return sim;
}

describe('countdown', () => {
  it('starts at commit with the train\'s baseSec x countdown.scale, and RunStarted carries it and the wanted level', () => {
    const cfg = withValues({ countdown: { ...config.values.countdown, scale: 4 } });
    const sim = setup(cfg);
    const ev = step(sim, { type: 'interact', held: true });
    expect(of(ev, 'RunStarted')[0]).toMatchObject({ countdownSec: 600, wantedLevel: 0 });
    expect(S(sim).run).toMatchObject({ countdownTotalSec: 600, clockRunning: true, heat: 0 });
    // The commit tick already drains one tick.
    expect(S(sim).run!.countdownSec).toBeCloseTo(600 - 1 / 60, 9);
    steps(sim, 59);
    expect(S(sim).run!.countdownSec).toBeCloseTo(599, 9);
  });

  it('with countdown.enabled off never drains or expires, and the events carry null', () => {
    const cfg = withValues({ countdown: { ...config.values.countdown, enabled: false } });
    const sim = setup(cfg);
    const ev = step(sim, { type: 'interact', held: true });
    expect(of(ev, 'RunStarted')[0]!.countdownSec).toBeNull();
    S(sim).run!.countdownSec = 0.01;
    steps(sim, 120);
    expect(S(sim).run).not.toBeNull();
    expect(of(step(sim, { type: 'cancelRun' }), 'RunEnded')[0]!.countdownLeftSec).toBeNull();
  });

  it('with startsAt boarding waits until the player lands aboard', () => {
    const cfg = withValues({ countdown: { ...config.values.countdown, startsAt: 'boarding' } });
    const sim = committed(cfg);
    steps(sim, 30);
    expect(S(sim).run).toMatchObject({ clockRunning: false, countdownSec: 150 });
    const on = aboard(cfg);
    expect(on.state.run!.clockRunning).toBe(true);
    expect(on.state.run!.countdownSec).toBeLessThan(150);
  });

  it('expires at zero: RunEnded expired with 0 left, wanted level +1, and the player back at the spawn', () => {
    const sim = aboard();
    S(sim).run!.countdownSec = 2 / 60 + 1e-9;
    const before = steps(sim, 1);
    expect(of(before, 'RunEnded')).toEqual([]);
    const ev = steps(sim, 2);
    expect(of(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'expired', countdownLeftSec: 0, heat: 0, retry: false });
    expect(of(ev, 'PersistentChanged')[0]).toMatchObject({ before: { wantedLevel: 0 }, after: { wantedLevel: 1 } });
    expect(S(sim).run).toBeNull();
    expect(S(sim).persistent.wantedLevel).toBe(1);
    expect(S(sim).players[0]!.placement).toMatchObject({ frame: 'world', x: SPAWN.x, y: SPAWN.y });
    expect(S(sim).world.trains[0]!.pinnedBy).toBeNull();
  });

  it('a death on the same tick as expiry counts as the death', () => {
    const sim = aboard();
    S(sim).run!.countdownSec = 0.001;
    S(sim).run!.players[1]!.health = 0;
    expect(of(step(sim), 'RunEnded')[0]!.outcome).toBe('died');
  });

  it('cancels keep their time left and heat in RunEnded (U6)', () => {
    const sim = committed();
    steps(sim, 59);
    step(sim, { type: 'debugHeat' });
    const end = of(step(sim, { type: 'cancelRun' }), 'RunEnded')[0]!;
    expect(end.outcome).toBe('cancelled');
    expect(end.countdownLeftSec).toBeGreaterThan(148.9);
    expect(end.countdownLeftSec).toBeLessThan(149);
    expect(end.heat).toBe(10);
  });

  it('with no horse alongside the grace window does not apply, so expiry is not delayed', () => {
    const sim = aboard();
    S(sim).run!.countdownSec = 0.001;
    expect(of(step(sim), 'RunEnded')[0]!.outcome).toBe('expired');
  });

  it('applyOutcome adds outcomePolicy.expired.wantedDelta', () => {
    expect(applyOutcome({ wantedLevel: 2, bank: 50, lifetimeEarned: 90 }, 'expired', config.values.outcomePolicy)).toEqual({ wantedLevel: 3, bank: 50, lifetimeEarned: 90 });
  });
});

describe('heat', () => {
  it('drains the countdown at 1 + heatDrainFactor x heat/100', () => {
    expect(drainRate(0, heatCfg())).toBe(1);
    expect(drainRate(60, heatCfg())).toBeCloseTo(1.6, 12);
    expect(drainRate(100, heatCfg({ heatDrainFactor: 2 }))).toBe(3);
    const sim = committed();
    S(sim).run!.heat = 50;
    const t0 = S(sim).run!.countdownSec;
    steps(sim, 60);
    expect(t0 - S(sim).run!.countdownSec).toBeCloseTo(1.5, 9);
  });

  it('raiseHeat clamps at maxHeat and emits HeatChanged with what was added and why', () => {
    const sim = committed();
    const events: SimEvent[] = [];
    const ctx = { state: S(sim), config, emit: (e: SimEvent) => void events.push(e) };
    expect(raiseHeatFor(ctx, 'alarmRaised')).toBe(15);
    S(sim).run!.heat = 95;
    expect(raiseHeat(ctx, 15, 'alarmRaised')).toBe(5);
    expect(raiseHeat(ctx, 3, 'lootTaken')).toBe(0);
    expect(raiseHeat(ctx, -4, 'debug')).toBe(0);
    expect(events).toEqual([
      { type: 'HeatChanged', tick: S(sim).tick, heat: 15, delta: 15, cause: 'alarmRaised' },
      { type: 'HeatChanged', tick: S(sim).tick, heat: 100, delta: 5, cause: 'alarmRaised' },
    ]);
  });

  it('there is no heat without a run', () => {
    const sim = setup();
    const ctx = { state: S(sim), config, emit: () => {} };
    expect(raiseHeat(ctx, 10, 'debug')).toBe(0);
  });

  it('the debug command raises heat by playtest.debugHeatStep, and is refused without a run or when the step is 0', () => {
    const sim = committed();
    const ev = step(sim, { type: 'debugHeat' });
    expect(of(ev, 'HeatChanged')).toMatchObject([{ heat: 10, delta: 10, cause: 'debug' }]);
    expect(of(step(sim, { type: 'debugHeat', source: 'alarmRaised' }), 'HeatChanged')).toMatchObject([{ heat: 25, delta: 15, cause: 'alarmRaised' }]);
    expect(of(step(sim, { type: 'debugHeat', source: 'bogus' as never }), 'HeatChanged')).toMatchObject([{ heat: 35, delta: 10, cause: 'debug' }]);
    const idle = setup();
    expect(of(step(idle, { type: 'debugHeat' }), 'CommandRejected')[0]).toMatchObject({ command: 'debugHeat', reason: 'no run' });
    const off = committed(withValues({ playtest: { ...config.values.playtest, debugHeatStep: 0 } }));
    expect(of(step(off, { type: 'debugHeat' }), 'CommandRejected')[0]).toMatchObject({ command: 'debugHeat', reason: 'disabled' });
  });

  it('time aboard adds no heat by default', () => {
    const sim = aboard();
    expect(of(steps(sim, 600), 'HeatChanged')).toEqual([]);
  });

  it('heat.sources.timeAboardPerSec adds heat a whole point at a time while aboard only', () => {
    const cfg = withValues({ heat: heatCfg({}, { timeAboardPerTick: 0.2 / 60 }) });
    const approaching = committed(cfg);
    expect(of(steps(approaching, 600), 'HeatChanged')).toEqual([]);
    const sim = aboard(cfg);
    const gains = of(steps(sim, 60 * 10 + 5), 'HeatChanged');
    expect(gains.map((g) => [g.delta, g.cause])).toEqual([[1, 'timeAboard'], [1, 'timeAboard']]);
    expect(S(sim).run!.heat).toBe(2);
  });

  it('boardingResistanceAt is a hook that is off by default', () => {
    const sim = committed();
    S(sim).run!.heat = 100;
    expect(boardingResistanceActive(S(sim).run, config.values.heat)).toBe(false);
    expect(boardingResistanceActive(S(sim).run, heatCfg({ boardingResistanceAt: 80 }))).toBe(true);
    S(sim).run!.heat = 79;
    expect(boardingResistanceActive(S(sim).run, heatCfg({ boardingResistanceAt: 80 }))).toBe(false);
  });

  it('heat and the countdown survive a snapshot round trip', () => {
    const sim = committed();
    step(sim, { type: 'debugHeat' });
    steps(sim, 30);
    const copy = restoreSim(sim.snapshot(), config, map);
    steps(sim, 90); steps(copy, 90);
    expect(copy.hash()).toBe(sim.hash());
    expect(copy.state.run!.heat).toBe(10);
  });
});
