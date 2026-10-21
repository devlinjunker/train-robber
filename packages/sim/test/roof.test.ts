// Sneaking PR 3: ladders up to the roofs, walking and noise up there, which guards see you, guards
// climbing after you, gap jumps and slipping on curves.
import { describe, it, expect } from 'vitest';
import {
  carFrame, createSim, curvePull, guardSees, ladderInReach, noiseRadius, onRoof, trainGrid, trainLadders, toTrain,
  type Command, type GameState, type PlayerState, type Sim, type SimConfig, type SimEvent, type SimMap,
} from '../src';
import { asciiCar, OUTSIDE, ROOF, stadium, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap, type Paint } from './fixtures';

type Values = SimConfig['values'];

/** A 16 x 6 car with end doors and a side door each side; one guard spawn at the rear. */
const CAR = asciiCar('guarded', ['#######DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [7, 0] }, { id: 'side-right', side: 'right', cell: [7, 5] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 2], facing: 'left' }],
});

/** The shipped spacing: half-tile platforms and a one-tile gap, so roofs are 2 tiles apart. */
function roofConfig(more: { ai?: Partial<Values['ai']>; roof?: Partial<Values['outside']['roof']>; guards?: number } = {}): SimConfig {
  const base = testConfig();
  return testConfig({}, 'roof0001', {
    outside: { ...OUTSIDE, platformDepthTiles: 0.5, couplingGapTiles: 1, roof: { ...ROOF, ...more.roof } },
    carTemplates: { ...TEST_CARS, 'roof-car': CAR },
    trains: { ...base.values.trains, mail: { ...TEST_MAIL_TRAIN, carType: 'guarded', layouts: ['roof-car'], carCount: 1, caboose: undefined, loot: undefined, guards: { base: more.guards ?? 0 } } },
    trainMix: { ...base.values.trainMix, mailTrain: 'mail' },
    ai: { ...base.values.ai, ...more.ai },
  });
}

const SPAWN = { x: 116, y: 22 };
function map(paint: Paint = () => 'open'): SimMap {
  return { ...testMap(paint, SPAWN), routes: [stadium(40, 160, 50.6)] };
}
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number, ...commands: Command[]) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim, ...commands)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const player = (sim: Sim) => S(sim).players[0]!;
const rp = (sim: Sim) => S(sim).run!.players[1]!;

/** Committed to the train (engine front at `d`), standing in car `car` at (x, y) below or on its roof. */
function at(cfg: SimConfig, x: number, y: number, layer: 'interior' | 'roof' = 'interior', car = 1, d = 100, m: SimMap = map()): Sim {
  const sim = createSim({ config: cfg, map: m, seed: 'roof', playerIds: [1] });
  const s = S(sim);
  s.world.trains[0]!.d = d;
  step(sim, { type: 'startRun', trainId: s.world.trains[0]!.id });
  expect(s.run).not.toBeNull();
  s.run!.phase = 'aboard';
  s.world.horses[0]!.mode = 'away';
  s.players[0]!.placement = { frame: carFrame(s.world.trains[0]!.id, car), x, y, layer };
  return sim;
}

describe('ladders', () => {
  const cfg = roofConfig();
  const g = trainGrid(cfg, ['engine', 'roof-car']);

  it('stand on the end platform at both ends of every car, at the ladder row, out from the wall far enough to stand', () => {
    const l = trainLadders(cfg, ['engine', 'roof-car']);
    expect(l.map((q) => [q.car, q.end, q.y])).toEqual([[0, 'front', 1.5], [0, 'rear', 1.5], [1, 'front', 1.5], [1, 'rear', 1.5]]);
    // Car 1's front wall is at train x 18.5; its ladder's foot is 0.35 out on the half-tile platform.
    expect(l[2]!.deckLx).toBeCloseTo(18.15, 9);
    expect(l[2]!.roofX).toBeCloseTo(0.4, 9);
    expect(trainLadders(roofConfig({ roof: { ladderEnds: 'rear' } }), ['engine', 'roof-car']).map((q) => q.end)).toEqual(['rear', 'rear']);
    expect(trainLadders(roofConfig({ roof: { enabled: false } }), ['engine', 'roof-car'])).toEqual([]);
    expect(onRoof(g, 1, 8, 3)).toBe(true);
    expect(onRoof(g, 1, -0.2, 3)).toBe(false);
  });

  it('E on the platform by a ladder climbs up in climbSec, onto the roof by its end', () => {
    const sim = at(cfg, -0.35, 1.5);
    const ev = steps(sim, 59, { type: 'climb' });
    expect(rp(sim).climb).not.toBeNull();
    expect(player(sim).placement.layer).toBe('interior');
    const done = step(sim);
    expect(ofType([...ev, ...done], 'Climbed')).toEqual([expect.objectContaining({ car: 1, end: 'front', to: 'roof' })]);
    expect(player(sim).placement).toEqual({ frame: carFrame(S(sim).world.trains[0]!.id, 1), x: 0.4, y: 1.5, layer: 'roof' });
    expect(ofType(ev, 'CommandRejected').filter((e) => e.command === 'climb').length).toBeGreaterThan(0); // the repeats while climbing are refused
  });

  it('does not reach through the end wall from inside, nor from too far along the platform', () => {
    const inside = at(cfg, 0.5, 1.5);
    expect(ofType(step(inside, { type: 'climb' }), 'CommandRejected')).toEqual([expect.objectContaining({ command: 'climb', reason: 'no ladder' })]);
    const far = at(cfg, -0.35, 4.5);
    expect(ladderInReach(S(far), cfg, player(far))).toBeNull();
  });

  it('climbs back down from the roof to the platform at a ladder of any car', () => {
    const sim = at(cfg, 15.7, 1.4, 'roof', 0);
    steps(sim, 60, { type: 'climb' });
    expect(player(sim).placement.layer).toBe('interior');
    expect(player(sim).placement.frame).toBe(carFrame(S(sim).world.trains[0]!.id, 0));
    expect(player(sim).placement.x).toBeCloseTo(16.35, 9);
  });

  it('refuses the climb with the roof off', () => {
    const off = roofConfig({ roof: { enabled: false } });
    const sim = at(off, -0.35, 1.5);
    expect(ofType(step(sim, { type: 'climb' }), 'CommandRejected')).toEqual([expect.objectContaining({ command: 'climb', reason: 'disabled' })]);
  });
});

describe('walking on the roof', () => {
  const cfg = roofConfig();

  it('runs at outside.roof.speedTilesPerSec, walks at half, and creeps crouched', () => {
    const run = at(cfg, 8, 3, 'roof');
    steps(run, 60, { type: 'move', x: 127, y: 0 });
    expect(8 - player(run).placement.x).toBeCloseTo(5, 6);
    const walk = at(cfg, 8, 3, 'roof');
    steps(walk, 60, { type: 'move', x: 64, y: 0 });
    expect(8 - player(walk).placement.x).toBeCloseTo(5 * 64 / 127, 6);
    const creep = at(cfg, 8, 3, 'roof');
    steps(creep, 60, { type: 'crouch', on: true }, { type: 'move', x: 127, y: 0 });
    expect(8 - player(creep).placement.x).toBeCloseTo(5 * 0.25, 6);
  });

  it('stops at the long edges', () => {
    const sim = at(cfg, 8, 3, 'roof');
    steps(sim, 120, { type: 'move', x: 0, y: -127 });
    expect(player(sim).placement.y).toBeCloseTo(0.3, 9);
    expect(player(sim).placement.layer).toBe('roof');
  });

  it('walking off an end drops you onto the platform below, staggering', () => {
    const sim = at(cfg, 0.5, 2.5, 'roof');
    const ev = steps(sim, 12, { type: 'move', x: 64, y: 0 });
    expect(ofType(ev, 'RoofLanded')).toEqual([expect.objectContaining({ car: 1, on: 'platform', jumped: false })]);
    expect(player(sim).placement.layer).toBe('interior');
    expect(rp(sim).stumbleTicks).toBeGreaterThan(0);
  });

  it('no loot, doors or drops from up there, and trackside rocks cannot reach you', () => {
    const rocks: Paint = (x, y) => (y >= 26 && y <= 34 && x >= 100 && x <= 130 ? 'blocked' : 'open');
    const sim = at(cfg, 5.5, 0.4, 'roof', 1, 100, map(rocks));
    rp(sim).carried = ['letter'];
    const ev = steps(sim, 60, { type: 'drop', slot: 0 });
    expect(ofType(ev, 'FellOff')).toEqual([]);
    expect(ofType(ev, 'DamageDealt')).toEqual([]);
    expect(ofType(ev, 'CommandRejected')[0]).toEqual(expect.objectContaining({ command: 'drop', reason: 'on the roof' }));
  });
});

describe('noise and sight on the roof', () => {
  const cfg = roofConfig();
  const g = trainGrid(cfg, ['engine', 'roof-car']);
  const roofP = (x: number, y: number, move = { x: 127, y: 0 }) => ({ move, placement: { frame: 'x', x, y, layer: 'roof' } }) as unknown as PlayerState;

  it('footsteps up there carry the roof radii: walking, running, crouched, and the thud of a landing', () => {
    const lx = toTrain(g, 1, 5);
    expect(noiseRadius(cfg, g, roofP(5, 3), lx)).toBe(6);
    expect(noiseRadius(cfg, g, roofP(5, 3, { x: 64, y: 0 }), lx)).toBe(3);
    expect(noiseRadius(cfg, g, roofP(5, 3), lx, true)).toBe(1.5);
    expect(noiseRadius(cfg, g, roofP(5, 3, { x: 0, y: 0 }), lx)).toBe(0);
    expect(noiseRadius(cfg, g, roofP(5, 3, { x: 0, y: 0 }), lx, false, false, false, true)).toBe(6);
    expect(noiseRadius(cfg, g, roofP(5, 3), lx, false, false, false, false, true)).toBe(0);
  });

  it('a guard inside the car below hears you; one in the next car does not, however close', () => {
    const sim = at(roofConfig({ guards: 1 }), 1, 3, 'roof');
    const gd = S(sim).run!.guards[0]!;
    // Behind the engine's rear wall, 4 tiles from you but under another roof.
    Object.assign(gd, { car: 0, x: 15.5, y: 3, fx: -1, fy: 0, post: { car: 0, x: 15.5, y: 3, fx: -1, fy: 0 }, patrol: null });
    steps(sim, 10, { type: 'move', x: -127, y: 0 });
    expect(S(sim).run!.guards[0]!.state).toBe('unaware');
    const below = at(roofConfig({ guards: 1 }), 1, 3, 'roof');
    Object.assign(S(below).run!.guards[0]!, { car: 1, x: 5, y: 3, fx: 1, fy: 0, post: { car: 1, x: 5, y: 3, fx: 1, fy: 0 }, patrol: null });
    const ev = steps(below, 3, { type: 'move', x: -127, y: 0 });
    expect(ofType(ev, 'GuardStateChanged')).toEqual([expect.objectContaining({ to: 'suspicious', cause: 'noise' })]);
  });

  it('a guard inside never sees you up there; one on a platform or ledge sees you near the edge over them', () => {
    const target = (x: number, y: number, crouched = false) => ({ lx: toTrain(g, 1, x), y, roof: true, car: 1, x, crouched });
    // Inside, looking right at where you are.
    expect(guardSees(g, cfg, toTrain(g, 1, 3), 3, false, 1, 0, target(5, 3))).toBe(false);
    // On the left ledge looking along it: you at the left edge yes, in the middle no, crouched only right at the edge.
    expect(guardSees(g, cfg, toTrain(g, 1, -0.2), -0.05, false, 1, 0, target(6, 1))).toBe(true);
    expect(guardSees(g, cfg, toTrain(g, 1, -0.2), -0.05, false, 1, 0, target(6, 3))).toBe(false);
    expect(guardSees(g, cfg, toTrain(g, 1, -0.2), -0.05, false, 1, 0, target(6, 1, true))).toBe(false);
    expect(guardSees(g, cfg, toTrain(g, 1, -0.2), -0.05, false, 1, 0, target(6, 0.4, true))).toBe(true);
    // The right ledge does not see the left edge.
    expect(guardSees(g, cfg, toTrain(g, 1, -0.2), 6.05, false, 1, 0, target(6, 1))).toBe(false);
    // On the front platform facing the car: your front end, not the far end.
    expect(guardSees(g, cfg, toTrain(g, 1, -0.3), 3, false, 1, 0, target(1, 3))).toBe(true);
    expect(guardSees(g, cfg, toTrain(g, 1, -0.3), 3, false, 1, 0, target(15.5, 3))).toBe(false);
    // On a roof: along it, nothing in the way; never the deck below.
    expect(guardSees(g, cfg, toTrain(g, 1, 2), 3, true, 1, 0, target(8, 3))).toBe(true);
    expect(guardSees(g, cfg, toTrain(g, 1, 2), 3, true, 1, 0, { ...target(8, 3), roof: false })).toBe(false);
  });
});

describe('guards climbing after you', () => {
  it('a guard that hears you on the roof climbs up the nearest ladder to check, and you are told', () => {
    const cfg = roofConfig({ guards: 1, ai: { suspiciousApproach: true, suspiciousStepOutside: true } });
    const sim = at(cfg, 4, 3, 'roof');
    Object.assign(S(sim).run!.guards[0]!, { car: 1, x: 6, y: 3, fx: 1, fy: 0, post: { car: 1, x: 6, y: 3, fx: 1, fy: 0 }, patrol: null });
    // A few loud steps toward the front, then stand still and wait.
    const ev = [...steps(sim, 20, { type: 'move', x: 127, y: 0 }), ...steps(sim, 60 * 8, { type: 'move', x: 0, y: 0 })];
    expect(ofType(ev, 'GuardClimbing')).toEqual([expect.objectContaining({ car: 1, to: 'roof' })]);
    const gd = S(sim).run!.guards[0]!;
    expect(gd.roof).toBe(true);
    expect(gd.car).toBe(1);
  });

  it('with outside.roof.guardsClimb off they stay below', () => {
    const cfg = roofConfig({ guards: 1, ai: { suspiciousApproach: true }, roof: { guardsClimb: false } });
    const sim = at(cfg, 4, 3, 'roof');
    Object.assign(S(sim).run!.guards[0]!, { car: 1, x: 6, y: 3, fx: 1, fy: 0, post: { car: 1, x: 6, y: 3, fx: 1, fy: 0 }, patrol: null });
    const ev = [...steps(sim, 20, { type: 'move', x: 127, y: 0 }), ...steps(sim, 60 * 6, { type: 'move', x: 0, y: 0 })];
    expect(ofType(ev, 'GuardClimbing')).toEqual([]);
    expect(S(sim).run!.guards[0]!.roof).toBe(false);
  });

  it('an alert guard on your roof catches you and throws you off; one below cannot reach you', () => {
    const cfg = roofConfig({ guards: 1, ai: { guardCatch: 'thrown-off' } });
    const up = at(cfg, 8, 3, 'roof');
    Object.assign(S(up).run!.guards[0]!, { car: 1, x: 12, y: 3, fx: -1, fy: 0, roof: true, state: 'alert', spotted: true, lastKnown: { car: 1, x: 8, y: 3, roof: true } });
    expect(ofType(steps(up, 120), 'ThrownOff')).toHaveLength(1);
    const below = at(cfg, 8, 3, 'roof');
    Object.assign(S(below).run!.guards[0]!, { car: 1, x: 8, y: 3, fx: -1, fy: 0, roof: false, state: 'alert', spotted: true, lastKnown: { car: 1, x: 8, y: 3, roof: true }, climb: null });
    const ev = steps(below, 30);
    expect(ofType(ev, 'ThrownOff')).toEqual([]);
  });

  it('a calm guard up on a roof climbs back down to its post', () => {
    const sim = at(roofConfig({ guards: 1 }), -0.35, 4.5, 'interior', 0);
    Object.assign(S(sim).run!.guards[0]!, { car: 1, x: 8, y: 3, roof: true, state: 'unaware', post: { car: 1, x: 12.5, y: 2.5, fx: -1, fy: 0 }, patrol: null });
    const ev = steps(sim, 60 * 12);
    expect(ofType(ev, 'GuardClimbing')).toEqual([expect.objectContaining({ to: 'deck' })]);
    const gd = S(sim).run!.guards[0]!;
    expect({ roof: gd.roof, car: gd.car }).toEqual({ roof: false, car: 1 });
    expect(gd.x).toBeCloseTo(12.5, 6);
  });
});

describe('jumping the gap', () => {
  const cfg = roofConfig();
  // Car 1's roof starts 2 tiles behind the engine's; running toward the front is move x = 127.
  const run = { type: 'move', x: 127, y: 0 } as const;

  it('a running jump from near the edge clears it onto the next roof, with a thud', () => {
    const sim = at(cfg, 0.5, 2.5, 'roof');
    step(sim, run);
    const ev = [...step(sim, run, { type: 'jump' }), ...steps(sim, 30, run)];
    expect(ofType(ev, 'RoofJumped')[0]!.distanceTiles).toBeCloseTo(3.25, 6);
    expect(ofType(ev, 'RoofLanded')).toEqual([expect.objectContaining({ car: 0, on: 'roof', jumped: true })]);
    expect(player(sim).placement.layer).toBe('roof');
    expect(player(sim).placement.frame).toBe(carFrame(S(sim).world.trains[0]!.id, 0));
  });

  it('too far back, you come down short: on the coupling plate in the middle, off the train at the side', () => {
    const middle = at(cfg, 2.3, 2.5, 'roof');
    step(middle, run);
    const ev = [...step(middle, run, { type: 'jump' }), ...steps(middle, 30)];
    expect(ofType(ev, 'RoofLanded')).toEqual([expect.objectContaining({ on: 'coupling', jumped: true })]);
    expect(player(middle).placement.layer).toBe('interior');
    const side = at(cfg, 2.3, 0.5, 'roof');
    step(side, run);
    const fell = [...step(side, run, { type: 'jump' }), ...steps(side, 30)];
    expect(ofType(fell, 'FellOff')).toEqual([expect.objectContaining({ cause: 'jump' })]);
    expect(player(side).placement.frame).toBe('world');
  });

  it('a walking jump cannot clear the gap: at best you drop onto the platform', () => {
    const sim = at(cfg, 0.35, 2.5, 'roof');
    const walk = { type: 'move', x: 64, y: 0 } as const;
    step(sim, walk);
    const ev = [...step(sim, walk, { type: 'jump' }), ...steps(sim, 30)];
    expect(ofType(ev, 'RoofLanded')).toEqual([expect.objectContaining({ on: 'platform' })]);
  });

  it('standing still, Space does nothing', () => {
    const sim = at(cfg, 0.5, 2.5, 'roof');
    expect(ofType(step(sim, { type: 'jump' }), 'CommandRejected')).toEqual([expect.objectContaining({ command: 'jump', reason: 'standing still' })]);
  });
});

describe('slipping on curves', () => {
  // Engine front at d = 159: car 1 (track 141 to 125) is on the stadium's first U-turn, a right turn.
  const D = 159;
  const cfg = roofConfig();
  // The horse waits by the curve, so the run can commit.
  const curve = { ...testMap(() => 'open', { x: 182, y: 32 }), routes: [stadium(40, 160, 50.6)] };

  it('pulls toward the outside of the curve: train speed squared over the radius, about', () => {
    const sim = at(cfg, 8, 3, 'roof', 1, D, curve);
    const pull = curvePull(S(sim), sim.map, cfg, S(sim).world.trains[0]!.id, 1);
    // A right turn throws you left (-y); 81 / 20 on the arc, a little less over a 16-tile chord.
    expect(pull).toBeLessThan(-3);
    expect(pull).toBeGreaterThan(-4.1);
    const straight = at(cfg, 8, 3, 'roof', 1, 100);
    expect(curvePull(S(straight), straight.map, cfg, S(straight).world.trains[0]!.id, 1)).toBeCloseTo(0, 6);
  });

  it('running on a sharp curve slips you toward the edge; walking there does not', () => {
    const run = at(cfg, 8, 3, 'roof', 1, D, curve);
    const ev = step(run, { type: 'move', x: -127, y: 0 });
    expect(ofType(ev, 'RoofSlipped')).toEqual([expect.objectContaining({ car: 1, dir: -1 })]);
    const walk = at(cfg, 8, 3, 'roof', 1, D, curve);
    expect(ofType(steps(walk, 60, { type: 'move', x: -64, y: 0 }), 'RoofSlipped')).toEqual([]);
  });

  it('leaning into the curve for leanSec recovers; letting it slide carries you off', () => {
    const lean = at(cfg, 8, 3, 'roof', 1, D, curve);
    step(lean, { type: 'move', x: -127, y: 0 });
    const y0 = player(lean).placement.y;
    const ev = steps(lean, 18, { type: 'move', x: 0, y: 127 });
    expect(ofType(ev, 'RoofRecovered')).toHaveLength(1);
    expect(player(lean).placement.y).toBe(y0);
    const slide = at(cfg, 8, 3, 'roof', 1, D, curve);
    const fell = steps(slide, 90, { type: 'move', x: -127, y: 0 });
    expect(ofType(fell, 'FellOff')).toEqual([expect.objectContaining({ cause: 'slip' })]);
  });

  it('never slips with outside.roof.slip.enabled off', () => {
    const sim = at(roofConfig({ roof: { slip: { ...ROOF.slip, enabled: false } } }), 8, 3, 'roof', 1, D, curve);
    expect(ofType(steps(sim, 30, { type: 'move', x: -127, y: 0 }), 'RoofSlipped')).toEqual([]);
  });
});
