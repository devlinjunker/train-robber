// Sneaking PR 2: end platforms and the coupling between cars, side ledges, guards seeing and
// following you outside, and trackside rocks scraping or knocking you off a ledge.
import { describe, it, expect } from 'vitest';
import {
  canSee, carFrame, createSim, doorsClosed, noiseRadius, fromTrain, gridCellOpen, gridWalkable, placeCars, carCatalog, Space, spaceAt, toTrain, trainGrid,
  type Command, type GameState, type PlayerState, type Sim, type SimConfig, type SimEvent, type SimMap,
} from '../src';
import { asciiCar, OUTSIDE, stadium, TEST_CARS, TEST_MAIL_TRAIN, testConfig, testMap, type Paint } from './fixtures';

type Values = SimConfig['values'];

/** A car with windows in its left wall (cols 3-5), a two-cell door on each side (cols 7-8) and end doors; one guard watching from the rear. */
const LEDGE_CAR = asciiCar('guarded', ['###WWW#DD#######', '#..............#', 'D..............D', 'D..............D', '#..............#', '#######DD#######'], {
  entryPoints: [{ id: 'side-left', side: 'left', cell: [7, 0] }, { id: 'side-right', side: 'right', cell: [7, 5] }, { id: 'front', side: 'front', cell: [0, 2] }, { id: 'rear', side: 'rear', cell: [15, 2] }],
  guardSpawns: [{ cell: [12, 2], facing: 'left' }],
});

function outsideConfig(more: { ai?: Partial<Values['ai']>; outside?: Partial<Values['outside']>; guards?: number } = {}): SimConfig {
  const base = testConfig();
  return testConfig({}, 'outs0001', {
    outside: { ...OUTSIDE, ...more.outside },
    carTemplates: { ...TEST_CARS, 'ledge-car': LEDGE_CAR },
    trains: { ...base.values.trains, mail: { ...TEST_MAIL_TRAIN, carType: 'guarded', layouts: ['ledge-car'], carCount: 1, caboose: undefined, loot: undefined, guards: { base: more.guards ?? 1 } } },
    trainMix: { ...base.values.trainMix, mailTrain: 'mail' },
    ai: { ...base.values.ai, ...more.ai },
  });
}

/** The test stadium with its top straight at y = 30.6, so the left ledge (y 27.1 to 27.6, its cell row 26.6 to 27.6) straddles two tile rows. */
function offsetMap(paint: Paint = () => 'open'): SimMap {
  return { ...testMap(paint, SPAWN), routes: [stadium(40, 160, 50.6)] };
}

const SPAWN = { x: 116, y: 22 };
const S = (sim: Sim) => sim.state as GameState;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;
const steps = (sim: Sim, n: number, ...commands: Command[]) => { const ev: SimEvent[] = []; for (let i = 0; i < n; i++) ev.push(...step(sim, ...commands)); return ev; };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Committed to the train (engine at d = 100, so car 1's front is at x = 121 on the top straight), standing in car `car` at (x, y). */
function standing(cfg: SimConfig, x: number, y: number, map: SimMap = offsetMap(), car = 1): Sim {
  const sim = createSim({ config: cfg, map, seed: 'outside', playerIds: [1] });
  const s = S(sim);
  s.world.trains[0]!.d = 100;
  step(sim, { type: 'startRun', trainId: s.world.trains[0]!.id });
  expect(s.run).not.toBeNull();
  s.run!.phase = 'aboard';
  s.world.horses[0]!.mode = 'away';
  s.players[0]!.placement = { frame: carFrame(s.world.trains[0]!.id, car), x, y, layer: 'interior' };
  return sim;
}
const player = (sim: Sim) => S(sim).players[0]!;

describe('the train grid outside the cars', () => {
  const cfg = outsideConfig();
  const g = trainGrid(cfg, ['engine', 'ledge-car']);

  it('lays each car out with a platform at both ends, the coupling gap behind it and a ledge along each side', () => {
    // One-tile platforms and gap: the engine's stretch is 1 + 16 + 1 + 1 columns, the last car's 1 + 16 + 1.
    expect({ offsets: g.offsets, starts: g.starts, cols: g.cols, rows: g.rows, rowOffset: g.rowOffset }).toEqual({ offsets: [1, 20], starts: [0, 19], cols: 37, rows: 8, rowOffset: 1 });
    expect(spaceAt(g, toTrain(g, 1, 3.5), 2.5)).toBe(Space.Inside);
    expect(spaceAt(g, toTrain(g, 1, -0.5), 2.5)).toBe(Space.Platform);
    expect(spaceAt(g, toTrain(g, 0, 16.5), 0.5)).toBe(Space.Platform);
    expect(spaceAt(g, toTrain(g, 1, 5.5), -0.5)).toBe(Space.Ledge);
    expect(spaceAt(g, toTrain(g, 1, 5.5), 6.5)).toBe(Space.Ledge);
    // Round the platform corners too, so you can walk from a platform onto a ledge.
    expect(spaceAt(g, toTrain(g, 1, -0.5), -0.5)).toBe(Space.Ledge);
    for (const [x, y] of [[-0.5, 2.5], [16.5, 2.5], [5.5, -0.5], [-0.5, -0.5]] as const) expect(gridWalkable(g, toTrain(g, 1, x), y)).toBe(true);
  });

  it('crosses the gap only on the coupling plate in the middle; the rest of the gap is open air', () => {
    const gap = toTrain(g, 0, 17.5);
    expect([0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((y) => gridWalkable(g, gap, y))).toEqual([false, false, true, true, false, false]);
    expect(spaceAt(g, gap, 2.5)).toBe(Space.Coupling);
    // Air blocks neither sight nor anything else but your feet.
    expect(g.blocksSight[(1 + g.rowOffset) * g.cols + Math.floor(gap)]).toBe(0);
    // The gap belongs to the car in front.
    expect(fromTrain(g, gap)).toEqual({ car: 0, x: 17.5 });
    expect(fromTrain(g, toTrain(g, 1, -1))).toEqual({ car: 1, x: -1 });
  });

  it('narrows a ledge under a tile wide to its width out from the wall, while still a whole row of cells', () => {
    const lx = toTrain(g, 1, 5.5);
    expect([-0.95, -0.7, -0.5, -0.3].map((y) => gridWalkable(g, lx, y))).toEqual([false, false, true, true]);
    expect([6.3, 6.45, 6.6].map((y) => gridWalkable(g, lx, y))).toEqual([true, true, false]);
    expect(gridCellOpen(g, lx, -0.95)).toBe(true);
    // Wider than a tile takes two rows.
    const wide = trainGrid(outsideConfig({ outside: { ledgeWidthTiles: 1.5 } }), ['engine', 'ledge-car']);
    expect(wide.rowOffset).toBe(2);
    expect([-1.6, -1.4].map((y) => gridWalkable(wide, toTrain(wide, 1, 5.5), y))).toEqual([false, true]);
  });

  it('blocks the ledges with outside.ledges off, leaving the platforms', () => {
    const off = trainGrid(outsideConfig({ outside: { ledges: false } }), ['engine', 'ledge-car']);
    expect(gridWalkable(off, toTrain(off, 1, 5.5), -0.5)).toBe(false);
    expect(gridWalkable(off, toTrain(off, 1, -0.5), 2.5)).toBe(true);
  });

  it('carries the outside speeds and noise on its cells', () => {
    const at = (x: number, y: number) => (Math.floor(y) + g.rowOffset) * g.cols + Math.floor(toTrain(g, 1, x));
    expect(g.speedCap[at(5.5, -0.5)]).toBeCloseTo(1.2 / 60, 12);
    expect(g.speedCap[at(-0.5, 2.5)]).toBeCloseTo(4 / 60, 12);
    expect(g.speedCap[at(5.5, 2.5)]).toBe(Infinity);
    expect(g.noise[at(-0.5, 2.5)]).toBe(1);
  });
});

describe('fractional platforms and gaps', () => {
  const cfg = outsideConfig({ outside: { platformDepthTiles: 0.5, couplingGapTiles: 0.5 } });
  const g = trainGrid(cfg, ['engine', 'ledge-car']);

  it('cuts the outer column short, so the grid spaces the cars as the world does', () => {
    expect({ offsets: g.offsets, starts: g.starts, cols: g.cols, unitCols: g.unitCols }).toEqual({ offsets: [0.5, 18], starts: [0, 17.5], cols: 37, unitCols: false });
    expect(spaceAt(g, toTrain(g, 0, 16.4), 2.5)).toBe(Space.Platform);
    expect(spaceAt(g, toTrain(g, 0, 16.7), 2.5)).toBe(Space.Coupling);
    expect(spaceAt(g, toTrain(g, 1, -0.2), 2.5)).toBe(Space.Platform);
    expect(spaceAt(g, toTrain(g, 1, 0.2), 2.5)).toBe(Space.Inside);
    expect(spaceAt(g, toTrain(g, 1, 16.4), 2.5)).toBe(Space.Platform);
    expect(spaceAt(g, toTrain(g, 1, 16.6), 2.5)).toBe(Space.None);
    const cars = placeCars('t', ['engine', 'ledge-car'], stadium(), 100, carCatalog(cfg), [], 1.5);
    expect((cars[0]!.x - cars[0]!.halfLength) - (cars[1]!.x + cars[1]!.halfLength)).toBe(1.5);
  });

  it('walks out of the front door, over the coupling and onto the next platform without a jump in the world', () => {
    const sim = standing(cfg, 0.6, 2.9);
    const trainId = S(sim).world.trains[0]!.id;
    let prev = sim.world.toWorld(S(sim), player(sim).placement), worst = 0;
    for (let t = 0; t < 120; t++) {
      step(sim, { type: 'move', x: 127, y: 0 });
      // In the train's own frame: what the train moved this tick is taken out.
      const at = sim.world.toWorld(S(sim), player(sim).placement);
      const dTrain = 9 / 60;
      worst = Math.max(worst, Math.abs(Math.hypot(at.x - prev.x, at.y - prev.y) - dTrain));
      prev = at;
    }
    expect(player(sim).placement.frame).toBe(carFrame(trainId, 0));
    expect(player(sim).placement.x).toBeGreaterThan(16);
    expect(worst).toBeLessThan(8 / 60 + 1e-6);
  });
});

describe('cars spaced apart', () => {
  it('places each car body platform + gap + platform behind the one in front', () => {
    const cfg = outsideConfig();
    const cars = placeCars('t', ['engine', 'ledge-car', 'ledge-car'], stadium(), 100, carCatalog(cfg), [], 3);
    // On the top straight, heading +x: engine front at x = 140.
    expect(cars.map((c) => [c.x, c.halfLength])).toEqual([[132, 8], [113, 8], [94, 8]]);
    expect((cars[0]!.x - cars[0]!.halfLength) - (cars[1]!.x + cars[1]!.halfLength)).toBe(3);
  });

  it('keeps cars end to end with no outside spacing', () => {
    const cars = placeCars('t', ['engine', 'blank-car'], stadium(), 100, carCatalog(testConfig()));
    expect(cars[0]!.x - cars[0]!.halfLength).toBe(cars[1]!.x + cars[1]!.halfLength);
  });
});

describe('walking outside', () => {
  it('steps out of a side door onto the ledge and shimmies along it at the ledge speed, walking or running', () => {
    const sim = standing(outsideConfig({ guards: 0 }), 7.5, 0.5);
    steps(sim, 90, { type: 'move', x: 0, y: -127 });
    // The half-tile ledge: the walker's middle stays within 0.5 of the wall, its edge 0.3 off it.
    expect(player(sim).placement.y).toBeLessThan(-0.45);
    expect(player(sim).placement.y).toBeGreaterThanOrEqual(-0.5);
    const x0 = player(sim).placement.x;
    steps(sim, 60, { type: 'move', x: 127, y: 0 });
    // A second at 1.2 tiles/s toward the front (x falls), even though that is a run.
    expect(x0 - player(sim).placement.x).toBeCloseTo(1.2, 6);
  });

  it('lets you onto a ledge of any width, pressed flat against the wall', () => {
    const sim = standing(outsideConfig({ guards: 0, outside: { ledgeWidthTiles: 0.1 } }), 7.5, 0.5);
    steps(sim, 90, { type: 'move', x: 0, y: -127 });
    expect(player(sim).placement.y).toBeLessThan(-0.04);
    expect(player(sim).placement.y).toBeGreaterThanOrEqual(-0.1);
    const x0 = player(sim).placement.x;
    steps(sim, 60, { type: 'move', x: 127, y: 0 });
    expect(x0 - player(sim).placement.x).toBeCloseTo(1.2, 6);
  });

  it('goes out of an end door onto the platform, over the coupling and into the next car\'s frame at walking pace', () => {
    const sim = standing(outsideConfig({ guards: 0 }), 0.6, 2.9);
    const trainId = S(sim).world.trains[0]!.id;
    step(sim, { type: 'move', x: 127, y: 0 });
    const x0 = player(sim).placement.x;
    step(sim, { type: 'move', x: 127, y: 0 });
    // Still inside for that step: full running speed (8 tiles/s).
    expect(x0 - player(sim).placement.x).toBeCloseTo(8 / 60, 9);
    steps(sim, 120, { type: 'move', x: 127, y: 0 });
    // The engine has no rear door: you stop on its rear platform, in its frame.
    expect(player(sim).placement.frame).toBe(carFrame(trainId, 0));
    expect(player(sim).placement.x).toBeGreaterThan(16.3);
    expect(player(sim).placement.x).toBeLessThan(16.3 + 4 / 60);
    // On the platform it is 4 tiles/s however hard you push.
    const before = player(sim).placement.y;
    step(sim, { type: 'move', x: 0, y: 127 });
    expect(player(sim).placement.y - before).toBeCloseTo(4 / 60, 9);
  });
});

describe('guards and the outside', () => {
  const cfg = outsideConfig();
  const g = trainGrid(cfg, ['engine', 'ledge-car']);
  const ai = cfg.values.ai;

  it('see you on a ledge through a window, not through the wall', () => {
    // Guard at row 1 looking out at the left wall; you on the ledge just outside.
    expect(canSee(g, ai, toTrain(g, 1, 4.5), 1.5, 0, -1, toTrain(g, 1, 4.5), -0.5)).toBe(true);
    expect(canSee(g, ai, toTrain(g, 1, 11.5), 1.5, 0, -1, toTrain(g, 1, 11.5), -0.5)).toBe(false);
  });

  it('see you through an open doorway: on the platform through the end door, on the ledge by a side door', () => {
    // Facing the rear end door (row 2) from inside; you on the rear platform.
    expect(canSee(g, ai, toTrain(g, 1, 12.5), 2.5, 1, 0, toTrain(g, 1, 16.5), 2.5)).toBe(true);
    // Facing the left side door (cols 7-8); you on the ledge just outside it.
    expect(canSee(g, ai, toTrain(g, 1, 8), 2.5, 0, -1, toTrain(g, 1, 7.5), -0.4)).toBe(true);
    // Along the ledge past the door, the wall hides you.
    expect(canSee(g, ai, toTrain(g, 1, 8), 2.5, 0, -1, toTrain(g, 1, 11.5), -0.4)).toBe(false);
    // With seeThroughDoorways off, doors block sight as before.
    const shut = trainGrid(outsideConfig({ outside: { seeThroughDoorways: false } }), ['engine', 'ledge-car']);
    expect(canSee(shut, ai, toTrain(shut, 1, 12.5), 2.5, 1, 0, toTrain(shut, 1, 16.5), 2.5)).toBe(false);
    expect(canSee(shut, ai, toTrain(shut, 1, 8), 2.5, 0, -1, toTrain(shut, 1, 7.5), -0.4)).toBe(false);
  });

  it('a chasing guard follows you out of the door onto the ledge, at the ledge speed, and throws you off there', () => {
    const sim = standing(outsideConfig({ ai: { guardCatch: 'thrown-off' } }), 4.5, -0.5);
    const gd = S(sim).run!.guards[0]!;
    Object.assign(gd, { x: 8, y: 2.5, fx: 0, fy: -1, state: 'alert', spotted: true, lastKnown: { car: 1, x: 4.5, y: -0.5 } });
    const grid = trainGrid(cfg, S(sim).world.trains[0]!.cars);
    let outside = 0, fastest = 0, prev: { x: number; y: number } | null = null;
    const ev: SimEvent[] = [];
    for (let t = 0; t < 60 * 10 && ofType(ev, 'ThrownOff').length === 0; t++) {
      ev.push(...step(sim));
      const q = S(sim).run?.guards[0];
      if (!q) break;
      if (spaceAt(grid, toTrain(grid, q.car, q.x), q.y) === Space.Ledge) {
        outside++;
        if (prev) fastest = Math.max(fastest, Math.hypot(q.x - prev.x, q.y - prev.y));
        prev = { x: q.x, y: q.y };
      } else prev = null;
    }
    expect(outside).toBeGreaterThan(0);
    expect(fastest).toBeLessThanOrEqual(1.2 / 60 + 1e-9);
    expect(ofType(ev, 'ThrownOff')).toHaveLength(1);
  });

  it('a guard out on a ledge sees the whole way along it (ai.sight.ledgeRangeTiles)', () => {
    const gx = toTrain(g, 1, 0.5), px = toTrain(g, 1, 14.5);
    const ai = (ledgeRangeTiles: number) => ({ ...cfg.values.ai, sight: { ...cfg.values.ai.sight, ledgeRangeTiles } });
    expect(canSee(g, ai(30), gx, -0.05, 1, 0, px, -0.05)).toBe(true);
    expect(canSee(g, ai(7), gx, -0.05, 1, 0, px, -0.05)).toBe(false);
    // Inside, the normal range still applies.
    expect(canSee(g, ai(30), gx, 2.5, 1, 0, px, 2.5)).toBe(false);
  });

  it('hears you moving on a ledge only from just the other side of the wall, at any pace', () => {
    const p = { move: { x: 127, y: 0 }, placement: { frame: 'x', x: 5.5, y: -0.3, layer: 'interior' } } as unknown as PlayerState;
    const lx = toTrain(g, 1, 5.5);
    expect(noiseRadius(cfg, g, p, lx)).toBe(1.5);
    expect(noiseRadius(cfg, g, p, lx, true)).toBe(1.5);
    expect(noiseRadius(cfg, g, { ...p, move: { x: 0, y: 0 } } as PlayerState, lx)).toBe(0);
  });

  it('a suspicious guard steps outside to look where it saw or heard you (ai.suspiciousStepOutside)', () => {
    const run = (stepOut: boolean) => {
      const c = outsideConfig({ ai: { suspiciousStepOutside: stepOut } });
      const sim = standing(c, 3.5, 2.5);
      const trainId = S(sim).world.trains[0]!.id;
      // You are away in the engine's front platform; the guard heard you on the ledge by the left door.
      S(sim).players[0]!.placement = { frame: carFrame(trainId, 0), x: -0.5, y: 2.5, layer: 'interior' };
      Object.assign(S(sim).run!.guards[0]!, { car: 1, x: 8, y: 2.5, fx: 0, fy: -1, state: 'suspicious', lastKnown: { car: 1, x: 7.5, y: -0.2 } });
      const grid = trainGrid(c, S(sim).world.trains[0]!.cars);
      let outside = false;
      for (let t = 0; t < 200; t++) {
        step(sim);
        const q = S(sim).run!.guards[0]!;
        if (spaceAt(grid, toTrain(grid, q.car, q.x), q.y) === Space.Ledge) outside = true;
      }
      return outside;
    };
    expect(run(true)).toBe(true);
    expect(run(false)).toBe(false);
  });

  it('a suspicious guard walks over to where it heard you inside the car (ai.suspiciousApproach)', () => {
    const run = (approach: boolean) => {
      const c = outsideConfig({ ai: { suspiciousApproach: approach } });
      const sim = standing(c, 3.5, 2.5);
      const trainId = S(sim).world.trains[0]!.id;
      S(sim).players[0]!.placement = { frame: carFrame(trainId, 0), x: -0.5, y: 2.5, layer: 'interior' };
      Object.assign(S(sim).run!.guards[0]!, { car: 1, x: 12, y: 2.5, fx: -1, fy: 0, state: 'suspicious', lastKnown: { car: 1, x: 3.5, y: 3.5 } });
      // Closest it gets before calming down (4 s) and going back to its post.
      let closest = Infinity;
      for (let t = 0; t < 230; t++) {
        step(sim);
        const q = S(sim).run!.guards[0]!;
        closest = Math.min(closest, Math.hypot(q.x - 3.5, q.y - 3.5));
      }
      return closest;
    };
    expect(run(true)).toBeLessThan(4);
    expect(run(false)).toBeGreaterThan(8);
  });

  it('a chasing guard that loses you searches, calms down and walks back to its post', () => {
    const c = outsideConfig({ ai: { guardCatch: 'thrown-off', suspiciousApproach: true, suspiciousStepOutside: true } });
    const sim = standing(c, 3.5, 2.5);
    const trainId = S(sim).world.trains[0]!.id;
    S(sim).players[0]!.placement = { frame: carFrame(trainId, 0), x: -0.5, y: 2.5, layer: 'interior' };
    // Lost you out on the left ledge.
    Object.assign(S(sim).run!.guards[0]!, { car: 1, x: 8, y: 2.5, fx: 0, fy: -1, state: 'alert', spotted: true, lastKnown: { car: 1, x: 4.5, y: -0.2 } });
    const ev = steps(sim, 60 * 25);
    const q = S(sim).run!.guards[0]!;
    expect(ofType(ev, 'GuardStateChanged').map((e) => e.to)).toEqual(['suspicious', 'unaware']);
    expect({ car: q.car, x: q.x, y: q.y }).toEqual({ car: 1, x: 12.5, y: 2.5 });
  });

  it('an unaware guard out on the coupling goes back in to its post and stays inside', () => {
    const sim = standing(outsideConfig(), 3.5, 2.5);
    const trainId = S(sim).world.trains[0]!.id;
    // Keep the player out of sight and earshot in the engine's front platform.
    S(sim).players[0]!.placement = { frame: carFrame(trainId, 0), x: -0.5, y: 2.5, layer: 'interior' };
    const gd = S(sim).run!.guards[0]!;
    Object.assign(gd, { car: 0, x: 17.5, y: 2.5, fx: 1, fy: 0 });
    const grid = trainGrid(outsideConfig(), S(sim).world.trains[0]!.cars);
    steps(sim, 60 * 20);
    const q = S(sim).run!.guards[0]!;
    expect(spaceAt(grid, toTrain(grid, q.car, q.x), q.y)).toBe(Space.Inside);
    expect(q.car).toBe(1);
    expect(q.x).toBeCloseTo(12.5, 6);
    expect(q.y).toBeCloseTo(2.5, 6);
  });
});

describe('trackside rocks', () => {
  // The player on car 1's left ledge at x = 5.5 is at world x 115.5; rocks a few tiles ahead along
  // the track reach them in a few ticks as the train moves up the +x straight.
  const rocks = (row: number): Paint => (x, y) => (y === row && x >= 118 && x <= 120 ? 'blocked' : 'open');

  it('a rock right under you on a ledge knocks you off onto your horse, as being thrown off does', () => {
    const cfg = outsideConfig({ guards: 0 });
    const sim = standing(cfg, 5.5, -0.5, offsetMap(rocks(27)));
    S(sim).run!.players[1]!.carried = ['letter', 'parcel'];
    const ev = steps(sim, 60);
    expect(ofType(ev, 'FellOff')).toEqual([expect.objectContaining({ player: 1, car: 1, cause: 'rock' })]);
    expect(ofType(ev, 'ThrownOff')).toEqual([]);
    expect(player(sim).placement.frame).toBe('world');
    expect(ofType(ev, 'DamageDealt').filter((e) => e.cause === 'fell')).toHaveLength(1);
    expect(ofType(ev, 'LootLost').map((e) => e.cause)).toEqual(['fell']);
    expect(S(sim).run!.players[1]!.carried).toHaveLength(1);
    // Back on the horse beside the train, clear of the rocks.
    const h = S(sim).world.horses[0]!;
    expect(h.mode).toBe('physical');
    expect(Math.floor(h.y)).not.toBe(27);
  });

  it('a rock at the ledge\'s outer edge only scrapes you, once per collision cooldown', () => {
    const sim = standing(outsideConfig({ guards: 0 }), 5.5, -0.5, offsetMap(rocks(26)));
    const ev = steps(sim, 60);
    const hits = ofType(ev, 'DamageDealt');
    expect(hits).toEqual([expect.objectContaining({ cause: 'collision', against: 'obstacle', kind: 'scrape', amount: 1 })]);
    expect(ofType(ev, 'FellOff')).toEqual([]);
    expect(player(sim).placement.frame).not.toBe('world');
  });

  it('leaves the train\'s doors open after a fall, unless scrape.closeDoors', () => {
    const open = standing(outsideConfig({ guards: 0 }), 5.5, -0.5, offsetMap(rocks(27)));
    expect(ofType(steps(open, 60), 'FellOff')).toHaveLength(1);
    expect(doorsClosed(S(open), S(open).world.trains[0]!)).toBe(false);
    const shut = standing(outsideConfig({ guards: 0, outside: { scrape: { glanceTiles: 0.3, knockOff: true, closeDoors: true } } }), 5.5, -0.5, offsetMap(rocks(27)));
    expect(ofType(steps(shut, 60), 'FellOff')).toHaveLength(1);
    expect(doorsClosed(S(shut), S(shut).world.trains[0]!)).toBe(true);
  });

  it('with scrape.knockOff off, a rock under you scrapes instead', () => {
    const sim = standing(outsideConfig({ guards: 0, outside: { scrape: { glanceTiles: 0.3, knockOff: false, closeDoors: false } } }), 5.5, -0.5, offsetMap(rocks(27)));
    const ev = steps(sim, 60);
    expect(ofType(ev, 'FellOff')).toEqual([]);
    expect(ofType(ev, 'DamageDealt').map((e) => e.cause)).toEqual(['collision']);
  });

  it('never touches you inside the car', () => {
    const sim = standing(outsideConfig({ guards: 0 }), 5.5, 0.5 + 1, offsetMap(rocks(27)));
    const ev = steps(sim, 60);
    expect(ofType(ev, 'FellOff').length + ofType(ev, 'DamageDealt').length).toBe(0);
  });
});
