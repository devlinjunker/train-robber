// Issue #60: quieter ways onto a train. Jumps from the horse can land on the platform at the train's
// end and on a side ladder up to the roof (perfect zone only); the side ladder is climbable from the
// ledge too; a guard at a ladder's foot cannot reach you past halfway up; riding alongside, the guards
// in a cone through a door show (the pure `guardsInCone` helper).
import { describe, it, expect } from 'vitest';
import {
  boardingCheck, carBoardingTargets, createSim, entryPointWorld, guardsInCone, ROOF_STEP_IN, SIDE_LADDER_OUT, sideLadderInReach, targetZoneWidths, trainGrid, trainOpenings, trainSideLadders,
  type Command, type GameState, type Sim, type SimConfig, type SimEvent,
} from '../src';
import { OUTSIDE, ROOF, testConfig, testMap } from './fixtures';

const base = testConfig();
const SPAWN = { x: 116, y: 22 };
const map = testMap(undefined, SPAWN);

type Targets = SimConfig['values']['boarding']['targets'];
/** Platforms 1 tile deep, roofs on (every car has end ladders), one side ladder, and the targets as given. */
function cfg(targets: Partial<Targets> = {}, roof: Partial<SimConfig['values']['outside']['roof']> = {}): SimConfig {
  const b = base.values.boarding;
  return testConfig({}, 'targets1', {
    boarding: { ...b, targets: { doors: true, platforms: 'train-end', sideLadders: true, ...targets } },
    outside: { ...OUTSIDE, roof: { ...ROOF, ...roof } },
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
const rp = (sim: Sim) => S(sim).run!.players[1]!;
const step = (sim: Sim, ...commands: Command[]) => sim.step([{ player: 1, commands }]).events;

/** Committed, with the horse `gap` tiles out from car `k`'s side at `along` (from mid-car toward the front), matching the train. */
function beside(c: SimConfig, k: number, along: number, side: 'left' | 'right' = 'left', gap = 1): Sim {
  const sim = setup(c);
  step(sim, { type: 'interact', held: true });
  const car = sim.cars()[k]!;
  const at = entryPointWorld(car, { side, along });
  const s = side === 'left' ? 1 : -1;
  Object.assign(horse(sim), { x: at.x + car.uy * gap * s, y: at.y - car.ux * gap * s, hx: car.ux, hy: car.uy, speed: 9, cruiseTarget: 9 });
  step(sim);
  return sim;
}

/** Jump with the marker at `offset` from the zone centre (0 is dead centre: perfect). */
function jumpAt(sim: Sim, offset = 0): SimEvent[] {
  rp(sim).meter.zoneCentre = 0.5;
  rp(sim).meter.phase = 0.25 + offset / 2;
  return step(sim, { type: 'jump' });
}

// The test train is an engine and three 16 x 6 blank cars; platforms are 1 tile deep, so a platform
// landing stands 0.5 out from the end wall.
const LAST = 3;
const REAR_PLATFORM_ALONG = -(8 + 0.5);

function theLadder(c: SimConfig) {
  const sim = setup(c);
  const l = trainSideLadders(c, S(sim).world.trains[0]!.cars)[0]!;
  return { ...l, along: 8 - l.x };
}

describe('boarding targets', () => {
  it('lists doors, the train-end platform and the one side ladder; `all` platforms and the switches', () => {
    const c = cfg();
    const sim = setup(c);
    const cars = sim.cars(), train = S(sim).world.trains[0]!;
    const of = (cc: SimConfig, i: number) => carBoardingTargets(cc, cars[i]!, train.cars).filter((t) => t.kind === 'platform').map((t) => `${t.id}:${t.side}`).sort();
    expect(of(c, 1)).toEqual([]);
    expect(of(c, LAST)).toEqual(['platform-rear:left', 'platform-rear:right']);
    const all = cfg({ platforms: 'all' });
    expect(of(all, 0)).toEqual(['platform-rear:left', 'platform-rear:right']);
    expect(of(all, 1)).toEqual(['platform-front:left', 'platform-front:right', 'platform-rear:left', 'platform-rear:right']);
    // One side ladder per train, on one car and side; perTrain sets how many.
    expect(trainSideLadders(c, train.cars)).toHaveLength(1);
    expect(trainSideLadders(cfg({}, { sideLadder: { ...ROOF.sideLadder, perTrain: 3 } }), train.cars)).toHaveLength(3);
    expect(trainSideLadders(cfg({ sideLadders: false }), train.cars)).toHaveLength(0);
    const doorsOnly = cfg({ platforms: 'none', sideLadders: false });
    expect(cars.flatMap((car) => carBoardingTargets(doorsOnly, car, train.cars)).every((t) => t.kind === 'door')).toBe(true);
    // Shut doors drop only the doors.
    expect(carBoardingTargets(c, cars[LAST]!, train.cars, true).map((t) => t.kind)).not.toContain('door');
  });

  it('a perfect jump at the train-end platform lands on it, out past the end wall', () => {
    const c = cfg();
    const sim = beside(c, LAST, REAR_PLATFORM_ALONG);
    const check = boardingCheck(S(sim), sim.map, c, S(sim).run!.trainId, horse(sim));
    expect([check.target, check.entry, check.car, check.state]).toEqual(['platform', 'platform-rear', LAST, 'eligible']);
    const ev = jumpAt(sim);
    expect(ev.find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'perfect', target: 'platform' });
    expect(S(sim).run!.phase).toBe('aboard');
    expect(me(sim).placement).toMatchObject({ frame: `car:${S(sim).run!.trainId}:${LAST}`, x: 16.5, y: 0.5, layer: 'interior' });
  });

  it('the platform keeps the door meter, a side ladder only takes the perfect zone', () => {
    const c = cfg();
    expect(targetZoneWidths(c, 'platform')).toEqual(c.values.boarding.meter.zoneWidths);
    expect(targetZoneWidths(c, 'ladder')).toEqual([0.1, 0.1]);
    // Inside the good zone but outside the perfect one: a good landing at the platform, a miss at the ladder.
    const good = 0.08;
    const atPlatform = beside(c, LAST, REAR_PLATFORM_ALONG);
    expect(jumpAt(atPlatform, good).find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'good', target: 'platform' });
    const l = theLadder(c);
    const atLadder = beside(c, l.car, l.along, l.side);
    expect(jumpAt(atLadder, good).find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'fail', target: 'ladder' });
    expect(S(atLadder).run!.phase).toBe('boarding');
    const lenient = { ...c, values: { ...c.values, boarding: { ...c.values.boarding, ladderPerfectOnly: false } } } as SimConfig;
    expect(targetZoneWidths(lenient, 'ladder')).toEqual(lenient.values.boarding.meter.zoneWidths);
  });

  it('a jump at the side ladder hangs on it, then climbs straight to the roof', () => {
    const c = cfg();
    const l = theLadder(c);
    const sim = beside(c, l.car, l.along, l.side);
    expect(jumpAt(sim).find((e) => e.type === 'BoardingAttempt')).toMatchObject({ result: 'perfect', target: 'ladder' });
    expect(rp(sim).climb).toMatchObject({ to: 'roof', side: l.side, car: l.car });
    const rows = 6;
    expect(me(sim).placement).toMatchObject({ x: l.x, y: l.side === 'left' ? -SIDE_LADDER_OUT : rows + SIDE_LADDER_OUT });
    let climbed: SimEvent | undefined;
    for (let i = 0; i < c.values.outside.roof.climbTicks + 1 && !climbed; i++) climbed = step(sim).find((e) => e.type === 'Climbed');
    expect(climbed).toMatchObject({ to: 'roof', side: l.side, car: l.car });
    expect(me(sim).placement).toMatchObject({ x: l.x, y: l.side === 'left' ? ROOF_STEP_IN : rows - ROOF_STEP_IN, layer: 'roof' });
  });

  it('E on the ledge beside the side ladder climbs it to the roof', () => {
    const c = cfg();
    const l = theLadder(c);
    // Board at the train-end platform, then stand on the ladder car's ledge next to it.
    const sim = beside(c, LAST, REAR_PLATFORM_ALONG);
    jumpAt(sim);
    const trainId = S(sim).run!.trainId;
    const ledgeY = l.side === 'left' ? -0.25 : 6.25;
    me(sim).placement = { frame: `car:${trainId}:${l.car}`, x: l.x + 0.5, y: ledgeY, layer: 'interior' };
    expect(sideLadderInReach(S(sim), c, me(sim))).toMatchObject({ car: l.car, side: l.side });
    step(sim, { type: 'climb' });
    expect(rp(sim).climb).toMatchObject({ to: 'roof', side: l.side });
    for (let i = 0; i < c.values.outside.roof.climbTicks + 1; i++) step(sim);
    expect(me(sim).placement.layer).toBe('roof');
    // Too far along the ledge: no ladder.
    me(sim).placement = { frame: `car:${trainId}:${l.car}`, x: l.x + 3, y: ledgeY, layer: 'interior' };
    expect(sideLadderInReach(S(sim), c, me(sim))).toBeNull();
  });

  it('with doors only, beside the train-end platform is too far, as before', () => {
    const c = cfg({ platforms: 'none', sideLadders: false });
    const sim = beside(c, LAST, REAR_PLATFORM_ALONG);
    expect(boardingCheck(S(sim), sim.map, c, S(sim).run!.trainId, horse(sim)).state).toBe('too far');
  });

  it('a shut train can still be boarded at the platform, not at a door', () => {
    const c = cfg();
    const atDoor = beside(c, 1, -0.5);
    S(atDoor).world.trains.find((t) => t.id === S(atDoor).run!.trainId)!.doorsClosed = { untilTick: null };
    expect(jumpAt(atDoor).find((e) => e.type === 'CommandRejected')).toMatchObject({ command: 'jump', reason: 'doors closed' });
    const atPlatform = beside(c, LAST, REAR_PLATFORM_ALONG);
    S(atPlatform).world.trains.find((t) => t.id === S(atPlatform).run!.trainId)!.doorsClosed = { untilTick: null };
    jumpAt(atPlatform);
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
