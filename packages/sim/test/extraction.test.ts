// Phase 2 M4: the whistle, the riderless horse (run-off, ride-up, pace window, side switch, blocked),
// the mount jump and its spill, the extracted outcome and cash out, and the grace window (G18).
import { describe, it, expect } from 'vitest';
import {
  cellOf, throwOff, createSim, entryPointWorld, findPath, laneTarget, mountCheck, pathGrid, prepareMap, restoreSim, trackAt, trainLengthOf,
  type Command, type GameState, type MountSpill, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { testConfig, testMap, type Paint } from './fixtures';

const config = testConfig();
const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);
type Values = SimConfig['values'];
const withExtraction = (over: Partial<Values['extraction']>, hash = 'ext00001') => testConfig({}, hash, { extraction: { ...config.values.extraction, ...over } });

function setup(cfg: SimConfig = config, m = map, seed = 'm4'): Sim {
  const sim = createSim({ config: cfg, map: m, seed, playerIds: [1] });
  (sim.state as GameState).world.trains[0]!.d = 100;
  return sim;
}
const S = (sim: Sim) => sim.state as GameState;
const horse = (sim: Sim) => S(sim).world.horses[0]!;
const call = (sim: Sim) => S(sim).run!.horse;
const rp = (sim: Sim) => S(sim).run!.players[1]!;
const player = (sim: Sim) => S(sim).players[0]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim)); return ev; };
const of = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const rejections = (ev: SimEvent[]) => ev.flatMap((e) => (e.type === 'CommandRejected' ? [`${e.command}: ${e.reason}`] : []));

/** Committed and landed aboard car 1 through its left door with a perfect jump (the player stands on the door cell, row 0). */
function aboard(cfg: SimConfig = config, m = map, seed = 'm4'): Sim {
  const sim = setup(cfg, m, seed);
  step(sim, { type: 'interact', held: true });
  const car = sim.cars()[1]!;
  const ep = entryPointWorld(car, { side: 'left', along: -0.5 });
  Object.assign(horse(sim), { x: ep.x + car.uy, y: ep.y - car.ux, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
  step(sim);
  rp(sim).meter.zoneCentre = 0.5; rp(sim).meter.phase = 0.25;
  step(sim, { type: 'jump' });
  expect(S(sim).run!.phase).toBe('aboard');
  return sim;
}

/** Whistle and ride until the horse is alongside (or `max` ticks pass). */
function untilAlongside(sim: Sim, max = 60 * 40): SimEvent[] {
  const ev = step(sim, { type: 'whistle' });
  for (let i = 0; i < max && call(sim).state !== 'alongside'; i++) ev.push(...step(sim));
  return ev;
}

/** Mount with the meter set so the sample lands in `zone` (zones centred at 0.5, widths 0.1 and 0.25). */
const PHASE = { perfect: 0.25, good: 0.3, fail: 0.4 } as const;
function mount(sim: Sim, zone: keyof typeof PHASE): SimEvent[] {
  rp(sim).meter.zoneCentre = 0.5;
  rp(sim).meter.phase = PHASE[zone];
  return step(sim, { type: 'jump' });
}

describe('whistle', () => {
  it('starts extracting and places the horse behind the train on the player\'s side, delay x closing speed back from the player', () => {
    const sim = aboard();
    const ev = step(sim, { type: 'whistle' });
    const w = of(ev, 'HorseWhistled')[0]!;
    expect(w).toMatchObject({ side: 'left', whistle: 1 });
    expect(w.delaySec).toBeGreaterThanOrEqual(5);
    expect(w.delaySec).toBeLessThanOrEqual(20);
    // The player stands in car 1 at cell x 8.5, so 16 + 8.5 tiles behind the engine's front; the
    // train is 64 tiles long, and the horse never starts closer than 4 tiles behind the last car.
    const back = w.delaySec * (14 - 9) - (64 - 16 - 8.5);
    expect(w.distanceTiles).toBeCloseTo(Math.max(4, back), 0);
    expect(S(sim).run!.phase).toBe('extracting');
    expect(call(sim)).toMatchObject({ state: 'approaching', side: 'left' });
    expect(horse(sim).mode).toBe('physical');
    // On the track that far behind the rear, out in the lane on the left (left of travel is (ty, -tx)).
    const train = S(sim).world.trains[0]!;
    const route = sim.map.routes.get('main')!;
    const at = trackAt(route, train.d - trainLengthOf(config, train) - w.distanceTiles);
    const off = 3 + 2;
    expect(Math.hypot(horse(sim).x - (at.x + at.ty * off), horse(sim).y - (at.y - at.tx * off))).toBeLessThan(1.5);
  });

  it('the delay comes from the horse stream: the same seed and whistle draw the same delay whatever else happened', () => {
    const a = aboard(); const b = aboard();
    steps(b, 37); step(b, { type: 'debugHeat' });
    const da = of(step(a, { type: 'whistle' }), 'HorseWhistled')[0]!.delaySec;
    const db = of(step(b, { type: 'whistle' }), 'HorseWhistled')[0]!.delaySec;
    expect(db).toBe(da);
    const c = aboard(config, map, 'other-seed');
    expect(of(step(c, { type: 'whistle' }), 'HorseWhistled')[0]!.delaySec).not.toBe(da);
  });

  it('is refused off the train, and again from the same side while the horse is coming', () => {
    const sim = setup();
    expect(rejections(step(sim, { type: 'whistle' }))).toEqual(['whistle: not aboard']);
    const a = aboard();
    step(a, { type: 'whistle' });
    expect(rejections(step(a, { type: 'whistle' }))).toEqual(['whistle: horse coming']);
  });

  it('the horse comes up on the side the player is nearest (G12)', () => {
    const sim = aboard();
    player(sim).placement.y = 4.5; // near the right wall
    expect(of(step(sim, { type: 'whistle' }), 'HorseWhistled')[0]!.side).toBe('right');
  });
});

describe('the riderless horse', () => {
  it('rides up to the lane beside the player\'s car and paces there; HorseArrived starts the pace window', () => {
    const sim = aboard();
    const ev = untilAlongside(sim);
    const w = of(ev, 'HorseWhistled')[0]!;
    const arrived = of(ev, 'HorseArrived')[0]!;
    expect(arrived).toMatchObject({ side: 'left', paceWindowSec: 10 });
    // On open ground it takes about the drawn delay (at least the ride up past the last car); the
    // test map's tight U-turn stretches it.
    const sec = (arrived.tick - w.tick) / 60;
    expect(sec).toBeGreaterThan(Math.min(w.delaySec, 6) * 0.6);
    expect(sec).toBeLessThan(Math.max(w.delaySec, 6) + 10);
    const lane = laneTarget(S(sim), sim.map, config, player(sim), 'left')!;
    steps(sim, 120);
    const lane2 = laneTarget(S(sim), sim.map, config, player(sim), 'left')!;
    expect(Math.hypot(horse(sim).x - lane2.x, horse(sim).y - lane2.y)).toBeLessThan(3);
    expect(lane2.x).not.toBe(lane.x);
    // It takes no crash damage while riderless.
    expect(S(sim).players[0]!.health).toBe(100);
  });

  it('after the pace window it departs, the run goes back to aboard, and a whistle waits out the cooldown', () => {
    const sim = aboard();
    untilAlongside(sim);
    const ev = steps(sim, 600);
    expect(of(ev, 'HorseDeparted')).toEqual([expect.objectContaining({ cooldownSec: 5 })]);
    expect(S(sim).run!.phase).toBe('aboard');
    expect(rejections(step(sim, { type: 'whistle' }))).toEqual(['whistle: cooling down']);
    steps(sim, 200);
    expect(horse(sim).mode).toBe('away');
    steps(sim, 100);
    expect(of(step(sim, { type: 'whistle' }), 'HorseWhistled')[0]!.whistle).toBe(2);
  });

  it('a whistle from the other side sends it there, crossing behind the last car', () => {
    const sim = aboard();
    untilAlongside(sim);
    player(sim).placement.y = 4.5;
    const ev = step(sim, { type: 'whistle' });
    expect(of(ev, 'HorseSideChanged')).toEqual([expect.objectContaining({ from: 'left', to: 'right' })]);
    expect(call(sim)).toMatchObject({ state: 'approaching', side: 'right' });
    const more: SimEvent[] = [];
    for (let i = 0; i < 60 * 40 && call(sim).state !== 'alongside'; i++) more.push(...step(sim));
    expect(of(more, 'HorseArrived')[0]).toMatchObject({ side: 'right' });
    const lane = laneTarget(S(sim), sim.map, config, player(sim), 'right')!;
    expect(Math.hypot(horse(sim).x - lane.x, horse(sim).y - lane.y)).toBeLessThan(3.5);
  });

  it('says it is blocked when no path reaches the player\'s car, and keeps trying', () => {
    const sim = aboard();
    step(sim, { type: 'whistle' });
    // A pocket walled in by rock, away from the track.
    const pocket: Paint = (x, y) => (Math.max(Math.abs(x - 60), Math.abs(y - 80)) === 6 ? 'blocked' : 'open');
    // Passing through off screen is off here, so the pocket holds it.
    const walled = aboard(withExtraction({ passThroughBeyondTiles: 0 }, 'ext-nopass'), testMap(pocket, SPAWN));
    step(walled, { type: 'whistle' });
    Object.assign(horse(walled), { x: 60.5, y: 80.5 });
    call(walled).replanTicks = 0;
    const ev = steps(walled, 5);
    expect(of(ev, 'HorseBlocked')).toEqual([expect.objectContaining({ reason: 'no path' })]);
    expect(call(walled)).toMatchObject({ state: 'approaching', blocked: 'no path' });
    expect(call(sim).blocked).toBeNull();
  });

  it('off screen (beyond passThroughBeyondTiles) it rides through rock and is never blocked', () => {
    const pocket: Paint = (x, y) => (Math.max(Math.abs(x - 60), Math.abs(y - 80)) === 6 ? 'blocked' : 'open');
    const sim = aboard(config, testMap(pocket, SPAWN));
    step(sim, { type: 'whistle' });
    Object.assign(horse(sim), { x: 60.5, y: 80.5 });
    const lane = laneTarget(S(sim), sim.map, config, player(sim), call(sim).side)!;
    expect(Math.hypot(lane.x - 60.5, lane.y - 80.5)).toBeGreaterThan(config.values.extraction.passThroughBeyondTiles);
    const ev = steps(sim, 60 * 3);
    expect(of(ev, 'HorseBlocked')).toEqual([]);
    expect(Math.max(Math.abs(horse(sim).x - 60), Math.abs(horse(sim).y - 80))).toBeGreaterThan(7);
    expect(call(sim).blocked).toBeNull();
  });
});

describe('coarse pathing', () => {
  it('finds a way round a wall and none out of a walled pocket', () => {
    const wall: Paint = (x, y) => (x === 50 && y < 90 ? 'blocked' : 'open');
    const g = pathGrid(prepareMap(testMap(wall)), 3);
    const path = findPath(g, cellOf(g, 40, 40), cellOf(g, 60, 40))!;
    expect(path.length).toBeGreaterThan(20);
    const pocket: Paint = (x, y) => (Math.max(Math.abs(x - 60), Math.abs(y - 60)) === 6 ? 'blocked' : 'open');
    const gp = pathGrid(prepareMap(testMap(pocket)), 3);
    expect(findPath(gp, cellOf(gp, 60, 60), cellOf(gp, 120, 60))).toBeNull();
  });
});

describe('mount', () => {
  it('needs the horse alongside, the player at a door on its side, and the horse in range', () => {
    const sim = aboard();
    expect(rejections(step(sim, { type: 'jump' }))).toEqual(['jump: no horse']);
    untilAlongside(sim);
    expect(mountCheck(S(sim), sim.map, config, player(sim)).state).toBe('eligible');
    player(sim).placement.x = 3.5; player(sim).placement.y = 1.5;
    expect(rejections(step(sim, { type: 'jump' }))).toEqual(['jump: not at a door']);
  });

  it('perfect mounts clean: extracted, the loot cashed out into the bank, riding on beside the train', () => {
    const sim = aboard();
    rp(sim).carried.push('cash-bundle', 'parcel', 'letter');
    untilAlongside(sim);
    const ev = mount(sim, 'perfect');
    expect(of(ev, 'MountAttempt')[0]).toMatchObject({ result: 'perfect', attempt: 1 });
    expect(of(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'extracted', cashOut: 65 });
    expect(of(ev, 'PersistentChanged')[0]!.after).toMatchObject({ bank: 65, lifetimeEarned: 65, wantedLevel: 0 });
    expect(S(sim).run).toBeNull();
    expect(player(sim).placement.frame).toBe('world');
    expect(horse(sim)).toMatchObject({ mode: 'physical' });
    expect(horse(sim).speed).toBeGreaterThan(5);
    // Auto-commit leaves the train you just robbed alone until you ride out of range.
    expect(player(sim).commitHold).toBe('blank-1');
  });

  it('a good mount stuns the horse for goodMountStunSec; a perfect one does not', () => {
    const good = aboard();
    untilAlongside(good);
    mount(good, 'good');
    expect(horse(good).stunTicks).toBe(config.values.extraction.goodMountStunTicks);
    const perfect = aboard();
    untilAlongside(perfect);
    mount(perfect, 'perfect');
    expect(horse(perfect).stunTicks).toBe(0);
  });

  it('fail leaves you aboard with failure damage and a stumble; you can try again while it paces (G14)', () => {
    const sim = aboard();
    untilAlongside(sim);
    const ev = mount(sim, 'fail');
    expect(of(ev, 'DamageDealt')[0]).toMatchObject({ cause: 'mount', amount: 25, health: 75 });
    expect(S(sim).run!.phase).toBe('extracting');
    expect(rp(sim).stumbleTicks).toBeGreaterThan(0);
    expect(of(mount(sim, 'perfect'), 'MountAttempt')[0]).toMatchObject({ attempt: 2, result: 'perfect' });
    expect(S(sim).run).toBeNull();
  });

  const spill = (rule: MountSpill) => {
    const sim = aboard(withExtraction({ mountSpill: rule }, `ext-${rule}`));
    rp(sim).carried.push('letter', 'strongbox', 'cash-bundle');
    untilAlongside(sim);
    return mount(sim, 'good');
  };

  it('good spills by mountSpill: heaviest loses the heaviest item', () => {
    const ev = spill('heaviest');
    expect(of(ev, 'LootSpilled')[0]).toMatchObject({ items: ['strongbox'], value: 450, rule: 'heaviest' });
    expect(of(ev, 'RunEnded')[0]).toMatchObject({ outcome: 'extracted', cashOut: 45 });
  });

  it('good spills by mountSpill: share loses spillShare of the carried value', () => {
    const ev = spill('share');
    expect(of(ev, 'LootSpilled')[0]).toMatchObject({ items: [], value: Math.round(495 * 0.3), rule: 'share' });
    expect(of(ev, 'RunEnded')[0]).toMatchObject({ cashOut: 495 - Math.round(495 * 0.3) });
  });

  it('good spills by mountSpill: random loses one item, the same one for the same seed', () => {
    const a = of(spill('random'), 'LootSpilled')[0]!;
    const b = of(spill('random'), 'LootSpilled')[0]!;
    expect(a.items).toHaveLength(1);
    expect(b).toEqual(a);
  });
});

describe('grace (G18)', () => {
  it('with the horse alongside and the player at a door on its side, expiry waits up to graceSec', () => {
    const sim = aboard();
    untilAlongside(sim);
    S(sim).run!.countdownSec = 0.001;
    expect(of(steps(sim, 170), 'RunEnded')).toEqual([]);
    expect(of(steps(sim, 20), 'RunEnded')[0]!.outcome).toBe('expired');
  });

  it('away from the door it expires at once', () => {
    const sim = aboard();
    untilAlongside(sim);
    player(sim).placement.x = 3.5; player(sim).placement.y = 1.5;
    S(sim).run!.countdownSec = 0.001;
    expect(of(step(sim), 'RunEnded')[0]!.outcome).toBe('expired');
  });

  it('a mount inside the grace window still extracts', () => {
    const sim = aboard();
    rp(sim).carried.push('letter');
    untilAlongside(sim);
    S(sim).run!.countdownSec = 0.001;
    steps(sim, 60);
    expect(of(mount(sim, 'perfect'), 'RunEnded')[0]).toMatchObject({ outcome: 'extracted', cashOut: 5 });
  });
});

describe('snapshots mid-extraction', () => {
  it('restoring while the horse rides up and while it paces matches an uninterrupted run', () => {
    const play = (sim: Sim, from: number, to: number) => {
      for (let t = from; t < to; t++) sim.step([{ player: 1, commands: t === 0 ? [{ type: 'whistle' }] : t === 900 ? [{ type: 'move', x: 64, y: 0 }] : [] }]);
    };
    const a = aboard();
    play(a, 0, 1500);
    for (const cut of [5, 400, 1000]) {
      const b = aboard();
      play(b, 0, cut);
      const c = restoreSim(b.snapshot(), config, map);
      play(c, cut, 1500);
      expect(c.hash()).toBe(a.hash());
    }
  });
});

describe('thrown off while the horse is called (M3 x M4)', () => {
  it('lands you on your horse beside the train and ends the call', () => {
    const sim = aboard();
    step(sim, { type: 'whistle' });
    steps(sim, 30);
    expect(S(sim).run!.phase).toBe('extracting');
    const events: SimEvent[] = [];
    throwOff({ state: S(sim), map: sim.map, config, emit: (e: SimEvent) => events.push(e) } as never, player(sim), 7);
    expect(of(events, 'ThrownOff')).toHaveLength(1);
    expect(S(sim).run!.phase).toBe('boarding');
    expect(call(sim).state).toBe('away');
    expect(player(sim).placement.frame).toBe('world');
    expect(horse(sim)).toMatchObject({ mode: 'physical' });
    // Beside the car the player stood in, not where the called horse was.
    const car = sim.cars()[1]!;
    expect(Math.hypot(horse(sim).x - car.x, horse(sim).y - car.y)).toBeLessThan(car.halfLength + 4);
    // Riding again, the next tick moves the ridden horse, not the extraction AI.
    expect(rejections(step(sim, { type: 'whistle' }))).toEqual(['whistle: not aboard']);
  });
});
