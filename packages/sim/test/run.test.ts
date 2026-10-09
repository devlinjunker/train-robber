// M3: committing, the boarding rule and meter, landings, health and death, cancel, quick
// retry, the car frame aboard, and snapshots taken mid-boarding.
import { describe, it, expect } from 'vitest';
import {
  applyOutcome, boardingCheck, carToWorld, commitTarget, createSim, entryPointWorld, meterPosition, meterResult, meterZones, restoreSim, trackAt,
  type Command, type GameState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { testConfig, testMap } from './fixtures';

const config = testConfig();
// The spawn sits 5 tiles above the top straight, level with car 1 once the train is placed.
const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);

/** A sim with the train's engine front at d = 100: x = 140 on the top straight, heading right. */
function setup(cfg: SimConfig = config): Sim {
  const sim = createSim({ config: cfg, map, seed: 'm3', playerIds: [1] });
  (sim.state as GameState).world.trains[0]!.d = 100;
  return sim;
}

const S = (sim: Sim) => sim.state as GameState;
const horse = (sim: Sim) => S(sim).world.horses[0]!;
const rp = (sim: Sim) => S(sim).run!.players[1]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim)); return ev; };
const rejections = (ev: SimEvent[]) => ev.flatMap((e) => (e.type === 'CommandRejected' ? [`${e.command}: ${e.reason}`] : []));
const phases = (ev: SimEvent[]) => ev.flatMap((e) => (e.type === 'RunPhaseChanged' ? [`${e.from}>${e.to}`] : []));

/** Put the horse beside car 1's door on the given side, `gap` tiles out, matching the train at `speed`. */
function alongside(sim: Sim, side: 'left' | 'right' = 'left', speed = 9, gap = 1): void {
  const car = sim.cars()[1]!;
  const ep = entryPointWorld(car, { side, along: 0 });
  const s = side === 'left' ? 1 : -1;
  Object.assign(horse(sim), { x: ep.x + car.uy * gap * s, y: ep.y - car.ux * gap * s, hx: car.ux, hy: car.uy, speed, cruiseTarget: speed });
}

/** Committed, beside car 1's left door and eligible. */
function approach(cfg: SimConfig = config): Sim {
  const sim = setup(cfg);
  step(sim, { type: 'interact', held: false });
  alongside(sim);
  step(sim);
  return sim;
}

/** Jump with the marker set so the sample lands in `zone` (zones centred at 0.5). */
const SWEEP = { perfect: 18, good: 22, fail: 30 } as const;
function jump(sim: Sim, zone: keyof typeof SWEEP): SimEvent[] {
  rp(sim).meter.zoneCentre = 0.5;
  rp(sim).meter.sweep = SWEEP[zone];
  return step(sim, { type: 'jump' });
}

describe('commit', () => {
  it('the commit query names the free train in range, and nothing when far or committed', () => {
    const sim = setup();
    expect(commitTarget(S(sim), sim.map, config, horse(sim))).toBe('blank-1');
    Object.assign(horse(sim), { x: 116, y: 10 }); // 17 tiles from the car
    expect(commitTarget(S(sim), sim.map, config, horse(sim))).toBeNull();
    Object.assign(horse(sim), { x: 116, y: 22 });
    step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(commitTarget(S(sim), sim.map, config, horse(sim))).toBeNull();
  });

  it('startRun pins the train, fills health and enters approach', () => {
    const sim = setup();
    const ev = step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(ev.map((e) => e.type)).toEqual(['RunStarted', 'RunPhaseChanged']);
    expect(phases(ev)).toEqual(['idle>approach']);
    expect(S(sim).run).toMatchObject({ trainId: 'blank-1', phase: 'approach', players: { 1: { health: 100, boardingAttempts: 0 } } });
    expect(S(sim).world.trains[0]!.pinnedBy).toBe(1);
  });

  it('interact while idle commits like startRun with no id', () => {
    const sim = setup();
    expect(phases(step(sim, { type: 'interact', held: false }))).toEqual(['idle>approach']);
    expect(rejections(step(sim, { type: 'interact', held: false }))).toEqual(['interact: nothing to interact with']);
  });

  it('rejects out of range, a taken train, an unknown train and a second run', () => {
    const sim = setup();
    Object.assign(horse(sim), { x: 116, y: 10 });
    expect(rejections(step(sim, { type: 'startRun', trainId: 'blank-1' }))).toEqual(['startRun: out of range']);
    expect(rejections(step(sim, { type: 'startRun' }))).toEqual(['startRun: no train in range']);
    Object.assign(horse(sim), { x: 116, y: 22 });
    expect(rejections(step(sim, { type: 'startRun', trainId: 'mail-9' }))).toEqual(['startRun: no such train']);
    S(sim).world.trains[0]!.pinnedBy = 2;
    expect(rejections(step(sim, { type: 'startRun', trainId: 'blank-1' }))).toEqual(['startRun: train taken']);
    S(sim).world.trains[0]!.pinnedBy = null;
    step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(rejections(step(sim, { type: 'startRun', trainId: 'blank-1' }))).toEqual(['startRun: run active']);
    expect(S(sim).run).not.toBeNull();
  });
});

describe('boarding rule', () => {
  it('a jump with no run is rejected', () => {
    expect(rejections(step(setup(), { type: 'jump' }))).toEqual(['jump: no run']);
  });

  it('is eligible beside a door on either side at train speed', () => {
    for (const side of ['left', 'right'] as const) {
      const sim = setup();
      step(sim, { type: 'interact', held: false });
      alongside(sim, side);
      const c = boardingCheck(S(sim), sim.map, config, 'blank-1', horse(sim));
      expect(c).toMatchObject({ state: 'eligible', side, car: 1, entry: `side-${side}` });
      expect(c.distance).toBeCloseTo(1, 9);
      expect(c.speedDelta).toBeCloseTo(0, 9);
    }
  });

  it('rejects a jump too far, too fast and too slow, measuring speed along the car', () => {
    const cases: [string, (sim: Sim) => void][] = [
      ['too far', (sim) => alongside(sim, 'left', 9, 3)],
      ['too fast', (sim) => alongside(sim, 'left', 11.5)],
      ['too slow', (sim) => alongside(sim, 'left', 6.5)],
      // 9 tiles/s at 45 degrees off the track is 6.4 along it.
      ['too slow', (sim) => { alongside(sim, 'left', 9); Object.assign(horse(sim), { hx: Math.SQRT1_2, hy: -Math.SQRT1_2 }); }],
    ];
    for (const [reason, place] of cases) {
      const sim = setup();
      step(sim, { type: 'interact', held: false });
      place(sim);
      expect(rejections(step(sim, { type: 'jump' }))).toEqual([`jump: ${reason}`]);
      expect(S(sim).run!.phase).toBe('approach');
      expect(rp(sim).boardingAttempts).toBe(0);
    }
  });

  it('only counts doors on the side the horse is riding', () => {
    const sim = setup();
    step(sim, { type: 'interact', held: false });
    alongside(sim, 'left', 9, 1);
    // Across the car the right door is 7 tiles away; it never stands in for the left one.
    const c = boardingCheck(S(sim), sim.map, config, 'blank-1', horse(sim));
    expect(c.side).toBe('left');
    Object.assign(horse(sim), { y: horse(sim).y - 2 });
    expect(boardingCheck(S(sim), sim.map, config, 'blank-1', horse(sim))).toMatchObject({ state: 'too far', side: 'left', entry: 'side-left' });
  });
});

describe('meter', () => {
  it('sweeps back and forth over the period', () => {
    expect([0, 18, 36, 54, 72, 90].map((s) => meterPosition(s, 72))).toEqual([0, 0.5, 1, 0.5, 0, 0.5]);
  });

  it('centres the perfect zone in the good zone and reads each zone', () => {
    const m = { sweep: 0, zoneCentre: 0.5 };
    const z = meterZones(m, [0.1, 0.25]);
    expect(z.perfect[0]).toBeCloseTo(0.45, 12); expect(z.perfect[1]).toBeCloseTo(0.55, 12);
    expect(z.good[0]).toBeCloseTo(0.375, 12); expect(z.good[1]).toBeCloseTo(0.625, 12);
    for (const [zone, sweep] of Object.entries(SWEEP)) expect(meterResult({ ...m, sweep }, 72, [0.1, 0.25]).result).toBe(zone);
  });

  it('sweeps only while eligible, and losing eligibility restarts the sweep but keeps the zones', () => {
    const sim = approach();
    const centre = rp(sim).meter.zoneCentre;
    expect(rp(sim).meter.sweep).toBe(1);
    steps(sim, 10);
    expect(rp(sim).meter.sweep).toBe(11);
    horse(sim).speed = 13;
    step(sim);
    expect(rp(sim).meter.sweep).toBe(0);
    expect(rp(sim).meter.zoneCentre).toBe(centre);
  });

  it('places the zones at random inside the track, re-rolled only after a jump resolves', () => {
    const sim = approach();
    const centres = new Set<number>();
    const first = rp(sim).meter.zoneCentre;
    // A rejected jump keeps the zones.
    horse(sim).speed = 13;
    step(sim, { type: 'jump' });
    expect(rp(sim).meter.zoneCentre).toBe(first);
    for (let i = 0; i < 6; i++) {
      alongside(sim);
      const before = rp(sim).meter.zoneCentre;
      centres.add(before);
      expect(before - 0.125).toBeGreaterThanOrEqual(0);
      expect(before + 0.125).toBeLessThanOrEqual(1);
      rp(sim).meter.sweep = 30;
      rp(sim).meter.zoneCentre = 0.1; // marker at 0.83: a sure fail
      step(sim, { type: 'jump' });
      expect(rp(sim).meter.zoneCentre).not.toBe(0.1);
      rp(sim).health = 100;
      steps(sim, 91);
      expect(S(sim).run!.phase).toBe('approach');
    }
    expect(centres.size).toBe(6);
  });
});

describe('landings', () => {
  it('perfect: into the car frame at the entry cell, clean, with the horse abstract', () => {
    const sim = approach();
    const ev = jump(sim, 'perfect');
    expect(phases(ev)).toEqual(['approach>boarding', 'boarding>aboard']);
    expect(ev.find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'perfect', attempt: 1, meter: 0.5 });
    expect(S(sim).players[0]!.placement).toEqual({ frame: 'car:blank-1:1', x: 8.5, y: 0.5, layer: 'interior' });
    expect(horse(sim)).toMatchObject({ mode: 'away', speed: 0 });
    expect(rp(sim)).toMatchObject({ stumbleTicks: 0, health: 100 });
    // The entry cell sits just inside the door, where the boarding rule measured.
    const at = sim.world.toWorld(S(sim), S(sim).players[0]!.placement);
    const ep = entryPointWorld(sim.cars()[1]!, { side: 'left', along: 0 });
    expect(Math.hypot(at.x - ep.x, at.y - ep.y)).toBeLessThan(1);
  });

  it('good: aboard with a stumble at half walk speed for stumbleSec', () => {
    const sim = approach();
    expect(jump(sim, 'good').find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'good' });
    expect(S(sim).run!.phase).toBe('aboard');
    // stumbleSec counts from the landing tick.
    expect(rp(sim).stumbleTicks).toBe(29);
    const p = S(sim).players[0]!.placement;
    step(sim, { type: 'move', x: 0, y: 127 }); // toward the right side, into the car
    expect(p.y - 0.5).toBeCloseTo(4 / 60, 12);
    steps(sim, 28);
    expect(rp(sim).stumbleTicks).toBe(0);
    const y = p.y;
    step(sim);
    expect(p.y - y).toBeCloseTo(8 / 60, 12);
  });

  it('fail: thrown clear, horse stunned at half speed, damage dealt, then approach again', () => {
    const sim = approach();
    const ev = jump(sim, 'fail');
    expect(phases(ev)).toEqual(['approach>boarding']);
    expect(ev.find((e) => e.type === 'DamageDealt')).toMatchObject({ target: 1, amount: 25, health: 75 });
    expect(horse(sim)).toMatchObject({ mode: 'physical', speed: 4.5, stunTicks: 90 });
    expect(S(sim).players[0]!.placement.frame).toBe('world');
    // Stunned: the throttle and steering do nothing and the speed holds at half.
    const hy = horse(sim).hy;
    step(sim, { type: 'move', x: 127, y: -127 });
    expect(rejections(step(sim, { type: 'jump' }))).toEqual(['jump: stunned']);
    const ev2 = steps(sim, 87);
    expect(horse(sim)).toMatchObject({ speed: 4.5, hy, stunTicks: 1 });
    expect(phases(ev2)).toEqual([]);
    expect(phases(step(sim))).toEqual(['boarding>approach']);
    // The train pulled ahead: about 4.5 tiles/s x 1.5 s.
    expect(boardingCheck(S(sim), sim.map, config, 'blank-1', horse(sim)).state).toBe('too far');
    step(sim);
    expect(horse(sim).speed).toBeGreaterThan(4.5); // the rider has the reins back
  });

  it('time-only failure costs no health', () => {
    const sim = approach(testConfig({}, 'test0002', { boarding: { ...config.values.boarding, failure: { stunTicks: 90, damageFraction: 0, horseSpeedScale: 0.5 } } }));
    const ev = jump(sim, 'fail');
    expect(ev.some((e) => e.type === 'DamageDealt')).toBe(false);
    expect(rp(sim).health).toBe(100);
  });
});

describe('health and death', () => {
  it('a fourth failed jump kills: outcome died, then the cancel reset', () => {
    const sim = approach();
    S(sim).persistent = { wantedLevel: 2, bank: 50, lifetimeEarned: 70 };
    for (let i = 0; i < 3; i++) { jump(sim, 'fail'); steps(sim, 90); alongside(sim); }
    expect(rp(sim).health).toBe(25);
    const ev = jump(sim, 'fail');
    expect(phases(ev)).toEqual(['approach>boarding', 'boarding>ended', 'ended>idle']);
    expect(ev.find((e) => e.type === 'RunEnded')).toMatchObject({ outcome: 'died', boardingAttempts: 4, retry: false });
    expect(S(sim).run).toBeNull();
    expect(horse(sim)).toMatchObject({ x: SPAWN.x, y: SPAWN.y, hx: 0, hy: -1, speed: 0, stunTicks: 0, mode: 'physical' });
    expect(S(sim).world.trains[0]!.pinnedBy).toBeNull();
    // alpha-default's died policy changes nothing persistent in phase 1.
    expect(S(sim).persistent).toEqual({ wantedLevel: 2, bank: 50, lifetimeEarned: 70 });
    // Health is refilled at the next run's start.
    step(sim, { type: 'startRun', trainId: 'blank-1' });
    expect(rp(sim).health).toBe(100);
  });

  it('applyOutcome follows outcomePolicy', () => {
    const before = { wantedLevel: 2, bank: 100, lifetimeEarned: 300 };
    const policy = { ...config.values.outcomePolicy, died: { bankRunLoot: false, wantedDelta: -1, bankLossFraction: 0.25, reset: ['wantedLevel'] as const } };
    expect(applyOutcome(before, 'died', policy)).toEqual({ wantedLevel: 0, bank: 75, lifetimeEarned: 300 });
    expect(applyOutcome(before, 'cancelled', policy)).toEqual(before);
  });
});

/** Drive a sim into each phase. */
const IN_PHASE: Record<string, () => Sim> = {
  idle: () => setup(),
  approach: () => approach(),
  boarding: () => { const sim = approach(); jump(sim, 'fail'); return sim; },
  aboard: () => { const sim = approach(); jump(sim, 'perfect'); return sim; },
};

describe('cancel', () => {
  for (const phase of ['approach', 'boarding', 'aboard']) {
    it(`from ${phase}: back to playerSpawn, mounted and stopped; the train keeps looping, unpinned`, () => {
      const sim = IN_PHASE[phase]!();
      const d = S(sim).world.trains[0]!.d;
      const ev = step(sim, { type: 'cancelRun' });
      expect(phases(ev)).toEqual([`${phase}>ended`, 'ended>idle']);
      expect(ev.find((e) => e.type === 'RunEnded')).toMatchObject({ outcome: 'cancelled', retry: false });
      expect(ev.some((e) => e.type === 'RunCancelled')).toBe(true);
      expect(S(sim).run).toBeNull();
      expect(horse(sim)).toMatchObject({ x: SPAWN.x, y: SPAWN.y, speed: 0, stunTicks: 0, mode: 'physical' });
      expect(S(sim).players[0]!.placement).toEqual({ frame: 'world', x: SPAWN.x, y: SPAWN.y, layer: 'ground' });
      expect(S(sim).world.trains[0]).toMatchObject({ pinnedBy: null });
      expect(S(sim).world.trains[0]!.d).toBeCloseTo(d + 9 / 60, 9);
    });
  }
  it('is rejected while idle', () => {
    expect(rejections(step(setup(), { type: 'cancelRun' }))).toEqual(['cancelRun: no run']);
  });
});

describe('quick retry', () => {
  for (const phase of ['idle', 'approach', 'boarding', 'aboard']) {
    for (const side of ['left', 'right'] as const) {
      it(`from ${phase} on the ${side}: ends any run, horse stopped 60 tiles behind the train on the same side`, () => {
        const sim = IN_PHASE[phase]!();
        if (phase === 'aboard') S(sim).players[0]!.placement.y = side === 'left' ? 1.5 : 4.5;
        else alongside(sim, side, horse(sim).speed);
        const ev = step(sim, { type: 'quickRetry' });
        expect(rejections(ev)).toEqual([]);
        if (phase !== 'idle') expect(ev.find((e) => e.type === 'RunEnded')).toMatchObject({ outcome: 'cancelled', retry: true });
        expect(S(sim).run).toBeNull();
        expect(S(sim).world.trains[0]!.pinnedBy).toBeNull();
        const h = horse(sim);
        expect(h).toMatchObject({ speed: 0, stunTicks: 0, mode: 'physical' });
        expect(S(sim).players[0]!.placement).toMatchObject({ frame: 'world', x: h.x, y: h.y });
        // 60 tiles behind the 64-tile train, 1.5 tiles out from its side, on the same side as before.
        // Commands apply before the train advances this tick.
        const at = trackAt(map.routes[0]!, S(sim).world.trains[0]!.d - 9 / 60 - 64 - 60);
        expect(h.hx * at.tx + h.hy * at.ty).toBeCloseTo(1, 9);
        expect(Math.hypot(h.x - at.x, h.y - at.y)).toBeCloseTo(4.5, 9);
        const left = (h.x - at.x) * at.ty - (h.y - at.y) * at.tx > 0;
        expect(left ? 'left' : 'right').toBe(side);
      });
    }
  }
  it('is rejected when playtest.quickRetry is off', () => {
    const sim = approach(testConfig({}, 'test0003', { playtest: { quickRetry: false, quickRetryGapTiles: 60 } }));
    expect(rejections(step(sim, { type: 'quickRetry' }))).toEqual(['quickRetry: disabled']);
    expect(S(sim).run).not.toBeNull();
  });
});

describe('aboard', () => {
  it('walks the car frame at walk speed, screen-relative, and walls stop the player', () => {
    const sim = IN_PHASE.aboard!();
    const p = S(sim).players[0]!.placement;
    const v = 8 / 60;
    step(sim, { type: 'move', x: 0, y: 127 });
    expect(p.y).toBeCloseTo(0.5 + v, 12);
    steps(sim, 14);
    expect(p.y).toBeCloseTo(2.5, 9);
    step(sim, { type: 'move', x: 127, y: 0 }); // screen right is toward the front, lower cell x
    expect(p.x).toBeCloseTo(8.5 - v, 12);
    steps(sim, 120);
    // Stopped by the front wall (col 0), less the walker's radius.
    expect(p.x).toBeGreaterThanOrEqual(1.3);
    expect(p.x).toBeLessThan(1.3 + v);
    step(sim, { type: 'move', x: 0, y: 127 });
    steps(sim, 60);
    expect(p.y).toBeLessThanOrEqual(4.7);
    expect(p.y).toBeGreaterThan(4.7 - v);
    // Cars move along the route, and the player rides with them.
    const car = sim.cars()[1]!;
    expect(sim.world.toWorld(S(sim), p)).toEqual(carToWorld(car, p.x, p.y));
    // Commands for the horse do nothing aboard; jumps are refused.
    expect(rejections(step(sim, { type: 'jump' }))).toEqual(['jump: aboard']);
  });

  it('the horse is abstract while aboard: it does not move', () => {
    const sim = IN_PHASE.aboard!();
    const h = { ...horse(sim) };
    steps(sim, 30);
    expect(horse(sim)).toEqual(h);
  });
});

describe('snapshots mid-boarding', () => {
  const script = (t: number): Command[] =>
    t === 0 ? [{ type: 'interact', held: false }] : t === 3 || t === 140 ? [{ type: 'jump' }] : t === 200 ? [{ type: 'move', x: 0, y: 127 }] : [];

  function play(sim: Sim, from: number, to: number) {
    for (let t = from; t < to; t++) {
      if (t === 1 || t === 110) alongside(sim); // a scripted rider keeping pace
      if (t === 2) rp(sim).meter.zoneCentre = 0.9; // the first jump samples near 0: a fail
      sim.step([{ player: 1, commands: script(t) }]);
    }
  }

  it('restoring during the stun and mid-sweep matches an uninterrupted run', () => {
    const a = setup();
    play(a, 0, 260);
    for (const cut of [2, 30, 120]) {
      const b = setup();
      play(b, 0, cut);
      const c = restoreSim(b.snapshot(), config, map);
      play(c, cut, 260);
      expect(c.hash()).toBe(a.hash());
    }
    expect(rp(a).boardingAttempts).toBe(2);
  });
});
