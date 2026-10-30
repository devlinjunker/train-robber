// Issue #60: quieter ways onto a train. Jumps from the horse can land on the end platforms between
// cars and on the side ladders up to the roof, with the same meter; riding alongside, the guards in a
// cone through a door show (the pure `guardsInCone` helper).
import { describe, it, expect } from 'vitest';
import {
  boardingCheck, carBoardingTargets, createSim, entryPointWorld, guardsInCone, ROOF_STEP_IN, SIDE_LADDER_OUT, trainGrid, trainOpenings, trainSideLadders,
  type Command, type GameState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { OUTSIDE, ROOF, testConfig, testMap } from './fixtures';

const base = testConfig();
const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);

/** Platforms 1 tile deep, roofs on with side ladders on every car, and the targets switched as given. */
function cfg(targets: Partial<SimConfig['values']['boarding']['targets']> = {}): SimConfig {
  const b = base.values.boarding;
  return testConfig({}, 'targets1', {
    boarding: { ...b, targets: { doors: true, platforms: true, sideLadders: true, ...targets } },
    outside: { ...OUTSIDE, roof: ROOF },
  });
}

function setup(c: SimConfig): Sim {
  const sim = createSim({ config: c, map, seed: 'targets', playerIds: [1] });
  (sim.state as GameState).world.trains[0]!.d = 100;
  return sim;
}
const S = (sim: Sim) => sim.state as GameState;
const horse = (sim: Sim) => S(sim).world.horses[0]!;
const me = (sim: Sim) => S(sim).players[0]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;

/** Committed, with the horse `gap` tiles out from car 1's side at `along` (from mid-car toward the front), matching the train. */
function beside(c: SimConfig, along: number, side: 'left' | 'right' = 'left', gap = 1): Sim {
  const sim = setup(c);
  step(sim, { type: 'interact', held: true });
  const car = sim.cars()[1]!;
  const at = entryPointWorld(car, { side, along });
  const s = side === 'left' ? 1 : -1;
  Object.assign(horse(sim), { x: at.x + car.uy * gap * s, y: at.y - car.ux * gap * s, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
  step(sim);
  return sim;
}

function perfectJump(sim: Sim): SimEvent[] {
  const rp = S(sim).run!.players[1]!;
  rp.meter.zoneCentre = 0.5;
  rp.meter.phase = 0.25;
  return step(sim, { type: 'jump' });
}

// Car 1 is a 16 x 6 blank car: platforms 1 tile deep, so a platform landing stands 0.5 out from the end wall.
const REAR_PLATFORM_ALONG = -(8 + 0.5);
const SIDE_LADDER_ALONG = 8 - 13; // 3 in from the rear: car x 13.

describe('boarding targets', () => {
  it('lists doors, platforms at both ends (not the engine front) and side ladders, each switchable', () => {
    const c = cfg();
    const sim = setup(c);
    const cars = sim.cars(), train = S(sim).world.trains[0]!;
    const kinds = (i: number, cc = c) => carBoardingTargets(cc, cars[i]!, train.cars).map((t) => `${t.kind}:${t.id}:${t.side}`).sort();
    expect(kinds(0).filter((k) => k.startsWith('platform'))).toEqual(['platform:platform-rear:left', 'platform:platform-rear:right']);
    expect(kinds(1)).toEqual([
      'door:side-left:left', 'door:side-right:right',
      'ladder:ladder-left:left', 'ladder:ladder-right:right',
      'platform:platform-front:left', 'platform:platform-front:right', 'platform:platform-rear:left', 'platform:platform-rear:right',
    ]);
    expect(kinds(1, cfg({ platforms: false, sideLadders: false }))).toEqual(['door:side-left:left', 'door:side-right:right']);
    // Shut doors drop only the doors.
    expect(carBoardingTargets(c, cars[1]!, train.cars, true).some((t) => t.kind === 'door')).toBe(false);
    expect(trainSideLadders(c, train.cars).find((l) => l.car === 1)?.x).toBe(13);
  });

  it('a perfect jump at a rear platform lands on it, out in the open past the end wall', () => {
    const c = cfg();
    const sim = beside(c, REAR_PLATFORM_ALONG);
    const check = boardingCheck(S(sim), sim.map, c, S(sim).run!.trainId, horse(sim));
    expect([check.target, check.entry, check.car, check.state]).toEqual(['platform', 'platform-rear', 1, 'eligible']);
    const ev = perfectJump(sim);
    expect(ev.find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'perfect', target: 'platform' });
    expect(S(sim).run!.phase).toBe('aboard');
    expect(me(sim).placement).toMatchObject({ x: 16.5, y: 0.5, layer: 'interior' });
    expect(me(sim).placement.frame).toContain(':1');
  });

  it('a jump at a side ladder hangs on it, then climbs straight to the roof', () => {
    const c = cfg();
    const sim = beside(c, SIDE_LADDER_ALONG, 'right');
    const ev = perfectJump(sim);
    expect(ev.find((e) => e.type === 'BoardingAttempt')).toMatchObject({ target: 'ladder' });
    const rp = S(sim).run!.players[1]!;
    expect(rp.climb).toMatchObject({ to: 'roof', side: 'right', car: 1 });
    expect(me(sim).placement).toMatchObject({ x: 13, y: 6 + SIDE_LADDER_OUT });
    let climbed: SimEvent | undefined;
    for (let i = 0; i < c.values.outside.roof.climbTicks + 1 && !climbed; i++) climbed = step(sim).find((e) => e.type === 'Climbed');
    expect(climbed).toMatchObject({ to: 'roof', side: 'right', car: 1 });
    expect(me(sim).placement).toMatchObject({ x: 13, y: 6 - ROOF_STEP_IN, layer: 'roof' });
  });

  it('with the doors only, beside a platform is too far, as before', () => {
    const c = cfg({ platforms: false, sideLadders: false });
    const sim = beside(c, REAR_PLATFORM_ALONG);
    const check = boardingCheck(S(sim), sim.map, c, S(sim).run!.trainId, horse(sim));
    expect(check.state).toBe('too far');
  });

  it('a shut train can still be boarded at a platform, not at a door', () => {
    const c = cfg();
    const atDoor = beside(c, -0.5);
    S(atDoor).world.trains.find((t) => t.id === S(atDoor).run!.trainId)!.doorsClosed = { untilTick: null };
    const ev = perfectJump(atDoor);
    expect(ev.find((e) => e.type === 'CommandRejected')).toMatchObject({ command: 'jump', reason: 'doors closed' });
    const atPlatform = beside(c, REAR_PLATFORM_ALONG);
    S(atPlatform).world.trains.find((t) => t.id === S(atPlatform).run!.trainId)!.doorsClosed = { untilTick: null };
    perfectJump(atPlatform);
    expect(S(atPlatform).run!.phase).toBe('aboard');
  });
});

describe('guardsInCone', () => {
  const c = cfg();
  const sim = setup(c);
  const cars = S(sim).world.trains[0]!.cars;
  const g = trainGrid(c, cars);
  const door = trainOpenings(c, cars).find((o) => o.car === 1 && o.id === 'side-left')!;

  it('sees guards straight in through the door, not off to the side or too far', () => {
    const cos = Math.cos(Math.PI / 4);
    const ahead = { id: 1, lx: door.lx, y: 3 };
    const wide = { id: 2, lx: door.lx + 6, y: 2 };
    const far = { id: 3, lx: door.lx, y: 30 };
    expect(door.facing).toEqual({ x: 0, y: 1 });
    expect(guardsInCone(g, door, door.facing, cos, 10, [ahead, wide, far])).toEqual([1]);
  });

  it('does not see through a wall: a guard in the next car is hidden', () => {
    const next = { id: 4, lx: g.offsets[2]! + 3, y: 2.5 };
    expect(guardsInCone(g, door, { x: 0.8, y: 0.6 }, 0, 40, [next])).toEqual([]);
  });
});
